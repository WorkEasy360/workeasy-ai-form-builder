import { connect } from "node:net";
import type { Readable } from "node:stream";

/**
 * A clamd client using INSTREAM (docs/06 §3). Bytes are streamed to the
 * scanner and never written to local disk. Any failure to get a clear answer
 * throws, so callers keep the file pending instead of treating it as clean.
 */
export interface ScannerConfig {
  host: string;
  port: number;
  /** Whole-scan timeout. */
  timeoutMs?: number;
}

export type ScanResult = { status: "clean" } | { status: "infected"; signature: string };

export class ScannerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ScannerUnavailableError";
  }
}

/** clamd's StreamMaxLength defaults to 25 MiB; uploads are capped at 10 MiB. */
const CHUNK_BYTES = 64 * 1024;

export function parseClamdReply(reply: string): ScanResult {
  const text = reply.replace(/\0/g, "").trim();
  if (/^stream: OK$/.test(text)) return { status: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { status: "infected", signature: found[1]! };
  throw new ScannerUnavailableError(`Unexpected scanner reply: ${text.slice(0, 200)}`);
}

export function scanStream(config: ScannerConfig, body: Readable): Promise<ScanResult> {
  return new Promise<ScanResult>((resolve, reject) => {
    const socket = connect({ host: config.host, port: config.port });
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      body.destroy();
      reject(err instanceof ScannerUnavailableError ? err : new ScannerUnavailableError("The malware scanner is unavailable", { cause: err }));
    };
    socket.setTimeout(config.timeoutMs ?? 60_000, () => fail(new ScannerUnavailableError("The malware scanner timed out")));
    socket.on("error", fail);
    socket.on("data", (data: Buffer) => chunks.push(data));
    socket.on("end", () => {
      if (settled) return;
      try {
        const result = parseClamdReply(Buffer.concat(chunks).toString("utf8"));
        settled = true;
        resolve(result);
      } catch (err) {
        fail(err);
      }
    });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      body.on("error", fail);
      body.on("data", (data: Buffer) => {
        for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
          const part = data.subarray(offset, offset + CHUNK_BYTES);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.length);
          if (!socket.write(Buffer.concat([size, part]))) body.pause();
        }
      });
      socket.on("drain", () => body.resume());
      // A zero-length chunk ends the stream.
      body.on("end", () => socket.write(Buffer.alloc(4)));
    });
  });
}

/** True when clamd answers PING; for readiness checks. */
export function pingScanner(config: ScannerConfig): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: config.host, port: config.port });
    let reply = "";
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
    socket.on("connect", () => socket.write("zPING\0"));
    socket.on("data", (data: Buffer) => (reply += data.toString("utf8")));
    socket.on("end", () => resolve(reply.replace(/\0/g, "").trim() === "PONG"));
  });
}
