import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@workeasy/database";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { MeResponseSchema, ProblemSchema } from "./contract/schemas.js";
import { buildTestApp, TEST_CONSOLE_ORIGIN, testSettings, unusedIdentityProvider } from "./test-support.js";

/** Email and password sign-up and sign-in. Needs `pnpm infra:up`. */
const urls = inject("testDatabase");

let db: Db;
let publicDb: Db;
let app: Express;

const post = (path: string, body: object, origin = TEST_CONSOLE_ORIGIN) => request(app).post(path).set("Origin", origin).send(body);
const sessionCookie = (res: request.Response) => (res.get("Set-Cookie") ?? []).find((c) => c.startsWith("we_session="))?.split(";")[0];
const newEmail = () => `Person.${randomUUID().slice(0, 8)}@Example.test`;

beforeAll(async () => {
  db = createDb({ connectionString: urls.api, maxConnections: 4 });
  publicDb = createDb({ connectionString: urls.public, maxConnections: 2 });
  app = buildTestApp(db, unusedIdentityProvider, testSettings, publicDb, unusedIdentityProvider);
});

afterAll(async () => {
  await Promise.all([db.destroy(), publicDb.destroy()]);
});

describe("password accounts", () => {
  it("signs up, opens a session, and signs in again with any email case", async () => {
    const email = newEmail();
    const signUp = await post("/auth/password/signup", { email, password: "a long password" });
    expect(signUp.status).toBe(200);
    const cookie = sessionCookie(signUp)!;
    expect(cookie).toBeDefined();
    const me = MeResponseSchema.parse((await request(app).get("/api/v1/me").set("Cookie", cookie)).body);
    expect(me.user.displayName).toBe(email.toLowerCase());
    expect(me.organizations).toEqual([]);

    const signIn = await post("/auth/password/login", { email: email.toUpperCase(), password: "a long password" });
    expect(signIn.status).toBe(200);
    expect(sessionCookie(signIn)).toBeDefined();
  });

  it("refuses a taken email, a short password and a bad email", async () => {
    const email = newEmail();
    expect((await post("/auth/password/signup", { email, password: "a long password" })).status).toBe(200);
    const taken = await post("/auth/password/signup", { email: email.toUpperCase(), password: "another password" });
    expect(taken.status).toBe(409);
    expect(ProblemSchema.parse(taken.body).code).toBe("EMAIL_TAKEN");
    expect((await post("/auth/password/signup", { email: newEmail(), password: "short" })).status).toBe(422);
    expect((await post("/auth/password/signup", { email: "not-an-email", password: "a long password" })).status).toBe(422);
  });

  it("gives the same answer for a wrong password and an unknown email, then pauses after repeated failures", async () => {
    const email = newEmail();
    await post("/auth/password/signup", { email, password: "a long password" });
    const wrong = await post("/auth/password/login", { email, password: "wrong password" });
    const unknown = await post("/auth/password/login", { email: newEmail(), password: "wrong password" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(ProblemSchema.parse(wrong.body).title).toBe(ProblemSchema.parse(unknown.body).title);
    expect(sessionCookie(wrong)).toBeUndefined();
    for (let i = 0; i < 9; i++) await post("/auth/password/login", { email, password: "wrong password" });
    const paused = await post("/auth/password/login", { email, password: "a long password" });
    expect(paused.status).toBe(429);
  });

  it("accepts requests only from the console origin", async () => {
    const res = await post("/auth/password/signup", { email: newEmail(), password: "a long password" }, "https://evil.example");
    expect(res.status).toBe(403);
  });
});
