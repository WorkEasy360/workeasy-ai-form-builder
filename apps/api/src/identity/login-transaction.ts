import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { LoginTransaction } from "@workeasy/auth";

/** How long a sign-in may take between the redirect to the IdP and the callback. */
export const LOGIN_TRANSACTION_MAX_AGE_MS = 10 * 60 * 1000;

function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(`workeasy-login-transaction:${secret}`).digest();
}

/** A login transaction plus where to send the user afterwards (a path already checked by the caller). */
export type SealedLogin = LoginTransaction & { returnTo?: string };

/** Encrypts and authenticates the login transaction for an HttpOnly cookie (AES-256-GCM). */
export function sealLoginTransaction(transaction: SealedLogin, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(transaction), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Returns the transaction if the cookie is authentic, well formed and not expired. */
export function unsealLoginTransaction(
  sealed: string,
  secret: string,
  now: number = Date.now(),
): SealedLogin | undefined {
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 12 + 16 + 1) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const value = JSON.parse(json) as Partial<SealedLogin>;
    if (
      typeof value.codeVerifier !== "string" ||
      typeof value.state !== "string" ||
      typeof value.nonce !== "string" ||
      typeof value.createdAt !== "number"
    ) {
      return undefined;
    }
    if (now - value.createdAt > LOGIN_TRANSACTION_MAX_AGE_MS || value.createdAt > now + 60_000) return undefined;
    return {
      codeVerifier: value.codeVerifier,
      state: value.state,
      nonce: value.nonce,
      createdAt: value.createdAt,
      ...(typeof value.returnTo === "string" ? { returnTo: value.returnTo } : {}),
    };
  } catch {
    return undefined;
  }
}
