import { createDb, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { LOCAL_DEX_LOGINS, LOCAL_DEX_PASSWORD, LOCAL_SEED_TENANTS } from "@workeasy/test-fixtures";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { MeResponseSchema } from "./contract/schemas.js";
import { createOidcIdentityProvider } from "./identity/oidc-provider.js";
import { buildTestApp, cookieFrom, testSettings } from "./test-support.js";

/**
 * Drives the real local Dex provider end to end: authorization request with
 * PKCE, Dex's password login, code exchange and ID-token validation.
 * Requires `pnpm infra:up`.
 */
const urls = inject("testDatabase");
const oidc = inject("testOidc");

let db: Db;
let app: Express;

const acme = LOCAL_SEED_TENANTS[0]!;
const ashaId = acme.members.find((m) => m.role === "owner")!.user.id;

interface DexRedirect {
  callbackUrl: URL;
  loginCookie: string;
}

/** Follows the browser's path through Dex until it redirects back to the console callback. */
async function signInAtDex(email: string, password = LOCAL_DEX_PASSWORD): Promise<DexRedirect> {
  const start = await request(app).get("/auth/login");
  expect(start.status).toBe(302);
  const loginCookie = cookieFrom(start.headers["set-cookie"], "we_login");
  expect(loginCookie).toBeDefined();

  let url = new URL(start.headers.location as string);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  let res = await fetch(url, { redirect: "manual" });
  for (let step = 0; step < 10; step++) {
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get("location")!, url);
      if (next.origin === oidc!.consoleOrigin) return { callbackUrl: next, loginCookie: loginCookie! };
      url = next;
      res = await fetch(url, { redirect: "manual" });
    } else if (res.status === 200) {
      const html = await res.text();
      const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1];
      if (!action) throw new Error(`No login form on ${url.pathname}`);
      url = new URL(action.replaceAll("&amp;", "&"), url);
      res = await fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ login: email, password }),
      });
    } else {
      throw new Error(`Unexpected ${res.status} from ${url.toString()}`);
    }
  }
  throw new Error("Dex did not redirect back to the console");
}

function callback(redirect: DexRedirect, loginCookie: string | null = redirect.loginCookie) {
  const req = request(app).get(redirect.callbackUrl.pathname + redirect.callbackUrl.search);
  return loginCookie === null ? req : req.set("Cookie", loginCookie);
}

beforeAll(async () => {
  if (!oidc) throw new Error("OIDC_* and CONSOLE_PUBLIC_URL must be set in .env for the sign-in tests.");
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  for (const tenant of LOCAL_SEED_TENANTS) await seedTenantFixture(db, tenant);
  const settings = { ...testSettings, consoleOrigin: oidc.consoleOrigin };
  app = buildTestApp(
    db,
    createOidcIdentityProvider({
      issuerUrl: oidc.issuerUrl,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      redirectUri: new URL("/auth/callback", oidc.consoleOrigin).toString(),
      allowInsecureRequests: true,
    }),
    settings,
  );
});

afterAll(async () => {
  await db?.destroy();
});

describe("sign-in through the local OIDC provider", () => {
  it("signs a seeded member in and maps the Dex subject to the seeded user", async () => {
    const done = await callback(await signInAtDex(LOCAL_DEX_LOGINS.ashaAcmeOwner));
    expect(done.status).toBe(303);
    expect(done.headers.location).toBe(`${oidc!.consoleOrigin}/`);
    const setCookies = ([] as string[]).concat(done.headers["set-cookie"] ?? []);
    const session = setCookies.find((c) => c.startsWith("we_session="));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);
    // The single-use login transaction cookie is cleared.
    expect(setCookies.find((c) => c.startsWith("we_login="))).toMatch(/Max-Age=0/);

    const me = MeResponseSchema.parse(
      (await request(app).get("/api/v1/me").set("Cookie", cookieFrom(setCookies, "we_session")!)).body,
    );
    expect(me.user.id).toBe(ashaId);
    expect(me.user.displayName).toBe("Asha Owner");
    expect(me.organizations).toEqual([expect.objectContaining({ id: acme.id, role: "owner" })]);
  });

  it("creates an identity with no organizations for a user without memberships", async () => {
    const done = await callback(await signInAtDex(LOCAL_DEX_LOGINS.ninaNoOrganization));
    expect(done.status).toBe(303);
    const cookie = cookieFrom(done.headers["set-cookie"], "we_session")!;
    const me = MeResponseSchema.parse((await request(app).get("/api/v1/me").set("Cookie", cookie)).body);
    expect(me.user.displayName).toBe("Nina No-Org");
    expect(me.organizations).toEqual([]);
  });

  it("revokes the session on sign-out", async () => {
    const done = await callback(await signInAtDex(LOCAL_DEX_LOGINS.carlosAcmeCreator));
    const cookie = cookieFrom(done.headers["set-cookie"], "we_session")!;
    expect((await request(app).get("/api/v1/me").set("Cookie", cookie)).status).toBe(200);

    const crossSite = await request(app).post("/auth/logout").set("Cookie", cookie).set("Origin", "https://evil.example");
    expect(crossSite.status).toBe(403);
    expect((await request(app).get("/api/v1/me").set("Cookie", cookie)).status).toBe(200);

    const out = await request(app).post("/auth/logout").set("Cookie", cookie).set("Origin", oidc!.consoleOrigin);
    expect(out.status).toBe(303);
    expect(cookieFrom(out.headers["set-cookie"], "we_session")).toBe("we_session=");
    expect((await request(app).get("/api/v1/me").set("Cookie", cookie)).status).toBe(401);
  });
});

describe("rejected sign-in callbacks", () => {
  const failed = () => `${oidc!.consoleOrigin}/?signin=failed`;

  function expectFailedWithoutSession(res: request.Response) {
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(failed());
    expect(cookieFrom(res.headers["set-cookie"], "we_session")).toBeUndefined();
  }

  it("rejects a callback without the login transaction cookie", async () => {
    expectFailedWithoutSession(await callback(await signInAtDex(LOCAL_DEX_LOGINS.graceGlobexOwner), null));
  });

  it("rejects a tampered login transaction cookie", async () => {
    const redirect = await signInAtDex(LOCAL_DEX_LOGINS.graceGlobexOwner);
    const [name, value] = redirect.loginCookie.split("=");
    const tampered = `${name}=${value!.slice(0, -2)}${value!.endsWith("AA") ? "BB" : "AA"}`;
    expectFailedWithoutSession(await callback(redirect, tampered));
  });

  it("rejects a callback whose state does not match the transaction", async () => {
    const redirect = await signInAtDex(LOCAL_DEX_LOGINS.graceGlobexOwner);
    redirect.callbackUrl.searchParams.set("state", "forged-state");
    expectFailedWithoutSession(await callback(redirect));
  });

  it("rejects a replayed authorization code", async () => {
    const redirect = await signInAtDex(LOCAL_DEX_LOGINS.anaGlobexAnalyst);
    expect((await callback(redirect)).headers.location).toBe(`${oidc!.consoleOrigin}/`);
    expectFailedWithoutSession(await callback(redirect));
  });

  it("never redirects back to the console for a wrong password", async () => {
    // Dex answers a failed password login with 401 and stays on its own page.
    await expect(signInAtDex(LOCAL_DEX_LOGINS.ashaAcmeOwner, "wrong-password")).rejects.toThrow(/Unexpected 401/);
  });

  it("forwards an error from the provider as a failed sign-in", async () => {
    const start = await request(app).get("/auth/login");
    const loginCookie = cookieFrom(start.headers["set-cookie"], "we_login")!;
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const res = await request(app).get(`/auth/callback?error=access_denied&state=${state}`).set("Cookie", loginCookie);
    expectFailedWithoutSession(res);
  });
});
