import { randomUUID } from "node:crypto";
import { createDb, identityRepo, type Db } from "@workeasy/database";
import { FIXTURE_ISSUER } from "@workeasy/test-fixtures";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { MeResponseSchema, OrganizationCreatedResponseSchema, ProblemSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** Self-serve sign-up: a new user creates an organization and owns it. Needs `pnpm infra:up`. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let app: Express;

async function newSession(): Promise<string> {
  const id = await identityRepo.findOrCreateUser(db, { issuer: FIXTURE_ISSUER, subject: `orgs-${randomUUID()}` });
  return (await identityRepo.createSession(db, id, 60 * 60 * 1000)).token;
}

const as = (token: string, method: "get" | "post", path: string) =>
  request(app)[method](path).set("Cookie", `we_session=${token}`).set("Origin", TEST_CONSOLE_ORIGIN);

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb, unusedIdentityProvider);
});

afterAll(async () => {
  await Promise.all([db.destroy(), publicDb.destroy()]);
});

describe("POST /api/v1/organizations", () => {
  it("creates an organization owned by the caller, who can then create forms", async () => {
    const token = await newSession();
    const res = await as(token, "post", "/api/v1/organizations").send({ name: "  Sign-up Co  " });
    expect(res.status).toBe(201);
    const org = OrganizationCreatedResponseSchema.parse(res.body);
    expect(org.name).toBe("Sign-up Co");

    const me = MeResponseSchema.parse((await as(token, "get", "/api/v1/me")).body);
    expect(me.organizations).toEqual([expect.objectContaining({ id: org.id, name: "Sign-up Co", role: "owner" })]);

    const form = await as(token, "post", `/api/v1/organizations/${org.id}/forms`).send({ name: "First form" });
    expect(form.status).toBe(201);
  });

  it("keeps a new organization invisible to other users", async () => {
    const owner = await newSession();
    const other = await newSession();
    const org = OrganizationCreatedResponseSchema.parse((await as(owner, "post", "/api/v1/organizations").send({ name: "Private" })).body);
    expect((await as(other, "get", `/api/v1/organizations/${org.id}/forms`)).status).toBe(404);
    expect(MeResponseSchema.parse((await as(other, "get", "/api/v1/me")).body).organizations).toEqual([]);
  });

  it("refuses a blank name, signed-out callers and more than five owned organizations", async () => {
    const token = await newSession();
    expect((await as(token, "post", "/api/v1/organizations").send({ name: "   " })).status).toBe(422);
    expect((await request(app).post("/api/v1/organizations").set("Origin", TEST_CONSOLE_ORIGIN).send({ name: "X" })).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await as(token, "post", "/api/v1/organizations").send({ name: `Org ${i}` })).status).toBe(201);
    const sixth = await as(token, "post", "/api/v1/organizations").send({ name: "One too many" });
    expect(sixth.status).toBe(409);
    expect(ProblemSchema.parse(sixth.body).code).toBe("ORGANIZATION_LIMIT");
  });
});
