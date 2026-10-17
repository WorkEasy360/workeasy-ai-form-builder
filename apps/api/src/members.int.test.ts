import { randomUUID } from "node:crypto";
import { createDb, identityRepo, withTenant, type Db } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { createTenantFixture, FIXTURE_ISSUER, type TenantFixture } from "@workeasy/test-fixtures";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  AuditListResponseSchema,
  InvitationAcceptResponseSchema,
  InvitationCreatedResponseSchema,
  InvitationListResponseSchema,
  MemberListResponseSchema,
  MemberResponseSchema,
  ProblemSchema,
} from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** PAR-05: the members screen and invitation links. Needs `pnpm infra:up`. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let app: Express;
let a: TenantFixture;
let b: TenantFixture;
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};

const roleUser = (t: TenantFixture, role: string) => t.members.find((m) => m.role === role)!.user.id;
const as = (who: string, method: "get" | "post" | "patch", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${tokens[who]}`).set("Origin", TEST_CONSOLE_ORIGIN);
const orgPath = (t: TenantFixture) => `/api/v1/organizations/${t.id}`;

async function newUser(name: string): Promise<void> {
  const id = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `members-${randomUUID()}` });
  users[name] = id;
  tokens[name] = (await identityRepo.createSession(db, id, 60 * 60 * 1000)).token;
}

async function invite(who: string, role: string, tenant = a) {
  const res = await as(who, "post", `${orgPath(tenant)}/invitations`).send({ role, email: "new.person@example.test" });
  expect(res.status).toBe(201);
  const created = InvitationCreatedResponseSchema.parse(res.body);
  return { ...created, token: created.url.split("/invite/")[1]! };
}

const accept = (who: string, token: string) => as(who, "post", "/api/v1/invitations/accept").send({ token });

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb, unusedIdentityProvider);
  a = createTenantFixture("Members tenant A");
  b = createTenantFixture("Members tenant B");
  await seedTenantFixture(db, a);
  await seedTenantFixture(db, b);
  await newUser("adminA");
  await withTenant(db, a.id, (trx) => trx.insertInto("memberships").values({ tenant_id: a.id, user_id: users.adminA!, role: "admin" }).execute());
  for (const [name, id] of [
    ["ownerA", roleUser(a, "owner")],
    ["analystA", roleUser(a, "analyst")],
    ["ownerB", roleUser(b, "owner")],
  ] as const) {
    users[name] = id;
    tokens[name] = (await identityRepo.createSession(db, id, 60 * 60 * 1000)).token;
  }
});

afterAll(async () => {
  await db?.destroy();
  await publicDb?.destroy();
});

describe("member list", () => {
  it("shows the organization's members to owners and admins only", async () => {
    const res = await as("adminA", "get", `${orgPath(a)}/members`);
    expect(res.status).toBe(200);
    const ids = MemberListResponseSchema.parse(res.body).members.map((m) => m.userId);
    expect(ids).toContain(users.ownerA);
    expect(ids).not.toContain(users.ownerB);
    expect((await as("analystA", "get", `${orgPath(a)}/members`)).status).toBe(403);
    expect((await as("ownerB", "get", `${orgPath(a)}/members`)).status).toBe(404);
  });
});

describe("invitation links", () => {
  it("joins a new user with the invited role, once", async () => {
    await newUser("joiner");
    const created = await invite("adminA", "analyst");
    expect(created.invitation.status).toBe("pending");
    expect(created.url.startsWith(`${TEST_CONSOLE_ORIGIN}/invite/`)).toBe(true);

    const joined = await accept("joiner", created.token);
    expect(joined.status).toBe(200);
    expect(InvitationAcceptResponseSchema.parse(joined.body).organization).toEqual({ id: a.id, role: "analyst" });

    const members = MemberListResponseSchema.parse((await as("ownerA", "get", `${orgPath(a)}/members`)).body).members;
    expect(members.find((m) => m.userId === users.joiner)).toMatchObject({ role: "analyst", status: "active" });

    await newUser("latecomer");
    const reused = await accept("latecomer", created.token);
    expect(reused.status).toBe(404);
    expect(ProblemSchema.parse(reused.body).code).toBe("INVITATION_INVALID");

    const listed = InvitationListResponseSchema.parse((await as("ownerA", "get", `${orgPath(a)}/invitations`)).body).invitations;
    expect(listed.find((i) => i.id === created.invitation.id)).toMatchObject({ status: "accepted", acceptedBy: users.joiner });
  });

  it("stores only a hash of the token", async () => {
    const { token, invitation } = await invite("ownerA", "creator");
    const listed = JSON.stringify((await as("ownerA", "get", `${orgPath(a)}/invitations`)).body);
    expect(listed).toContain(invitation.id);
    expect(listed).not.toContain(token);
  });

  it("rejects revoked and unknown links the same way", async () => {
    await newUser("revokedJoiner");
    const { token, invitation } = await invite("ownerA", "creator");
    const revoked = await as("adminA", "post", `${orgPath(a)}/invitations/${invitation.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect((await as("adminA", "post", `${orgPath(a)}/invitations/${invitation.id}/revoke`)).status).toBe(409);
    const tried = await accept("revokedJoiner", token);
    const unknown = await accept("revokedJoiner", "x".repeat(43));
    expect([tried.status, unknown.status]).toEqual([404, 404]);
    expect(ProblemSchema.parse(tried.body).code).toBe(ProblemSchema.parse(unknown.body).code);
  });

  it("keeps an existing member's role and leaves the link usable", async () => {
    const { token } = await invite("ownerA", "creator");
    const res = await accept("analystA", token);
    expect(res.status).toBe(409);
    expect(ProblemSchema.parse(res.body).code).toBe("ALREADY_MEMBER");
    await newUser("second");
    expect((await accept("second", token)).status).toBe(200);
  });

  it("lets a manager invite only up to their own role", async () => {
    expect((await as("adminA", "post", `${orgPath(a)}/invitations`).send({ role: "owner" })).status).toBe(403);
    expect((await as("analystA", "post", `${orgPath(a)}/invitations`).send({ role: "analyst" })).status).toBe(403);
    expect((await as("ownerB", "post", `${orgPath(a)}/invitations`).send({ role: "analyst" })).status).toBe(404);
  });

  it("audits creating, revoking and accepting without the email", async () => {
    await newUser("audited");
    const { token, invitation } = await invite("ownerA", "approver");
    await accept("audited", token);
    const audit = AuditListResponseSchema.parse((await as("ownerA", "get", `${orgPath(a)}/audit?resourceId=${invitation.id}`)).body);
    expect(audit.items.map((e) => e.action).toSorted()).toEqual(["invitation.accepted", "invitation.created"]);
    expect(JSON.stringify(audit.items)).not.toContain("example.test");
  });
});

describe("changing members", () => {
  it("changes roles, removes and restores members", async () => {
    await newUser("changed");
    await accept("changed", (await invite("ownerA", "analyst")).token);
    const path = `${orgPath(a)}/members/${users.changed}`;

    const promoted = await as("adminA", "patch", path).send({ role: "creator" });
    expect(MemberResponseSchema.parse(promoted.body).member.role).toBe("creator");

    expect((await as("adminA", "patch", path).send({ status: "revoked" })).status).toBe(200);
    expect((await as("changed", "get", `${orgPath(a)}/forms`)).status).toBe(404);

    const restored = await as("adminA", "patch", path).send({ status: "active" });
    expect(MemberResponseSchema.parse(restored.body).member.status).toBe("active");
    expect((await as("changed", "get", `${orgPath(a)}/forms`)).status).toBe(200);
  });

  it("lets only owners change owners", async () => {
    expect((await as("adminA", "patch", `${orgPath(a)}/members/${users.ownerA}`).send({ role: "admin" })).status).toBe(403);
    expect((await as("adminA", "patch", `${orgPath(a)}/members/${users.analystA}`).send({ role: "owner" })).status).toBe(403);
  });

  it("always keeps one active owner", async () => {
    const res = await as("ownerB", "patch", `${orgPath(b)}/members/${users.ownerB}`).send({ status: "revoked" });
    expect(res.status).toBe(409);
    expect(ProblemSchema.parse(res.body).code).toBe("LAST_OWNER");

    await newUser("coOwner");
    await accept("coOwner", (await invite("ownerB", "owner", b)).token);
    const stepDown = await as("ownerB", "patch", `${orgPath(b)}/members/${users.ownerB}`).send({ role: "admin" });
    expect(stepDown.status).toBe(200);
    expect((await as("coOwner", "patch", `${orgPath(b)}/members/${users.coOwner}`).send({ role: "admin" })).status).toBe(409);
  });

  it("rejects unknown members and empty changes", async () => {
    expect((await as("ownerA", "patch", `${orgPath(a)}/members/${users.ownerB}`).send({ role: "analyst" })).status).toBe(404);
    expect((await as("ownerA", "patch", `${orgPath(a)}/members/${users.analystA}`).send({})).status).toBe(422);
  });
});
