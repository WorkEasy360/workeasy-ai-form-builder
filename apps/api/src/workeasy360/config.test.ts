import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

/** The WORKEASY360_* settings are refused when they could not work, or would be unsafe (docs/workeasy360-sso.md). */
const base = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://api:x@127.0.0.1:5432/forms",
  DATABASE_PUBLIC_URL: "postgres://public:x@127.0.0.1:5432/forms",
  CONSOLE_PUBLIC_URL: "http://localhost:3000",
  OBJECT_STORAGE_BUCKET_QUARANTINE: "quarantine",
  OBJECT_STORAGE_BUCKET_CLEAN: "clean",
  OBJECT_STORAGE_BUCKET_EXPORTS: "exports",
  SESSION_SECRET: "a-session-secret-that-is-long-enough-0000",
  SESSION_COOKIE_SECURE: "false",
  INTEGRATION_SECRET_KEY: "bG9jYWwtZGV2LW9ubHktaW50ZWdyYXRpb24ta2V5ISE=",
};
const w360 = {
  WORKEASY360_ISSUER: "http://127.0.0.1:8031",
  WORKEASY360_CLIENT_ID: "forms-client",
  WORKEASY360_KEY_ID: "cred-1",
  WORKEASY360_PRIVATE_KEY_FILE: "./secrets/workeasy360.pem",
};

describe("WorkEasy360 configuration", () => {
  it("is optional, and so is the generic OIDC provider", () => {
    const config = loadConfig(base);
    expect(config.WORKEASY360_ISSUER).toBeUndefined();
    expect(config.OIDC_ISSUER_URL).toBeUndefined();
    expect(config.WORKEASY360_SSO_ONLY).toBe(false);
  });

  it("accepts a loopback http issuer outside production, with the defaults of the integration kit", () => {
    const config = loadConfig({ ...base, ...w360 });
    expect(config).toMatchObject({ WORKEASY360_PRODUCT_CODE: "workeasy_forms", WORKEASY360_SCOPES: "openid email profile organization", WORKEASY360_DEFAULT_ROLE: "creator" });
  });

  it.each([
    [{ WORKEASY360_ISSUER: "http://127.0.0.1:8031/" }, /must not end with a slash/],
    [{ WORKEASY360_ISSUER: "http://accounts.example.test" }, /must use https/],
    [{ WORKEASY360_KEY_ID: "" }, /together, or none of them/],
    [{ WORKEASY360_SCOPES: "openid profile" }, /must include openid and email/],
    [{ WORKEASY360_REDIRECT_URI: "http://localhost:3000/auth/callback" }, /must be http:\/\/localhost:3000\/auth\/workeasy360\/callback/],
    [{ WORKEASY360_POST_LOGOUT_REDIRECT_URI: "https://elsewhere.example/" }, /must be on the console origin/],
    [{ OIDC_ISSUER_URL: "http://127.0.0.1:8031", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y" }, /must not be the WorkEasy360 issuer/],
  ])("refuses %o", (override, message) => {
    expect(() => loadConfig({ ...base, ...w360, ...override })).toThrow(message);
  });

  it("refuses SSO-only without WorkEasy360, and plain http in production", () => {
    expect(() => loadConfig({ ...base, WORKEASY360_SSO_ONLY: "true" })).toThrow(/needs WorkEasy360 sign-in/);
    expect(() =>
      loadConfig({
        ...base,
        ...w360,
        NODE_ENV: "production",
        SESSION_COOKIE_SECURE: "true",
        CONSOLE_PUBLIC_URL: "https://forms.example.test",
        RESPONDENT_PUBLIC_URL: "https://f.example.test",
      }),
    ).toThrow(/must use https \(plain http only for a loopback provider outside production\)[\s\S]*at WORKEASY360_ISSUER/);
  });

  it("refuses half a generic OIDC configuration", () => {
    expect(() => loadConfig({ ...base, OIDC_ISSUER_URL: "http://localhost:5556/dex" })).toThrow(/together, or none of them/);
  });
});
