import { describe, expect, it } from "vitest";
import { LOGIN_TRANSACTION_MAX_AGE_MS, sealLoginTransaction, unsealLoginTransaction } from "./login-transaction.js";

const secret = "unit-test-secret-unit-test-secret-0000";
const transaction = { codeVerifier: "verifier", state: "state", nonce: "nonce", createdAt: 1_000_000 };

describe("login transaction cookie", () => {
  it("round-trips and does not reveal the verifier in the cookie value", () => {
    const sealed = sealLoginTransaction(transaction, secret);
    expect(sealed).not.toContain("verifier");
    expect(unsealLoginTransaction(sealed, secret, transaction.createdAt + 1000)).toEqual(transaction);
  });

  it("rejects a different secret, tampering and garbage", () => {
    const sealed = sealLoginTransaction(transaction, secret);
    expect(unsealLoginTransaction(sealed, "another-secret-another-secret-0000", transaction.createdAt)).toBeUndefined();
    const flipped = sealed.slice(0, -1) + (sealed.endsWith("A") ? "B" : "A");
    expect(unsealLoginTransaction(flipped, secret, transaction.createdAt)).toBeUndefined();
    expect(unsealLoginTransaction("not-a-cookie", secret, transaction.createdAt)).toBeUndefined();
  });

  it("expires after the maximum sign-in duration", () => {
    const sealed = sealLoginTransaction(transaction, secret);
    expect(unsealLoginTransaction(sealed, secret, transaction.createdAt + LOGIN_TRANSACTION_MAX_AGE_MS + 1)).toBeUndefined();
  });
});
