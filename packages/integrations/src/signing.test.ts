import { describe, expect, it } from "vitest";
import { deliveryRetryDelayMs } from "./delivery.js";
import { headerSafe } from "./email.js";
import { decryptSecret, encryptSecret, newWebhookSecret, parseSecretKey } from "./secrets.js";
import { signatureHeader, verifyWebhookSignature } from "./signing.js";

const body = Buffer.from('{"eventId":"e1","answers":{"f_name":"Ada"}}');

describe("webhook signatures", () => {
  it("verify against the exact bytes, within five minutes", () => {
    const secret = newWebhookSecret();
    const header = signatureHeader([secret], 1_800_000_000, body);
    expect(header).toMatch(/^v1=[0-9a-f]{64}$/);
    const verify = (over: Partial<Parameters<typeof verifyWebhookSignature>[0]>) =>
      verifyWebhookSignature({ secret, signatureHeader: header, timestamp: "1800000000", body, nowSeconds: 1_800_000_100, ...over });
    expect(verify({})).toBe(true);
    expect(verify({ body: Buffer.from(body.toString().replace("Ada", "Eve")) })).toBe(false);
    expect(verify({ secret: newWebhookSecret() })).toBe(false);
    expect(verify({ nowSeconds: 1_800_000_301 })).toBe(false);
    expect(verify({ timestamp: "1800000001" })).toBe(false);
  });

  it("carry both signatures during a rotation, so either secret verifies", () => {
    const [current, previous] = [newWebhookSecret(), newWebhookSecret()];
    const header = signatureHeader([current, previous], 1_800_000_000, body);
    expect(header.split(",")).toHaveLength(2);
    for (const secret of [current, previous]) {
      expect(verifyWebhookSignature({ secret, signatureHeader: header, timestamp: "1800000000", body, nowSeconds: 1_800_000_000 })).toBe(true);
    }
  });
});

describe("secrets at rest", () => {
  const key = parseSecretKey(Buffer.alloc(32, 7).toString("base64"));

  it("round-trip, differ each time, and refuse tampering or the wrong key", () => {
    const secret = newWebhookSecret();
    const a = encryptSecret(secret, key);
    expect(a).not.toContain(secret);
    expect(encryptSecret(secret, key)).not.toBe(a);
    expect(decryptSecret(a, key)).toBe(secret);
    const parts = a.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow(/authenticate/);
    expect(() => decryptSecret(a, parseSecretKey(Buffer.alloc(32, 8).toString("base64")))).toThrow(/authenticate/);
    expect(() => parseSecretKey("c2hvcnQ=")).toThrow(/32 bytes/);
  });
});

describe("delivery retry schedule", () => {
  it("is about 1m, 5m, 30m, 2h, 8h and 24h, within 20%", () => {
    const expected = [60, 300, 1800, 7200, 28_800, 86_400].map((s) => s * 1000);
    expected.forEach((ms, i) => {
      expect(deliveryRetryDelayMs(i + 1, () => 0.5)).toBe(ms);
      expect(deliveryRetryDelayMs(i + 1, () => 0)).toBe(ms * 0.8);
      expect(deliveryRetryDelayMs(i + 1, () => 0.999999)).toBeLessThanOrEqual(ms * 1.2);
    });
  });
});

describe("headerSafe", () => {
  it("removes line breaks, so a form name cannot add mail headers", () => {
    expect(headerSafe("Survey\r\nBcc: victim@example.com")).toBe("Survey Bcc: victim@example.com");
  });
});
