import { LOCAL_SEED_TENANTS } from "@workeasy/test-fixtures";
import { z } from "zod";
import { bootstrapDatabase } from "./bootstrap.js";
import { createDb } from "./client.js";
import { migrate } from "./migrate.js";
import { exportDeletionLedger, replayDeletions, type LedgerEntry } from "./repositories/governance.js";
import { countIdentities, linkOrganization, linkUserIdentity, moveIssuer } from "./repositories/workeasy360.js";
import { seedTenantFixture } from "./testing/index.js";

const Url = z.string().url();
const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_ADMIN_URL: Url.optional(),
  DATABASE_MIGRATION_URL: Url,
  DATABASE_URL: Url,
  DATABASE_WORKER_URL: Url,
  DATABASE_PUBLIC_URL: Url,
  /** The issuer WorkEasy360 identities are keyed on (link-workeasy360-user). */
  WORKEASY360_ISSUER: z.preprocess((v) => (v === "" ? undefined : v), Url.optional()),
});
type Env = z.infer<typeof EnvSchema>;

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

async function runBootstrap(env: Env): Promise<void> {
  if (!env.DATABASE_ADMIN_URL) throw new Error("DATABASE_ADMIN_URL is required for bootstrap.");
  const database = databaseName(env.DATABASE_MIGRATION_URL);
  for (const url of [env.DATABASE_URL, env.DATABASE_WORKER_URL, env.DATABASE_PUBLIC_URL]) {
    if (databaseName(url) !== database) throw new Error("All DATABASE_* role URLs must point at the same database.");
  }
  await bootstrapDatabase({
    adminUrl: env.DATABASE_ADMIN_URL,
    database,
    roleUrls: {
      owner: env.DATABASE_MIGRATION_URL,
      api: env.DATABASE_URL,
      worker: env.DATABASE_WORKER_URL,
      public: env.DATABASE_PUBLIC_URL,
    },
  });
  console.log(`bootstrap: roles, database "${database}" and schema ready`);
}

async function runMigrate(env: Env): Promise<void> {
  const { applied, alreadyApplied } = await migrate({ connectionString: env.DATABASE_MIGRATION_URL });
  console.log(`migrate: ${alreadyApplied.length} already applied, ${applied.length} applied now`);
  for (const name of applied) console.log(`  + ${name}`);
}

async function runSeed(env: Env): Promise<void> {
  if (env.NODE_ENV === "production") throw new Error("Refusing to seed fixture data when NODE_ENV=production.");
  const db = createDb({ connectionString: env.DATABASE_URL, maxConnections: 2, applicationName: "workeasy-seed" });
  try {
    for (const tenant of LOCAL_SEED_TENANTS) {
      await seedTenantFixture(db, tenant);
      console.log(`seed: ${tenant.name} (${tenant.members.length} members, ${tenant.forms.length} forms)`);
    }
  } finally {
    await db.destroy();
  }
}

/** `db ledger-export <since>`: prints deletions after <since> (ISO time) as JSON lines (REC-01). */
async function runLedgerExport(env: Env): Promise<void> {
  const since = process.argv[3] ?? "";
  if (Number.isNaN(Date.parse(since))) throw new Error("Usage: db ledger-export <ISO time>");
  const db = createDb({ connectionString: env.DATABASE_MIGRATION_URL, maxConnections: 1, applicationName: "workeasy-ledger" });
  try {
    for (const entry of await exportDeletionLedger(db, since)) process.stdout.write(`${JSON.stringify(entry)}\n`);
  } finally {
    await db.destroy();
  }
}

/** `db ledger-replay < ledger.jsonl`: deletes again everything the ledger lists (REC-01). */
async function runLedgerReplay(env: Env): Promise<void> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  const entries = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LedgerEntry);
  const db = createDb({ connectionString: env.DATABASE_MIGRATION_URL, maxConnections: 1, applicationName: "workeasy-ledger" });
  try {
    const result = await replayDeletions(db, entries);
    console.log(`ledger-replay: ${entries.length} entries read; deleted again ${result.forms} forms and ${result.responses} responses`);
  } finally {
    await db.destroy();
  }
}

/** Runs `fn` with an owner-role connection: operator commands change platform-level rows. */
async function asOwner<T>(env: Env, fn: (db: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const db = createDb({ connectionString: env.DATABASE_MIGRATION_URL, maxConnections: 1, applicationName: "workeasy-operator" });
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

/** `--name value` from the command line, or undefined. */
function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

/**
 * `db link-workeasy360-organization <tenant-id> <organization-id> [--replace-empty]`:
 * sign-ins from that WorkEasy360 organization land in this existing tenant (docs/workeasy360-sso.md).
 */
async function runLinkOrganization(env: Env): Promise<void> {
  const [tenantId, organizationId] = process.argv.slice(3).filter((a) => !a.startsWith("--"));
  if (!tenantId || !organizationId) throw new Error("Usage: db link-workeasy360-organization <tenant-id> <workeasy360-organization-id> [--replace-empty]");
  const result = await asOwner(env, (db) => linkOrganization(db, tenantId, organizationId, { replaceEmpty: process.argv.includes("--replace-empty") }));
  if (!result.changed) console.log(`link-workeasy360-organization: ${result.tenantName} (${result.tenantId}) is already linked to ${result.organizationId}`);
  else {
    console.log(`link-workeasy360-organization: ${result.tenantName} (${result.tenantId}) is now linked to WorkEasy360 organization ${result.organizationId}`);
    if (result.replacedTenantId) console.log(`  the empty tenant ${result.replacedTenantId} a first sign-in had created was unlinked and suspended`);
  }
}

/** `db workeasy360-identities`: users and live sessions per issuer, to see whether an identity move is needed. */
async function runIdentities(env: Env): Promise<void> {
  const counts = await asOwner(env, countIdentities);
  for (const row of counts) console.log(`${row.issuer}	${row.users} user(s)	${row.liveSessions} live session(s)`);
  if (counts.length === 0) console.log("workeasy360-identities: no users yet");
}

/** `db move-identity-issuer --from <issuer> --to <issuer> [--apply]`: the identity-link move of an issuer change. */
async function runMoveIssuer(env: Env): Promise<void> {
  const from = option("from");
  const to = option("to");
  if (!from || !to) throw new Error("Usage: db move-identity-issuer --from <old issuer> --to <new issuer> [--apply]");
  const plan = await asOwner(env, (db) => moveIssuer(db, from, to, process.argv.includes("--apply")));
  console.log(`move-identity-issuer: ${plan.movable} user(s) under ${plan.from}`);
  for (const c of plan.conflicts) console.log(`  conflict: subject ${c.subject} is user ${c.fromUserId} under the old issuer and ${c.toUserId} under the new one`);
  if (plan.conflicts.length > 0) throw new Error("refused: resolve the conflicts first; accounts are never merged automatically");
  console.log(plan.applied ? `  moved to ${plan.to}` : "  dry run: nothing changed (add --apply)");
}

/** `db link-workeasy360-user <user-id> <sub> [--issuer <issuer>]`: an operator vouches an existing account is this WorkEasy360 person. */
async function runLinkUser(env: Env): Promise<void> {
  const [userId, subject] = process.argv.slice(3).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--issuer");
  const issuer = option("issuer") ?? env.WORKEASY360_ISSUER;
  if (!userId || !subject || !issuer) throw new Error("Usage: db link-workeasy360-user <user-id> <workeasy360 sub> [--issuer <issuer>] (or set WORKEASY360_ISSUER)");
  const result = await asOwner(env, (db) => linkUserIdentity(db, userId, issuer, subject));
  console.log(`link-workeasy360-user: user ${result.userId} (was ${result.fromIssuer}) is now ${result.toIssuer} ${result.subject}`);
}

const commands: Record<string, (env: Env) => Promise<void>> = {
  "link-workeasy360-organization": runLinkOrganization,
  "link-workeasy360-user": runLinkUser,
  "move-identity-issuer": runMoveIssuer,
  "workeasy360-identities": runIdentities,
  "ledger-export": runLedgerExport,
  "ledger-replay": runLedgerReplay,
  bootstrap: runBootstrap,
  migrate: runMigrate,
  setup: async (env) => {
    await runBootstrap(env);
    await runMigrate(env);
  },
  // Deploys: provisions roles and the database when an admin URL is given
  // (first deploy, or a password change), otherwise only migrates as the owner.
  deploy: async (env) => {
    if (env.DATABASE_ADMIN_URL) await runBootstrap(env);
    else console.log("deploy: no DATABASE_ADMIN_URL; skipping role and database setup");
    await runMigrate(env);
  },
  seed: runSeed,
};

const command = process.argv[2] ?? "";
const run = commands[command];
if (!run) {
  console.error(`Usage: db <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid database configuration:\n${z.prettifyError(parsed.error)}`);
  process.exit(2);
}

try {
  await run(parsed.data);
} catch (err) {
  console.error(`db ${command} failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
