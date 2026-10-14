import { createDb, identityRepo, withContext, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import { sql } from "kysely";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import {
  FormGrantsResponseSchema,
  FormListResponseSchema,
  MeResponseSchema,
  ProblemSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN } from "./test-support.js";

const urls = inject("testDatabase");

let db: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;

/** Session tokens by name. */
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};

const owner = (t: TenantFixture) => t.members.find((m) => m.role === "owner")!.user.id;
const analyst = (t: TenantFixture) => t.members.find((m) => m.role === "analyst")!.user.id;

function get(path: string, who: string) {
  return request(app).get(path).set("Cookie", `we_session=${tokens[who]}`);
}

function put(path: string, who: string, body: unknown, origin: string | null = TEST_CONSOLE_ORIGIN) {
  const req = request(app).put(path).set("Cookie", `we_session=${tokens[who]}`).send(body as object);
  return origin === null ? req : req.set("Origin", origin);
}

async function addMember(tenant: TenantFixture, name: string, role: "creator" | "analyst", status: "active" | "revoked" = "active") {
  const userId = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `api-test-${randomUUID()}`, displayName: name });
  await withTenant(db, tenant.id, (trx) => trx.insertInto("memberships").values({ tenant_id: tenant.id, user_id: userId, role, status }).execute());
  return userId;
}

async function signIn(name: string, userId: string) {
  users[name] = userId;
  tokens[name] = (await identityRepo.createSession(db, userId, 60 * 60 * 1000)).token;
}

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  app = buildTestApp(db);
  a = createTenantFixture("API tenant A");
  b = createTenantFixture("API tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);

  await signIn("ownerA", owner(a));
  await signIn("analystA", analyst(a));
  await signIn("ownerB", owner(b));
  await signIn("creatorA", await addMember(a, "Creator A", "creator"));
  await signIn("revokedA", await addMember(a, "Revoked A", "analyst", "revoked"));
  await signIn(
    "noOrg",
    await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `api-test-${randomUUID()}`, displayName: "No org" }),
  );
});

afterAll(async () => {
  await db?.destroy();
});

const formsPath = (orgId: string) => `/api/v1/organizations/${orgId}/forms`;
const grantsPath = (orgId: string, formId: string) => `/api/v1/organizations/${orgId}/forms/${formId}/grants`;

function expectNotFound(res: request.Response) {
  expect(res.status).toBe(404);
  expect(ProblemSchema.parse(res.body).code).toBe("NOT_FOUND");
}

describe("sessions", () => {
  it("rejects requests without a session, with an unknown token, or with a revoked or expired session", async () => {
    expect((await request(app).get("/api/v1/me")).status).toBe(401);
    expect((await request(app).get("/api/v1/me").set("Cookie", `we_session=${"x".repeat(43)}`)).status).toBe(401);

    const revoked = await identityRepo.createSession(db, owner(a), 60_000);
    await identityRepo.revokeSession(db, { sessionId: revoked.sessionId, userId: owner(a) });
    expect((await request(app).get("/api/v1/me").set("Cookie", `we_session=${revoked.token}`)).status).toBe(401);

    const expired = await identityRepo.createSession(db, owner(a), 60_000);
    await withContext(db, { userId: owner(a) }, (trx) =>
      trx
        .updateTable("auth_sessions")
        .set({ expires_at: sql<Date>`created_at + interval '1 microsecond'` })
        .where("id", "=", expired.sessionId)
        .execute(),
    );
    expect((await request(app).get("/api/v1/me").set("Cookie", `we_session=${expired.token}`)).status).toBe(401);
  });
});

describe("GET /api/v1/me", () => {
  it("lists only the caller's active memberships with role permissions", async () => {
    const res = await get("/api/v1/me", "ownerA");
    expect(res.status).toBe(200);
    const me = MeResponseSchema.parse(res.body);
    expect(me.user.id).toBe(owner(a));
    expect(me.organizations.map((o) => o.id)).toEqual([a.id]);
    expect(me.organizations[0]?.permissions).toContain("organization.manage");
  });

  it("shows no organizations for a user without memberships, and hides revoked ones", async () => {
    expect(MeResponseSchema.parse((await get("/api/v1/me", "noOrg")).body).organizations).toEqual([]);
    expect(MeResponseSchema.parse((await get("/api/v1/me", "revokedA")).body).organizations).toEqual([]);
  });
});

describe("organization routes: tenant isolation", () => {
  it("lists tenant A's forms for tenant A's owner", async () => {
    const res = await get(formsPath(a.id), "ownerA");
    expect(res.status).toBe(200);
    const body = FormListResponseSchema.parse(res.body);
    expect(body.items.map((f) => f.id).sort()).toEqual(a.forms.map((f) => f.id).sort());
  });

  it("returns 404 when a member of A asks for B's organization, and vice versa", async () => {
    expectNotFound(await get(formsPath(b.id), "ownerA"));
    expectNotFound(await get(formsPath(a.id), "ownerB"));
  });

  it("returns 404 for unknown or malformed organization IDs", async () => {
    expectNotFound(await get(formsPath(randomUUID()), "ownerA"));
    expectNotFound(await get(formsPath("not-a-uuid"), "ownerA"));
  });

  it("returns 404 for B's form addressed through A's organization or B's", async () => {
    const formB = b.forms[0]!.id;
    expectNotFound(await get(grantsPath(a.id, formB), "ownerA"));
    expectNotFound(await get(grantsPath(b.id, formB), "ownerA"));
    expectNotFound(await put(grantsPath(a.id, formB), "ownerA", { grants: [] }));
  });

  it("refuses grants to members of another organization", async () => {
    const res = await put(grantsPath(a.id, a.forms[0]!.id), "ownerA", {
      grants: [{ principalType: "user", principalId: owner(b), permission: "responses.read" }],
    });
    expect(res.status).toBe(422);
    expect(ProblemSchema.parse(res.body).errors?.[0]).toMatchObject({ field: "grants.0.principalId", code: "NOT_A_MEMBER" });
  });

  it("denies a revoked member everything in the organization", async () => {
    expectNotFound(await get(formsPath(a.id), "revokedA"));
    expectNotFound(await get(grantsPath(a.id, a.forms[0]!.id), "revokedA"));
  });

  it("applies a membership revocation to the very next request", async () => {
    const userId = await addMember(a, "Soon revoked", "creator");
    await signIn("soonRevoked", userId);
    expect((await get(formsPath(a.id), "soonRevoked")).status).toBe(200);
    await withTenant(db, a.id, (trx) =>
      trx.updateTable("memberships").set({ status: "revoked" }).where("user_id", "=", userId).execute(),
    );
    expectNotFound(await get(formsPath(a.id), "soonRevoked"));
  });
});

describe("roles and form grants", () => {
  it("shows analysts and creators only the forms they hold grants on", async () => {
    expect(FormListResponseSchema.parse((await get(formsPath(a.id), "analystA")).body).items).toEqual([]);
    expect(FormListResponseSchema.parse((await get(formsPath(a.id), "creatorA")).body).items).toEqual([]);
  });

  it("lets an owner grant access and the grantee then sees exactly that form", async () => {
    const [first, second] = a.forms;
    const res = await put(grantsPath(a.id, first!.id), "ownerA", {
      grants: [
        { principalType: "user", principalId: users.analystA, permission: "responses.read" },
        // Duplicates collapse into one grant.
        { principalType: "user", principalId: users.analystA, permission: "responses.read" },
        { principalType: "user", principalId: users.creatorA, permission: "forms.manage_access" },
      ],
    });
    expect(res.status).toBe(200);
    expect(FormGrantsResponseSchema.parse(res.body).grants).toHaveLength(2);

    const analystForms = FormListResponseSchema.parse((await get(formsPath(a.id), "analystA")).body).items;
    expect(analystForms.map((f) => f.id)).toEqual([first!.id]);

    // Reading responses does not include managing access.
    const forbidden = await get(grantsPath(a.id, first!.id), "analystA");
    expect(forbidden.status).toBe(403);
    expect(ProblemSchema.parse(forbidden.body).code).toBe("FORBIDDEN");
    // A form without any grant stays invisible.
    expectNotFound(await get(grantsPath(a.id, second!.id), "analystA"));

    // A creator granted forms.manage_access can manage that form's grants.
    const creatorView = await get(grantsPath(a.id, first!.id), "creatorA");
    expect(creatorView.status).toBe(200);
  });

  it("validates grant bodies", async () => {
    const formId = a.forms[0]!.id;
    const badPermission = await put(grantsPath(a.id, formId), "ownerA", {
      grants: [{ principalType: "user", principalId: users.analystA, permission: "everything" }],
    });
    expect(badPermission.status).toBe(422);
    const revoked = await put(grantsPath(a.id, formId), "ownerA", {
      grants: [{ principalType: "user", principalId: users.revokedA, permission: "forms.read" }],
    });
    expect(revoked.status).toBe(422);
    expect((await put(grantsPath(a.id, formId), "ownerA", { nope: true })).status).toBe(422);
  });
});

describe("cross-origin protection", () => {
  it("rejects cookie-authenticated mutations without the console origin", async () => {
    const path = grantsPath(a.id, a.forms[1]!.id);
    const missing = await put(path, "ownerA", { grants: [] }, null);
    expect(missing.status).toBe(403);
    expect(ProblemSchema.parse(missing.body).code).toBe("CROSS_ORIGIN_REQUEST");
    expect((await put(path, "ownerA", { grants: [] }, "https://evil.example")).status).toBe(403);

    const viaReferer = await request(app)
      .put(path)
      .set("Cookie", `we_session=${tokens.ownerA}`)
      .set("Referer", `${TEST_CONSOLE_ORIGIN}/o/${a.id}/forms`)
      .send({ grants: [] });
    expect(viaReferer.status).toBe(200);
  });
});

describe("form list pagination", () => {
  it("pages through every visible form exactly once with keyset cursors", async () => {
    await withTenant(db, a.id, (trx) =>
      trx
        .insertInto("forms")
        .values(
          Array.from({ length: 5 }, (_, i) => ({
            tenant_id: a.id,
            slug: `t-page-${randomUUID().slice(0, 8)}-${i}`,
            name: `Paged form ${i}`,
            owner_id: owner(a),
          })),
        )
        .execute(),
    );
    const all = FormListResponseSchema.parse((await get(`${formsPath(a.id)}?limit=100`, "ownerA")).body).items.map((f) => f.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await get(`${formsPath(a.id)}?limit=2${cursor ? `&cursor=${cursor}` : ""}`, "ownerA");
      const page = FormListResponseSchema.parse(res.body);
      seen.push(...page.items.map((f) => f.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("filters by name and state and rejects bad parameters", async () => {
    const named = FormListResponseSchema.parse((await get(`${formsPath(a.id)}?q=paged%20form%203`, "ownerA")).body);
    expect(named.items.map((f) => f.name)).toEqual(["Paged form 3"]);
    // LIKE wildcards in the search are matched literally.
    expect(FormListResponseSchema.parse((await get(`${formsPath(a.id)}?q=%25`, "ownerA")).body).items).toEqual([]);
    expect(FormListResponseSchema.parse((await get(`${formsPath(a.id)}?state=published`, "ownerA")).body).items).toEqual([]);
    expect((await get(`${formsPath(a.id)}?limit=101`, "ownerA")).status).toBe(422);
    expect((await get(`${formsPath(a.id)}?cursor=garbage`, "ownerA")).status).toBe(422);
  });
});
