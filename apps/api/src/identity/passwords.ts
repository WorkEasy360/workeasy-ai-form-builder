import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing for email and password accounts: scrypt with a random
 * 16-byte salt, stored as `scrypt$N$r$p$salt$hash` (base64url) so the cost
 * can be raised later without breaking existing hashes.
 */
const COST = { N: 32768, r: 8, p: 1 };
const KEY_LENGTH = 32;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

function derive(password: string, salt: Buffer, cost: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...cost, maxmem: 256 * cost.N * cost.r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (![cost.N, cost.r, cost.p].every((v) => Number.isInteger(v) && v > 0) || cost.N > 1 << 20) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), cost);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A real hash of nothing in particular: checked against when the email is unknown, so timing does not reveal accounts. */
let dummyHash: Promise<string> | undefined;
export function unknownAccountHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return dummyHash;
}

/**
 * Failed sign-ins per key (an email), in this process: after `limit`
 * failures within `windowMs` further attempts are refused until the window
 * passes. One API process serves the console, so memory is enough.
 */
export function createAttemptLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const failures = new Map<string, number[]>();
  const recent = (key: string) => (failures.get(key) ?? []).filter((t) => now() - t < windowMs);
  return {
    blocked(key: string): boolean {
      return recent(key).length >= limit;
    },
    fail(key: string): void {
      const times = recent(key);
      times.push(now());
      failures.set(key, times);
      // Keep memory bounded under a spray of distinct keys.
      if (failures.size > 50_000) failures.delete(failures.keys().next().value!);
    },
    reset(key: string): void {
      failures.delete(key);
    },
  };
}
