import { randomUUID } from "node:crypto";
import { createDb, identityRepo, workeasy360Repo, type Db } from "@workeasy/database";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { MeResponseSchema, ProblemSchema } from "./contract/schemas.js";
import { buildTestApp, cookieFrom, TEST_CONSOLE_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";
import { FakeWorkeasy360, type ClientKeys } from "./workeasy360/fake-provider.js";
import type { AnswerStore } from "./workeasy360/entitlements.js";
import { createWorkeasy360Runtime, type Workeasy360Runtime } from "./workeasy360/runtime.js";

/**
 * WorkEasy360 Accounts sign-in against a fake provider built here (keys are
 * generated when it starts): the contract's checks, tenancy, entitlement,
 * back-channel logout across two API instances, sign-out and the migration
 * safety rules. Needs `pnpm infra:up` for PostgreSQL.
 */
const urls = inject("testDatabase");

const CLIENT_ID = "forms-client-test";
const REDIRECT_URI = `${TEST_CONSOLE_ORIGIN}/auth/workeasy360/callback`;
const POST_LOGOUT_URI = `${TEST_CONSOLE_ORIGIN}/?signed_out=1`;

let db: Db;
let ownerDb: Db;
let publicDb: Db;
let fake: FakeWorkeasy360;
let keys: ClientKeys;
/** Two API instances sharing one database, as in production behind a load balancer. */
let app: Express;
let other: Express;
let runtime: Workeasy360Runtime;

function makeRuntime(overrides: { ssoOnly?: boolean; provisionTenants?: boolean; now?: () => number; store?: AnswerStore; issuer?: string } = {}) {
  return createWorkeasy360Runtime(
    db,
    {
      issuer: overrides.issuer ?? fake.issuer,
      clientId: CLIENT_ID,
      productCode: "workeasy_forms",
      redirectUri: REDIRECT_URI,
      keyId: keys.keyId,
      privateKeyPem: keys.privateKeyPem,
      scopes: ["openid", "email", "profile", "organization"],
      allowInsecureRequests: true,
    },
    {
      postLogoutRedirectUri: POST_LOGOUT_URI,
      ssoOnly: overrides.ssoOnly ?? false,
      defaultRole: "creator",
      provisionTenants: overrides.provisionTenants ?? true,
      purchaseUrl: `${fake.issuer}/products/workeasy_forms`,
    },
    { store: overrides.store, cacheNow: overrides.now },
  );
}

function makeApp(w360: Workeasy360Runtime): Express {
  return buildTestApp(db, unusedIdentityProvider, testSettings, publicDb, unusedIdentityProvider, undefined, undefined, w360);
}

interface SignedIn {
  res: request.Response;
  /** `we_session=<token>`, or undefined when the sign-in failed. */
  cookie: string | undefined;
  location: string;
}

/** Drives the browser: start, the provider's authorization endpoint, the callback. */
async function signIn(target: Express = app, options: { organization?: string; cookie?: string; replay?: boolean } = {}): Promise<SignedIn> {
  const start = await request(target).get(`/auth/workeasy360/start${options.organization ? `?organization=${options.organization}` : ""}`);
  expect(start.status).toBe(302);
  const flowCookie = cookieFrom(start.headers["set-cookie"], "we_w360_flow")!;
  expect(flowCookie).toBeDefined();
  const authorize = await fetch(start.headers.location as string, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const back = new URL(authorize.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(REDIRECT_URI);
  const call = () => request(target).get(back.pathname + back.search).set("Cookie", [flowCookie, ...(options.cookie ? [options.cookie] : [])].join("; "));
  let res = await call();
  if (options.replay) res = await call();
  return { res, cookie: cookieFrom(res.headers["set-cookie"], "we_session"), location: String(res.headers.location ?? "") };
}

function ssoError(signedIn: SignedIn): string | null {
  return new URL(signedIn.location, TEST_CONSOLE_ORIGIN).searchParams.get("sso_error");
}

const me = (target: Express, cookie: string) => request(target).get("/api/v1/me").set("Cookie", cookie);
const forms = (target: Express, cookie: string, tenantId: string) => request(target).get(`/api/v1/organizations/${tenantId}/forms`).set("Cookie", cookie);
const backchannel = (target: Express, token: string) =>
  request(target).post("/auth/workeasy360/backchannel-logout").type("form").send({ logout_token: token });

function newPerson(overrides: Partial<FakeWorkeasy360["person"]> = {}) {
  fake.person = {
    sub: randomUUID(),
    email: `person.${randomUUID().slice(0, 8)}@example.test`,
    emailVerified: true,
    name: "Asha Person",
    organizationId: randomUUID(),
    organizationName: "Asha's organization",
    sid: randomUUID(),
    ...overrides,
  };
  return fake.person;
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 6 });
  ownerDb = createDb({ connectionString: urls.owner, maxConnections: 2 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 2 });
  fake = await FakeWorkeasy360.start();
  keys = await fake.registerClient(CLIENT_ID, [REDIRECT_URI]);
  runtime = makeRuntime();
  app = makeApp(runtime);
  other = makeApp(makeRuntime());
});

afterAll(async () => {
  await fake?.stop();
  await Promise.all([db?.destroy(), ownerDb?.destroy(), publicDb?.destroy()]);
});

beforeEach(() => {
  newPerson();
  fake.tampering = {};
  fake.entitlement = (organizationId) => ({
    status: 200,
    body: { decision: "allow", reason: "entitled", product_code: "workeasy_forms", organization_id: organizationId, write_allowed: true, revalidate_after: 900 },
  });
});

describe("WorkEasy360 sign-in: the happy path", () => {
  it("signs in with PKCE S256 and private_key_jwt, creates the organization's tenant and binds the session to it", async () => {
    const person = fake.person;
    const done = await signIn(app, { organization: person.organizationId! });
    expect(done.res.status).toBe(303);
    expect(done.cookie).toBeDefined();
    const setCookies = ([] as string[]).concat(done.res.headers["set-cookie"] ?? []);
    expect(setCookies.find((c) => c.startsWith("we_session="))).toMatch(/HttpOnly/);
    // The flow cookie is single use and cleared on the callback.
    expect(setCookies.find((c) => c.startsWith("we_w360_flow="))).toMatch(/Max-Age=0/);

    // The authorization request: PKCE S256, state, nonce, the launcher's organization, the scopes.
    const authorize = fake.seen.authorize.at(-1)!;
    expect(authorize.get("code_challenge_method")).toBe("S256");
    expect(authorize.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.get("state")).toBeTruthy();
    expect(authorize.get("nonce")).toBeTruthy();
    expect(authorize.get("organization")).toBe(person.organizationId);
    expect(authorize.get("scope")).toBe("openid email profile organization");

    // The code exchange authenticated with private_key_jwt: iss = sub = client id, aud = the token endpoint, 60 s.
    const exchange = fake.seen.token.at(-1)!;
    expect(exchange.form.get("client_secret")).toBeNull();
    expect(exchange.assertion).toMatchObject({ iss: CLIENT_ID, sub: CLIENT_ID, aud: fake.tokenEndpoint });
    expect(exchange.assertion.exp! - exchange.assertion.iat!).toBe(60);
    expect(exchange.form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    // The entitlement was asked at arrival, for the organization and the person, with a client assertion.
    const entitlement = fake.seen.entitlement.at(-1)!;
    expect(entitlement.form.get("organization_id")).toBe(person.organizationId);
    expect(entitlement.form.get("subject")).toBe(person.sub);
    expect(entitlement.form.get("product_code")).toBeNull();
    expect(entitlement.assertion).toMatchObject({ iss: CLIENT_ID, aud: fake.tokenEndpoint });

    const tenant = await workeasy360Repo.findTenantByOrganization(db, person.organizationId!);
    expect(tenant).toMatchObject({ status: "active" });
    expect(done.location).toBe(`${TEST_CONSOLE_ORIGIN}/o/${tenant!.tenantId}/forms`);

    const profile = MeResponseSchema.parse((await me(app, done.cookie!)).body);
    expect(profile.user.displayName).toBe("Asha Person");
    expect(profile.organizations).toEqual([expect.objectContaining({ id: tenant!.tenantId, name: "Asha's organization", role: "owner" })]);
    expect(profile.session).toEqual({ provider: "workeasy360", workeasy360SignOut: true });
    expect((await forms(app, done.cookie!, tenant!.tenantId)).status).toBe(200);
    const access = await request(app).get(`/api/v1/organizations/${tenant!.tenantId}/access`).set("Cookie", done.cookie!);
    expect(access.body).toEqual({ ok: true, role: "owner" });
  });

  it("puts the next person of the same organization in the same tenant with the default role, keyed on (issuer, sub)", async () => {
    const first = await signIn();
    const organizationId = fake.person.organizationId!;
    const tenant = (await workeasy360Repo.findTenantByOrganization(db, organizationId))!;
    // Same email, another WorkEasy360 person: never linked by email.
    newPerson({ organizationId, email: fake.person.email });
    const second = await signIn();
    expect(second.res.status).toBe(303);
    const profile = MeResponseSchema.parse((await me(app, second.cookie!)).body);
    expect(profile.organizations).toEqual([expect.objectContaining({ id: tenant.tenantId, role: "creator" })]);
    expect(profile.user.id).not.toBe(MeResponseSchema.parse((await me(app, first.cookie!)).body).user.id);
  });

  it("signs the same person in again as the same user", async () => {
    const first = await signIn();
    const second = await signIn();
    expect(MeResponseSchema.parse((await me(app, second.cookie!)).body).user.id).toBe(MeResponseSchema.parse((await me(app, first.cookie!)).body).user.id);
  });

  it("ends the session the browser already held when someone signs in over it", async () => {
    const first = await signIn();
    newPerson();
    const second = await signIn(app, { cookie: first.cookie! });
    expect(second.res.status).toBe(303);
    expect((await me(app, first.cookie!)).status).toBe(401);
    expect((await me(app, second.cookie!)).status).toBe(200);
  });

  it("reports WorkEasy360 as a sign-in method", async () => {
    const res = await request(app).get("/auth/methods");
    expect(res.body).toMatchObject({ password: true, workeasy360: true, workeasy360PurchaseUrl: `${fake.issuer}/products/workeasy_forms` });
  });
});

describe("WorkEasy360 sign-in: what is refused", () => {
  it("refuses an ID token from another issuer", async () => {
    fake.tampering = { issuer: "https://accounts.example.test" };
    const done = await signIn();
    expect(ssoError(done)).toBe("invalid_token");
    expect(done.cookie).toBeUndefined();
  });

  it("refuses an ID token for another audience", async () => {
    fake.tampering = { audience: "some-other-product" };
    const done = await signIn();
    expect(ssoError(done)).toBe("invalid_token");
    expect(done.cookie).toBeUndefined();
  });

  it("refuses an ID token whose signature does not verify against the key set", async () => {
    fake.tampering = { foreignKey: true };
    const done = await signIn();
    expect(ssoError(done)).toBe("invalid_token");
    expect(done.cookie).toBeUndefined();
  });

  it("refuses an ID token with another nonce", async () => {
    fake.tampering = { nonce: "a-nonce-from-another-browser-0000" };
    const done = await signIn();
    expect(ssoError(done)).toBe("invalid_token");
    expect(done.cookie).toBeUndefined();
  });

  it("verifies the ID token's signature against the provider's key set itself, whatever the exchange checked", async () => {
    const nonce = "n0nce-n0nce-n0nce-n0nce-n0nce-n0nce-n0nce";
    const claims = {
      sub: randomUUID(),
      nonce,
      typ: "id_token",
      product_code: "workeasy_forms",
      organization_id: randomUUID(),
      email: "direct@example.test",
      email_verified: true,
    };
    await expect(runtime.client.verifyIdToken(await fake.signIdToken(CLIENT_ID, claims), nonce)).resolves.toMatchObject({ subject: claims.sub });
    await expect(runtime.client.verifyIdToken(await fake.signIdToken(CLIENT_ID, claims, { foreignKey: true }), nonce)).rejects.toMatchObject({ code: "invalid_token" });
    // alg "none": an unsigned token is never an identity assertion.
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...claims, iss: fake.issuer, aud: CLIENT_ID, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url"),
      "",
    ].join(".");
    await expect(runtime.client.verifyIdToken(unsigned, nonce)).rejects.toMatchObject({ code: "invalid_token" });
    await expect(runtime.client.verifyIdToken(await fake.signIdToken(CLIENT_ID, claims), "another-nonce-another-nonce-another-nonce")).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("refuses an access token presented as an ID token", async () => {
    fake.tampering = { typ: "access_token" };
    expect(ssoError(await signIn())).toBe("invalid_token");
  });

  it("refuses a callback with no pending flow, with another state, and a flow used twice", async () => {
    const start = await request(app).get("/auth/workeasy360/start");
    const flowCookie = cookieFrom(start.headers["set-cookie"], "we_w360_flow")!;
    const authorize = await fetch(start.headers.location as string, { redirect: "manual" });
    const back = new URL(authorize.headers.get("location")!);

    const noFlow = await request(app).get(back.pathname + back.search);
    expect(new URL(noFlow.headers.location as string).searchParams.get("sso_error")).toBe("expired");

    const forged = new URL(back);
    forged.searchParams.set("state", "a-state-this-browser-never-had-000000");
    const wrongState = await request(app).get(forged.pathname + forged.search).set("Cookie", flowCookie);
    expect(new URL(wrongState.headers.location as string).searchParams.get("sso_error")).toBe("expired");
    // The flow was taken by that attempt: the genuine callback cannot use it any more.
    const afterwards = await request(app).get(back.pathname + back.search).set("Cookie", flowCookie);
    expect(new URL(afterwards.headers.location as string).searchParams.get("sso_error")).toBe("expired");
    expect(cookieFrom(afterwards.headers["set-cookie"], "we_session")).toBeUndefined();

    const replayed = await signIn(app, { replay: true });
    expect(ssoError(replayed)).toBe("expired");
  });

  it("refuses a token for another product", async () => {
    fake.tampering = { productCode: "ai_commerce" };
    const done = await signIn();
    expect(ssoError(done)).toBe("wrong_product");
    expect(done.cookie).toBeUndefined();
  });

  it("refuses a token that names no organization", async () => {
    newPerson({ organizationId: undefined });
    const done = await signIn();
    expect(ssoError(done)).toBe("no_organization");
    expect(done.cookie).toBeUndefined();
  });

  it("refuses an address the provider has not verified", async () => {
    newPerson({ emailVerified: false });
    expect(ssoError(await signIn())).toBe("email_unverified");
  });

  it("refuses a token for another organization than the launcher asked for", async () => {
    const asked = randomUUID();
    fake.tampering = { claims: { organization_id: randomUUID() } };
    const done = await signIn(app, { organization: asked });
    expect(ssoError(done)).toBe("wrong_organization");
  });

  it("refuses an organization that is not entitled, with a purchase page and no session", async () => {
    const organizationId = fake.person.organizationId!;
    fake.entitlement = () => ({ status: 200, body: { decision: "deny", reason: "not_entitled", revalidate_after: 900 } });
    const done = await signIn();
    const target = new URL(done.location);
    expect(target.searchParams.get("sso_error")).toBe("not_entitled");
    expect(target.searchParams.get("reason")).toBe("not_entitled");
    expect(done.cookie).toBeUndefined();
    expect(await workeasy360Repo.findTenantByOrganization(db, organizationId)).toBeUndefined();
  });

  it("shows the provider's own refusal (product_not_entitled) as the same page", async () => {
    fake.authorizeError = "product_not_entitled";
    expect(ssoError(await signIn())).toBe("not_entitled");
  });
});

describe("WorkEasy360 tenancy", () => {
  it("never lets a session reach an organization its token did not name", async () => {
    const person = fake.person;
    const inA = await signIn();
    const tenantA = (await workeasy360Repo.findTenantByOrganization(db, person.organizationId!))!.tenantId;
    // The same person, through another WorkEasy360 organization: a membership in a second tenant.
    fake.person = { ...person, organizationId: randomUUID(), sid: randomUUID() };
    const inB = await signIn();
    const tenantB = (await workeasy360Repo.findTenantByOrganization(db, fake.person.organizationId!))!.tenantId;

    expect((await forms(app, inA.cookie!, tenantA)).status).toBe(200);
    expect((await forms(app, inA.cookie!, tenantB)).status).toBe(404);
    expect((await forms(app, inB.cookie!, tenantA)).status).toBe(404);
    expect((await forms(app, inB.cookie!, tenantB)).status).toBe(200);
    expect(MeResponseSchema.parse((await me(app, inA.cookie!)).body).organizations.map((o) => o.id)).toEqual([tenantA]);

    // Organizations come from WorkEasy360: a WorkEasy360 session cannot create one of its own.
    const create = await request(app).post("/api/v1/organizations").set("Cookie", inA.cookie!).set("Origin", TEST_CONSOLE_ORIGIN).send({ name: "Side org" });
    expect(create.status).toBe(403);
    expect(ProblemSchema.parse(create.body).code).toBe("WORKEASY360_ORGANIZATIONS");
  });

  it("lands an organization linked by the operator in its existing tenant, and keeps a revoked member out", async () => {
    // A tenant that existed before WorkEasy360 (password era), with a password owner.
    const signUp = await request(app)
      .post("/auth/password/signup")
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .send({ email: `owner.${randomUUID().slice(0, 8)}@example.test`, password: "a long password" });
    const ownerCookie = cookieFrom(signUp.headers["set-cookie"], "we_session")!;
    const created = await request(app).post("/api/v1/organizations").set("Cookie", ownerCookie).set("Origin", TEST_CONSOLE_ORIGIN).send({ name: "Legacy Ltd" });
    expect(created.status).toBe(201);
    const tenantId = created.body.id as string;
    const organizationId = fake.person.organizationId!;
    const link = await workeasy360Repo.linkOrganization(ownerDb, tenantId, organizationId);
    expect(link).toMatchObject({ changed: true, tenantName: "Legacy Ltd" });

    const done = await signIn();
    expect(done.location).toBe(`${TEST_CONSOLE_ORIGIN}/o/${tenantId}/forms`);
    const joined = MeResponseSchema.parse((await me(app, done.cookie!)).body);
    expect(joined.organizations).toEqual([expect.objectContaining({ id: tenantId, role: "creator" })]);

    // The password owner still works (not SSO-only), and now under the organization's entitlement.
    expect((await forms(app, ownerCookie, tenantId)).status).toBe(200);
    // The owner removes the WorkEasy360 member: the next WorkEasy360 sign-in does not bring them back.
    const removed = await request(app)
      .patch(`/api/v1/organizations/${tenantId}/members/${joined.user.id}`)
      .set("Cookie", ownerCookie)
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .send({ status: "revoked" });
    expect(removed.status).toBe(200);
    expect(ssoError(await signIn())).toBe("membership_revoked");

    // Linking is deliberate: a tenant linked to one organization is not re-pointed silently.
    await expect(workeasy360Repo.linkOrganization(ownerDb, tenantId, randomUUID())).rejects.toThrow(/already linked/);
  });

  it("refuses to link an organization a first sign-in already holds, unless that tenant is empty and replacement is asked for", async () => {
    const first = await signIn();
    const organizationId = fake.person.organizationId!;
    const auto = (await workeasy360Repo.findTenantByOrganization(db, organizationId))!.tenantId;
    const signUp = await request(app)
      .post("/auth/password/signup")
      .set("Origin", TEST_CONSOLE_ORIGIN)
      .send({ email: `owner.${randomUUID().slice(0, 8)}@example.test`, password: "a long password" });
    const ownerCookie = cookieFrom(signUp.headers["set-cookie"], "we_session")!;
    const legacy = (await request(app).post("/api/v1/organizations").set("Cookie", ownerCookie).set("Origin", TEST_CONSOLE_ORIGIN).send({ name: "Legacy 2" })).body.id as string;

    await expect(workeasy360Repo.linkOrganization(ownerDb, legacy, organizationId)).rejects.toThrow(/--replace-empty/);
    const replaced = await workeasy360Repo.linkOrganization(ownerDb, legacy, organizationId, { replaceEmpty: true });
    expect(replaced).toMatchObject({ changed: true, replacedTenantId: auto });
    // The empty tenant's WorkEasy360 sessions ended with it; the next sign-in lands in the linked tenant.
    expect((await me(app, first.cookie!)).status).toBe(401);
    expect((await signIn()).location).toBe(`${TEST_CONSOLE_ORIGIN}/o/${legacy}/forms`);
  });

  it("does not create tenants when provisioning is off", async () => {
    const strict = makeApp(makeRuntime({ provisionTenants: false }));
    expect(ssoError(await signIn(strict))).toBe("no_tenant");
  });
});

describe("WorkEasy360 entitlement on its schedule", () => {
  it("re-asks after revalidate_after, ends access on a denial, keeps the last answer through an outage and fails closed on a refusal of the client", async () => {
    let clock = Date.now();
    const memory = new Map<string, string>();
    const store: AnswerStore = { get: async (k) => memory.get(k) ?? null, set: async (k, v) => void memory.set(k, v) };
    const timed = makeApp(makeRuntime({ now: () => clock, store }));
    let reply = { status: 200, body: { decision: "allow", reason: "entitled", write_allowed: true, revalidate_after: 60 } as Record<string, unknown> };
    fake.entitlement = () => reply;
    const done = await signIn(timed);
    const tenantId = (await workeasy360Repo.findTenantByOrganization(db, fake.person.organizationId!))!.tenantId;
    const asked = () => fake.seen.entitlement.length;

    const before = asked();
    expect((await forms(timed, done.cookie!, tenantId)).status).toBe(200);
    expect(asked()).toBe(before); // within revalidate_after: not asked per request

    // The organization's subscription lapses into read-only: reads go on, writes stop.
    reply = { status: 200, body: { decision: "allow", reason: "entitled", write_allowed: false, revalidate_after: 60 } };
    clock += 61_000;
    expect((await forms(timed, done.cookie!, tenantId)).status).toBe(200);
    expect(asked()).toBe(before + 1);
    const write = await request(timed).post(`/api/v1/organizations/${tenantId}/forms`).set("Cookie", done.cookie!).set("Origin", TEST_CONSOLE_ORIGIN).send({ name: "New" });
    expect(write.status).toBe(403);
    expect(ProblemSchema.parse(write.body).code).toBe("WORKEASY360_READ_ONLY");

    // Then it is denied: access ends.
    reply = { status: 200, body: { decision: "deny", reason: "expired", revalidate_after: 60 } };
    clock += 61_000;
    const ended = await forms(timed, done.cookie!, tenantId);
    expect(ended.status).toBe(403);
    expect(ended.body).toMatchObject({ code: "WORKEASY360_ACCESS_ENDED", reason: "expired" });

    // An outage is never a denial, nor an access: the last answer (deny) stands.
    reply = { status: 503, body: { error: "temporarily_unavailable" } };
    clock += 61_000;
    expect((await forms(timed, done.cookie!, tenantId)).status).toBe(403);

    // Renewed: allowed again once asked.
    reply = { status: 200, body: { decision: "allow", reason: "entitled", write_allowed: true, revalidate_after: 60 } };
    clock += 61_000;
    expect((await forms(timed, done.cookie!, tenantId)).status).toBe(200);

    // The platform refuses this product's own client (a revoked credential): fail closed.
    reply = { status: 401, body: { error: "invalid_client" } };
    clock += 61_000;
    const refused = await forms(timed, done.cookie!, tenantId);
    expect(refused.status).toBe(403);
    expect(ProblemSchema.parse(refused.body).code).toBe("WORKEASY360_ACCESS_UNVERIFIED");
    // ...for every question for a minute, without asking again.
    const afterRefusal = asked();
    reply = { status: 200, body: { decision: "allow", reason: "entitled", write_allowed: true, revalidate_after: 60 } };
    clock += 10_000;
    expect((await forms(timed, done.cookie!, tenantId)).status).toBe(403);
    expect(asked()).toBe(afterRefusal);
    clock += 61_000;
    expect((await forms(timed, done.cookie!, tenantId)).status).toBe(200);
  });

  it("keeps an outage at arrival from locking anyone out", async () => {
    fake.entitlement = () => ({ status: 503, body: { error: "temporarily_unavailable" } });
    const done = await signIn(makeApp(makeRuntime({ store: { get: async () => null, set: async () => undefined } })));
    expect(done.res.status).toBe(303);
    expect(done.cookie).toBeDefined();
  });
});

describe("WorkEasy360 back-channel logout", () => {
  it("ends the session a sid names at once on both instances, and answers a duplicate with 200", async () => {
    const done = await signIn(app);
    const sid = fake.person.sid!;
    expect((await me(app, done.cookie!)).status).toBe(200);
    expect((await me(other, done.cookie!)).status).toBe(200);

    const token = await fake.logoutToken(CLIENT_ID, { sid, sub: fake.person.sub });
    const res = await backchannel(other, token);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    // Ended in the shared database: refused at once by both instances, not only the one that was told.
    expect((await me(app, done.cookie!)).status).toBe(401);
    expect((await me(other, done.cookie!)).status).toBe(401);

    // At least once delivery: the same token again is a success that changes nothing.
    expect((await backchannel(app, token)).status).toBe(200);
  });

  it("ends every session of the person when the token names sub only, and leaves other people alone", async () => {
    const person = fake.person;
    const one = await signIn(app);
    fake.person = { ...person, sid: randomUUID() };
    const two = await signIn(other);
    newPerson();
    const bystander = await signIn(app);

    expect((await backchannel(app, await fake.logoutToken(CLIENT_ID, { sub: person.sub }))).status).toBe(200);
    expect((await me(app, one.cookie!)).status).toBe(401);
    expect((await me(other, two.cookie!)).status).toBe(401);
    expect((await me(other, bystander.cookie!)).status).toBe(200);
  });

  it("refuses forged and malformed logout tokens with 400 and ends nothing", async () => {
    const done = await signIn();
    const { sub, sid } = fake.person;
    const forged = [
      await fake.logoutToken(CLIENT_ID, { sid, sub, foreignKey: true }),
      await fake.logoutToken(CLIENT_ID, { sid, sub, issuer: "https://accounts.example.test" }),
      await fake.logoutToken(CLIENT_ID, { sid, sub, audience: "some-other-product" }),
      await fake.logoutToken(CLIENT_ID, { sid, sub, typ: "JWT" }),
      await fake.logoutToken(CLIENT_ID, { sid, sub, withoutEvent: true }),
      await fake.logoutToken(CLIENT_ID, { sid, sub, nonce: "an-id-token-nonce" }),
      await fake.logoutToken(CLIENT_ID, {}),
      await fake.logoutToken(CLIENT_ID, { sid, sub, issuedAt: Math.floor(Date.now() / 1000) - 3600 }),
      "not-a-jwt",
    ];
    for (const token of forged) {
      const res = await backchannel(app, token);
      expect(res.status, token.slice(0, 40)).toBe(400);
    }
    const noField = await request(app).post("/auth/workeasy360/backchannel-logout").type("form").send({ token: "x" });
    expect(noField.status).toBe(400);
    const asJson = await request(app).post("/auth/workeasy360/backchannel-logout").send({ logout_token: await fake.logoutToken(CLIENT_ID, { sid, sub }) });
    expect(asJson.status).toBe(400);
    expect((await me(app, done.cookie!)).status).toBe(200);
  });

  it("accepts each jti once: a replayed jti for a new session ends nothing", async () => {
    const jti = randomUUID();
    const first = await signIn();
    expect((await backchannel(app, await fake.logoutToken(CLIENT_ID, { sub: fake.person.sub, jti }))).status).toBe(200);
    expect((await me(app, first.cookie!)).status).toBe(401);
    const again = await signIn();
    expect((await backchannel(app, await fake.logoutToken(CLIENT_ID, { sub: fake.person.sub, jti }))).status).toBe(200);
    expect((await me(app, again.cookie!)).status).toBe(200);
  });
});

describe("signing out", () => {
  it("ends only the product session, or also sends the browser to WorkEasy360's end_session_endpoint", async () => {
    const local = await signIn();
    const out = await request(app).post("/auth/logout").set("Cookie", local.cookie!).set("Origin", TEST_CONSOLE_ORIGIN);
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe(`${TEST_CONSOLE_ORIGIN}/`);
    expect((await me(app, local.cookie!)).status).toBe(401);

    const both = await signIn();
    const everywhere = await request(app).post("/auth/logout?workeasy360=1").set("Cookie", both.cookie!).set("Origin", TEST_CONSOLE_ORIGIN);
    expect(everywhere.status).toBe(303);
    const target = new URL(everywhere.headers.location as string);
    expect(target.origin + target.pathname).toBe(`${fake.issuer}/api/v1/integrations/oauth/logout`);
    expect(target.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe(POST_LOGOUT_URI);
    expect(target.searchParams.get("id_token_hint")).toMatch(/^ey/);
    expect((await me(app, both.cookie!)).status).toBe(401);
  });
});

describe("migration safety", () => {
  it("keeps password sign-in working when not SSO-only, and refuses it and its sessions when SSO-only", async () => {
    const email = `legacy.${randomUUID().slice(0, 8)}@example.test`;
    const signUp = await request(app).post("/auth/password/signup").set("Origin", TEST_CONSOLE_ORIGIN).send({ email, password: "a long password" });
    expect(signUp.status).toBe(200);
    const cookie = cookieFrom(signUp.headers["set-cookie"], "we_session")!;
    expect((await me(app, cookie)).status).toBe(200);

    const ssoOnly = makeApp(makeRuntime({ ssoOnly: true }));
    const login = await request(ssoOnly).post("/auth/password/login").set("Origin", TEST_CONSOLE_ORIGIN).send({ email, password: "a long password" });
    expect(login.status).toBe(403);
    expect(ProblemSchema.parse(login.body).code).toBe("PASSWORD_SIGN_IN_DISABLED");
    const refused = await me(ssoOnly, cookie);
    expect(refused.status).toBe(401);
    expect(ProblemSchema.parse(refused.body).code).toBe("WORKEASY360_SIGN_IN_REQUIRED");
    expect((await request(ssoOnly).get("/auth/methods")).body).toMatchObject({ password: false, sso: false, workeasy360: true });
    // A WorkEasy360 session works there.
    const done = await signIn(ssoOnly);
    expect((await me(ssoOnly, done.cookie!)).status).toBe(200);
  });

  it("refuses to split a person whose subject exists under another issuer, until the identity move runs", async () => {
    const oldIssuer = `${fake.issuer}/old-name`;
    const person = fake.person;
    // Signed in under the previous issuer name (before an issuer move).
    const previous = createWorkeasy360Runtime(
      db,
      { issuer: oldIssuer, clientId: CLIENT_ID, productCode: "workeasy_forms", redirectUri: REDIRECT_URI, keyId: keys.keyId, privateKeyPem: keys.privateKeyPem, scopes: ["openid"], allowInsecureRequests: true },
      { postLogoutRedirectUri: POST_LOGOUT_URI, ssoOnly: false, defaultRole: "creator", provisionTenants: true, purchaseUrl: "" },
    );
    const outcome = await workeasy360Repo.provisionSignIn(db, {
      issuer: previous.settings.issuer,
      subject: person.sub,
      organizationId: person.organizationId!,
      defaultRole: "creator",
      provisionTenants: true,
      homeRegion: "default",
    });
    expect(outcome.kind).toBe("ok");
    const oldUserId = outcome.kind === "ok" ? outcome.userId : "";

    expect(ssoError(await signIn())).toBe("identity_conflict");

    const dryRun = await workeasy360Repo.moveIssuer(ownerDb, oldIssuer, fake.issuer, false);
    expect(dryRun).toMatchObject({ movable: 1, conflicts: [], applied: false });
    const moved = await workeasy360Repo.moveIssuer(ownerDb, oldIssuer, fake.issuer, true);
    expect(moved.applied).toBe(true);

    const done = await signIn();
    expect(done.res.status).toBe(303);
    expect(MeResponseSchema.parse((await me(app, done.cookie!)).body).user.id).toBe(oldUserId);
  });

  it("refuses an issuer move that would merge two accounts", async () => {
    const oldIssuer = `${fake.issuer}/older-name`;
    const subject = randomUUID();
    // Someone signed in under the new issuer before the move ran (as a sign-in could, had it not refused).
    for (const issuer of [oldIssuer, fake.issuer]) await identityRepo.findOrCreateUser(db, { issuer, subject });
    const plan = await workeasy360Repo.moveIssuer(ownerDb, oldIssuer, fake.issuer, true);
    expect(plan.applied).toBe(false);
    expect(plan.conflicts).toEqual([expect.objectContaining({ subject })]);
  });

  it("re-keys an existing account to a WorkEasy360 identity when an operator vouches for it", async () => {
    const email = `vouched.${randomUUID().slice(0, 8)}@example.test`;
    const signUp = await request(app).post("/auth/password/signup").set("Origin", TEST_CONSOLE_ORIGIN).send({ email, password: "a long password" });
    const passwordCookie = cookieFrom(signUp.headers["set-cookie"], "we_session")!;
    const userId = MeResponseSchema.parse((await me(app, passwordCookie)).body).user.id;
    await workeasy360Repo.linkUserIdentity(ownerDb, userId, fake.issuer, fake.person.sub);
    const done = await signIn();
    expect(MeResponseSchema.parse((await me(app, done.cookie!)).body).user.id).toBe(userId);
    await expect(workeasy360Repo.linkUserIdentity(ownerDb, randomUUID(), fake.issuer, fake.person.sub)).rejects.toThrow(/No user/);
  });
});
