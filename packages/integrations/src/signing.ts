import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures (docs/05 §6). Each request carries
 *   Workeasy-Event-Id: <event ID, stable across retries>
 *   Workeasy-Timestamp: <unix seconds>
 *   Workeasy-Signature: v1=<hex>[,v1=<hex>]
 * where each signature is HMAC-SHA256 over "<timestamp>.<exact body bytes>"
 * with the current secret (and, during a rotation, the previous one).
 * Receivers should reject timestamps more than five minutes from their clock
 * and deduplicate on the event ID.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

function sign(secret: string, timestamp: number, body: Buffer): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

export function signatureHeader(secrets: readonly string[], timestamp: number, body: Buffer): string {
  return secrets.map((s) => `v1=${sign(s, timestamp, body)}`).join(",");
}

/** For receivers and tests: true if any v1 signature matches and the timestamp is fresh. */
export function verifyWebhookSignature(input: {
  secret: string;
  signatureHeader: string;
  timestamp: string;
  body: Buffer;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const ts = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > (input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const expected = Buffer.from(sign(input.secret, ts, input.body), "hex");
  return input.signatureHeader
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const given = Buffer.from(part.slice(3), "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
