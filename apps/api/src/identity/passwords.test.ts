import { describe, expect, it } from "vitest";
import { createAttemptLimiter, hashPassword, verifyPassword } from "./passwords.js";

describe("passwords", () => {
  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
    expect(await verifyPassword("correct horse battery", "not-a-hash")).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password")).not.toBe(await hashPassword("same password"));
  });

  it("limits failures per key within the window", () => {
    let t = 0;
    const limiter = createAttemptLimiter(3, 1000, () => t);
    for (let i = 0; i < 3; i++) limiter.fail("a@x.test");
    expect(limiter.blocked("a@x.test")).toBe(true);
    expect(limiter.blocked("b@x.test")).toBe(false);
    t = 1001;
    expect(limiter.blocked("a@x.test")).toBe(false);
    limiter.fail("a@x.test");
    limiter.reset("a@x.test");
    expect(limiter.blocked("a@x.test")).toBe(false);
  });
});
