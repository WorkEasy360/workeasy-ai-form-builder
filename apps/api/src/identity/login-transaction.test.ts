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
    // Flip a real byte (changing the last base64url character can alter only padding bits).
    for (const index of [0, 13, 30, -1]) {
      const bytes = Buffer.from(sealed, "base64url");
      const at = index < 0 ? bytes.length + index : index;
      bytes[at] = bytes[at]! ^ 0x01;
      expect(unsealLoginTransaction(bytes.toString("base64url"), secret, transaction.createdAt)).toBeUndefined();
    }
    expect(unsealLoginTransaction("not-a-cookie", secret, transaction.createdAt)).toBeUndefined();
  });

  it("expires after the maximum sign-in duration", () => {
    const sealed = sealLoginTransaction(transaction, secret);
    expect(unsealLoginTransaction(sealed, secret, transaction.createdAt + LOGIN_TRANSACTION_MAX_AGE_MS + 1)).toBeUndefined();
  });
});
