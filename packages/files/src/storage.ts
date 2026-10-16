import type { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Private S3-compatible storage for uploads (docs/06 §3). Two buckets with
 * separate access: respondents write only to quarantine, through short-lived
 * presigned PUTs; files reach the clean bucket only after scanning, and leave
 * it only through short-lived presigned GETs for authorized readers.
 */
export interface ObjectStoreConfig {
  /** Where the servers reach storage. */
  endpoint: string;
  /** Where browsers reach storage; presigned URLs are signed for this host. */
  publicEndpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  quarantineBucket: string;
  cleanBucket: string;
}

export interface ObjectInfo {
  bytes: number;
  contentType: string | undefined;
}

export interface ObjectStore {
  readonly quarantineBucket: string;
  readonly cleanBucket: string;
  /** A URL the browser can PUT exactly this object to, with this type and size, until it expires. */
  presignUpload(key: string, contentType: string, bytes: number, expiresInSeconds: number): Promise<string>;
  /** A URL that downloads a clean object as an attachment with a safe name, until it expires. */
  presignDownload(key: string, fileName: string, contentType: string, expiresInSeconds: number): Promise<string>;
  head(bucket: string, key: string): Promise<ObjectInfo | undefined>;
  read(bucket: string, key: string): Promise<Readable>;
  /** Moves a scanned object from quarantine to the clean bucket. */
  promote(key: string): Promise<void>;
  remove(bucket: string, key: string): Promise<void>;
}

function client(config: ObjectStoreConfig, endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

const isNotFound = (err: unknown) =>
  err instanceof S3ServiceException && (err.$metadata.httpStatusCode === 404 || err.name === "NotFound" || err.name === "NoSuchKey");

/** RFC 6266 attachment header with an ASCII fallback and the UTF-8 name. */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createObjectStore(config: ObjectStoreConfig): ObjectStore {
  const internal = client(config, config.endpoint);
  const browser = client(config, config.publicEndpoint);
  return {
    quarantineBucket: config.quarantineBucket,
    cleanBucket: config.cleanBucket,

    presignUpload(key, contentType, bytes, expiresInSeconds) {
      // Type and length are signed, so the browser cannot store anything else under this key.
      return getSignedUrl(browser, new PutObjectCommand({ Bucket: config.quarantineBucket, Key: key, ContentType: contentType, ContentLength: bytes }), {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(["content-type", "content-length"]),
      });
    },

    presignDownload(key, fileName, contentType, expiresInSeconds) {
      return getSignedUrl(
        browser,
        new GetObjectCommand({
          Bucket: config.cleanBucket,
          Key: key,
          ResponseContentDisposition: attachmentDisposition(fileName),
          ResponseContentType: contentType,
        }),
        { expiresIn: expiresInSeconds },
      );
    },

    async head(bucket, key) {
      try {
        const res = await internal.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { bytes: res.ContentLength ?? 0, contentType: res.ContentType };
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    },

    async read(bucket, key) {
      const res = await internal.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return res.Body as Readable;
    },

    async promote(key) {
      await internal.send(new CopyObjectCommand({ Bucket: config.cleanBucket, Key: key, CopySource: `${config.quarantineBucket}/${encodeURIComponent(key)}` }));
      await internal.send(new DeleteObjectCommand({ Bucket: config.quarantineBucket, Key: key }));
    },

    async remove(bucket, key) {
      await internal.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
