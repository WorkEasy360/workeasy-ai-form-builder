import { createTenantFixture, type TenantFixture } from "@workeasy/test-fixtures";
import { sql } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { InvalidDbContextError, withContext, withTenant } from "./context.js";
import * as identityRepo from "./repositories/identity.js";
import { DB_ROLES, RUNTIME_ROLE_KEYS } from "./roles.js";
import { seedTenantFixture } from "./testing/index.js";

const urls = inject("testDatabase");

/** Asserts a PostgreSQL error by SQLSTATE (and optionally message). */
async function expectPgError(action: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const err: unknown = await action.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected SQLSTATE ${code}`).toBeInstanceOf(Error);
  expect((err as { code?: string }).code).toBe(code);
  expect((err as Error).message).toMatch(message ?? /./);
}

const RLS_VIOLATION = "42501"; // insufficient_privilege: RLS WITH CHECK and missing grants
const FOREIGN_KEY_VIOLATION = "23503";

let api: Db;
let worker: Db;
let a: TenantFixture;
let b: TenantFixture;

beforeAll(async () => {
  api = createDb({ connectionString: urls.api, maxConnections: 4 });
  worker = createDb({ connectionString: urls.worker, maxConnections: 2 });
  a = createTenantFixture("Tenant A");
  b = createTenantFixture("Tenant B");
  await seedTenantFixture(api, a);
  await seedTenantFixture(api, b);
});

afterAll(async () => {
  await api?.destroy();
  await worker?.destroy();
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).toSorted();
const formIds = (t: TenantFixture) => t.forms.map((f) => f.id).toSorted();
const ownerOf = (t: TenantFixture) => t.members.find((m) => m.role === "owner")!.user;

describe("tenant isolation through the api role", () => {
  it("returns no tenant rows without a context", async () => {
    const fixtureFormIds = [...formIds(a), ...formIds(b)];
    expect(await api.selectFrom("forms").select("id").where("id", "in", fixtureFormIds).execute()).toEqual([]);
    expect(await api.selectFrom("tenants").select("id").where("id", "in", [a.id, b.id]).execute()).toEqual([]);
    expect(await api.selectFrom("memberships").selectAll().where("tenant_id", "in", [a.id, b.id]).execute()).toEqual([]);
    expect(await api.selectFrom("users").select("id").where("id", "=", ownerOf(a).id).execute()).toEqual([]);
  });

  it("shows tenant A only its own tenant, members, users and forms", async () => {
    await withTenant(api, a.id, async (trx) => {
      expect(ids(await trx.selectFrom("forms").select("id").execute())).toEqual(formIds(a));
      expect(ids(await trx.selectFrom("tenants").select("id").execute())).toEqual([a.id]);
      const memberships = await trx.selectFrom("memberships").select(["tenant_id", "user_id"]).execute();
      expect(memberships.map((m) => m.user_id).toSorted()).toEqual(a.members.map((m) => m.user.id).toSorted());
      expect(new Set(memberships.map((m) => m.tenant_id))).toEqual(new Set([a.id]));
      expect(ids(await trx.selectFrom("users").select("id").execute())).toEqual(a.members.map((m) => m.user.id).toSorted());
    });
  });

  it("cannot read tenant B rows by ID from tenant A", async () => {
    await withTenant(api, a.id, async (trx) => {
      expect(await trx.selectFrom("forms").selectAll().where("id", "=", b.forms[0]!.id).execute()).toEqual([]);
      expect(await trx.selectFrom("tenants").selectAll().where("id", "=", b.id).execute()).toEqual([]);
      expect(await trx.selectFrom("users").selectAll().where("id", "=", ownerOf(b).id).execute()).toEqual([]);
    });
  });

  it("cannot update tenant B rows from tenant A", async () => {
    const target = b.forms[0]!;
    const result = await withTenant(api, a.id, (trx) =>
      trx.updateTable("forms").set({ name: "hijacked" }).where("id", "=", target.id).executeTakeFirst(),
    );
    expect(result.numUpdatedRows).toBe(0n);
    const tenantResult = await withTenant(api, a.id, (trx) =>
      trx.updateTable("tenants").set({ name: "hijacked" }).where("id", "=", b.id).executeTakeFirst(),
    );
    expect(tenantResult.numUpdatedRows).toBe(0n);
    const stillB = await withTenant(api, b.id, (trx) =>
      trx.selectFrom("forms").select("name").where("id", "=", target.id).executeTakeFirstOrThrow(),
    );
    expect(stillB.name).toBe(target.name);
  });

  it("cannot insert rows into tenant B from tenant A", async () => {
    await expectPgError(
      withTenant(api, a.id, (trx) =>
        trx
          .insertInto("forms")
          .values({ tenant_id: b.id, slug: "t-cross-insert-0001", name: "x", owner_id: ownerOf(b).id })
          .execute(),
      ),
      RLS_VIOLATION,
      /row-level security/,
    );
    await expectPgError(
      withTenant(api, a.id, (trx) =>
        trx.insertInto("memberships").values({ tenant_id: b.id, user_id: ownerOf(a).id, role: "admin" }).execute(),
      ),
      RLS_VIOLATION,
      /row-level security/,
    );
  });

  it("cannot move a tenant A row into tenant B", async () => {
    await expectPgError(
      withTenant(api, a.id, (trx) =>
        trx.updateTable("forms").set({ tenant_id: b.id }).where("id", "=", a.forms[0]!.id).execute(),
      ),
      RLS_VIOLATION,
      /row-level security/,
    );
  });

  it("rejects a form owned by a user who is not a member of the tenant", async () => {
    await expectPgError(
      withTenant(api, a.id, (trx) =>
        trx
          .insertInto("forms")
          .values({ tenant_id: a.id, slug: "t-foreign-owner-01", name: "x", owner_id: ownerOf(b).id })
          .execute(),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("does not let a user context see or edit other users", async () => {
    const self = ownerOf(a);
    await withContext(api, { userId: self.id }, async (trx) => {
      expect(ids(await trx.selectFrom("users").select("id").execute())).toEqual([self.id]);
      const other = await trx
        .updateTable("users")
        .set({ display_name: "hijacked" })
        .where("id", "=", ownerOf(b).id)
        .executeTakeFirst();
      expect(other.numUpdatedRows).toBe(0n);
    });
  });

  it("has no DELETE privilege on tenant tables", async () => {
    await expectPgError(
      withTenant(api, a.id, (trx) => trx.deleteFrom("forms").where("id", "=", a.forms[0]!.id).execute()),
      RLS_VIOLATION,
      /permission denied/,
    );
  });
});

describe("tenant context lifetime", () => {
  it("does not leak to the next transaction on the same pooled connection", async () => {
    const single = createDb({ connectionString: urls.api, maxConnections: 1 });
    try {
      await withTenant(single, a.id, (trx) => trx.selectFrom("forms").select("id").execute());
      const leaked = await sql<{ tenant: string | null }>`SELECT current_setting('app.tenant_id', true) AS tenant`.execute(single);
      expect(leaked.rows[0]?.tenant ?? "").toBe("");
      expect(await single.selectFrom("forms").select("id").where("id", "in", formIds(a)).execute()).toEqual([]);
    } finally {
      await single.destroy();
    }
  });

  it("does not leak after a failed transaction", async () => {
    const single = createDb({ connectionString: urls.api, maxConnections: 1 });
    try {
      await expect(
        withTenant(single, a.id, async () => {
          throw new Error("handler failed");
        }),
      ).rejects.toThrow("handler failed");
      expect(await single.selectFrom("forms").select("id").where("id", "in", formIds(a)).execute()).toEqual([]);
    } finally {
      await single.destroy();
    }
  });

  it("rejects missing or malformed context before touching the database", async () => {
    await expect(withContext(api, {}, async () => undefined)).rejects.toBeInstanceOf(InvalidDbContextError);
    await expect(withTenant(api, "' OR true --", async () => undefined)).rejects.toBeInstanceOf(InvalidDbContextError);
  });
});

describe("user context (signed in, no organization selected)", () => {
  it("lists the user's own memberships across tenants only without a tenant context", async () => {
    const shared = ownerOf(a);
    await withTenant(api, b.id, (trx) =>
      trx.insertInto("memberships").values({ tenant_id: b.id, user_id: shared.id, role: "analyst" }).execute(),
    );

    const own = await withContext(api, { userId: shared.id }, (trx) =>
      trx.selectFrom("memberships").select("tenant_id").execute(),
    );
    expect(own.map((m) => m.tenant_id).toSorted()).toEqual([a.id, b.id].toSorted());
    const tenants = await withContext(api, { userId: shared.id }, (trx) => trx.selectFrom("tenants").select("id").execute());
    expect(ids(tenants)).toEqual([a.id, b.id].toSorted());

    // With an organization selected the same user sees only that organization.
    const scoped = await withContext(api, { tenantId: a.id, userId: shared.id }, (trx) =>
      trx.selectFrom("memberships").select("tenant_id").where("user_id", "=", shared.id).execute(),
    );
    expect(scoped.map((m) => m.tenant_id)).toEqual([a.id]);
  });

  it("never shows another user's memberships", async () => {
    const rows = await withContext(api, { userId: ownerOf(b).id }, (trx) =>
      trx.selectFrom("memberships").select("user_id").execute(),
    );
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([ownerOf(b).id]));
  });
});

describe("sessions and identity lookups", () => {
  it("resolves identities and active sessions only through the narrow functions", async () => {
    const user = ownerOf(a);
    const found = await sql<{ id: string }>`SELECT app.find_user_id_by_identity(${user.issuer}, ${user.subject}) AS id`.execute(api);
    expect(found.rows[0]?.id).toBe(user.id);

    const session = await identityRepo.createSession(api, user.id, 60_000);
    expect(await identityRepo.resolveSession(api, session.token)).toMatchObject({ userId: user.id });
    await identityRepo.revokeSession(api, { sessionId: session.sessionId, userId: user.id });
    expect(await identityRepo.resolveSession(api, session.token)).toBeUndefined();
  });

  it("keeps session rows invisible without the owning user's context", async () => {
    const session = await identityRepo.createSession(api, ownerOf(a).id, 60_000);
    expect(await api.selectFrom("auth_sessions").select("id").where("id", "=", session.sessionId).execute()).toEqual([]);
    const otherUser = await withContext(api, { userId: ownerOf(b).id }, (trx) =>
      trx.selectFrom("auth_sessions").select("id").where("id", "=", session.sessionId).execute(),
    );
    expect(otherUser).toEqual([]);
  });

  it("does not let the worker or public roles call the identity lookups", async () => {
    await expectPgError(sql`SELECT app.resolve_session(${Buffer.alloc(32)})`.execute(worker), RLS_VIOLATION, /permission denied/);
    const publicDb = createDb({ connectionString: urls.public, maxConnections: 1 });
    try {
      await expectPgError(sql`SELECT app.find_user_id_by_identity('a', 'b')`.execute(publicDb), RLS_VIOLATION, /permission denied/);
    } finally {
      await publicDb.destroy();
    }
  });
});

describe("form grants", () => {
  it("rejects a grant to a member of another tenant", async () => {
    await expectPgError(
      withTenant(api, a.id, (trx) =>
        trx
          .insertInto("form_grants")
          .values({
            tenant_id: a.id,
            form_id: a.forms[0]!.id,
            principal_type: "user",
            principal_id: ownerOf(b).id,
            permission: "forms.read",
            created_by: ownerOf(a).id,
          })
          .execute(),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("rejects a grant on another tenant's form", async () => {
    await expectPgError(
      withTenant(api, a.id, (trx) =>
        trx
          .insertInto("form_grants")
          .values({
            tenant_id: a.id,
            form_id: b.forms[0]!.id,
            principal_type: "user",
            principal_id: ownerOf(a).id,
            permission: "forms.read",
            created_by: ownerOf(a).id,
          })
          .execute(),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe("tenant isolation through the worker role", () => {
  it("returns no tenant rows without a context", async () => {
    expect(
      await worker.selectFrom("forms").select("id").where("id", "in", [...formIds(a), ...formIds(b)]).execute(),
    ).toEqual([]);
  });

  it("sees only the tenant recorded for the job", async () => {
    await withTenant(worker, b.id, async (trx) => {
      expect(ids(await trx.selectFrom("forms").select("id").execute())).toEqual(formIds(b));
      expect(await trx.selectFrom("forms").select("id").where("id", "=", a.forms[0]!.id).execute()).toEqual([]);
    });
  });

  it("cannot write tenant tables (read-only until job types grant more)", async () => {
    await expectPgError(
      withTenant(worker, b.id, (trx) =>
        trx.updateTable("forms").set({ name: "x" }).where("id", "=", b.forms[0]!.id).execute(),
      ),
      RLS_VIOLATION,
      /permission denied/,
    );
  });
});

describe("role and policy hardening", () => {
  let admin: Client;
  beforeAll(async () => {
    admin = new Client({ connectionString: urls.admin });
    await admin.connect();
  });
  afterAll(async () => {
    await admin?.end();
  });

  it("gives runtime roles no superuser, BYPASSRLS or role/db creation rights", async () => {
    const names = RUNTIME_ROLE_KEYS.map((k) => DB_ROLES[k]);
    const { rows } = await admin.query(
      "SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = ANY($1)",
      [names],
    );
    expect(rows).toHaveLength(names.length);
    for (const row of rows) {
      expect(row, row.rolname).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    }
  });

  it("makes the owner role own every app object and runtime roles own none", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.owner, row.relname).toBe(DB_ROLES.owner);
  });

  it("enables and forces RLS with a policy on every table holding tenant or user data", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
          AND (c.relname IN ('tenants', 'users', 'auth_sessions')
               OR EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))`,
    );
    expect(rows.map((r) => r.relname).toSorted()).toEqual(
      expect.arrayContaining(["auth_sessions", "form_grants", "forms", "memberships", "tenants", "users"]),
    );
    for (const row of rows) {
      expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      expect(row.policies, row.relname).toBeGreaterThan(0);
    }
  });

  it("gives the public role no access to tenant tables yet", async () => {
    const publicDb = createDb({ connectionString: urls.public, maxConnections: 1 });
    try {
      await expectPgError(publicDb.selectFrom("forms").select("id").execute(), RLS_VIOLATION, /permission denied/);
    } finally {
      await publicDb.destroy();
    }
  });

  it("keeps the migration ledger private to the owner", async () => {
    await expectPgError(sql`SELECT * FROM app.schema_migrations`.execute(api), RLS_VIOLATION, /permission denied/);
  });
});
