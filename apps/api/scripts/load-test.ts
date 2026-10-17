/**
 * OPS-02 load and failure tests against a running API (docs/performance.md).
 *
 *   pnpm --filter @workeasy/api load-test [--rate 100] [--duration 60]
 *     [--burst-rate 300] [--burst-duration 15] [--outage] [--out report.json]
 *
 * Uses the database URLs and console origin from the root .env, and the API
 * at LOAD_API_URL (default http://127.0.0.1:4000). It creates its own tenant,
 * then measures:
 *   - steady and burst submissions to one hot 100-field form with rules, at a
 *     fixed arrival rate, with 10% of submissions retried concurrently with
 *     the same idempotency key
 *   - the public form fetch
 *   - 200 concurrent submissions racing for a 50-response limit
 *   - with --outage: a 5-second database pause during load (docker pause)
 *   - with --deliveries: an email integration on the hot form, and the time
 *     from acceptance to delivery (needs the worker and Mailpit running)
 * and checks every accepted submission was stored exactly once.
 * Never point it at production: it creates data and pauses the database.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createDb, identityRepo, withTenant } from "@workeasy/database";
import { seedTenantFixture } from "@workeasy/database/testing";
import { createTenantFixture } from "@workeasy/test-fixtures";
import { sql } from "kysely";

const { values: args } = parseArgs({
  options: {
    rate: { type: "string", default: "100" },
    duration: { type: "string", default: "60" },
    "burst-rate": { type: "string", default: "300" },
    "burst-duration": { type: "string", default: "15" },
    outage: { type: "boolean", default: false },
    deliveries: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const API = process.env.LOAD_API_URL ?? "http://127.0.0.1:4000";
const CONSOLE_ORIGIN = process.env.CONSOLE_PUBLIC_URL ?? "http://localhost:3000";
const RESPONDENT_ORIGIN = process.env.RESPONDENT_PUBLIC_URL ?? "http://localhost:3001";
const POSTGRES_CONTAINER = process.env.LOAD_POSTGRES_CONTAINER ?? "workeasy-forms-postgres-1";
const MAX_IN_FLIGHT = 2000;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API)) throw new Error("The load test only runs against a local API.");

const db = createDb({ connectionString: process.env.DATABASE_URL!, maxConnections: 2 });
let cookie = "";

async function consoleCall(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, origin: CONSOLE_ORIGIN, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** 100 questions over 5 pages: 60 text, 20 whole numbers, 20 choices; 10 rules hide follow-ups. */
function bigForm(title: string) {
  const fields: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 100; i++) {
    const id = `f_${i}`;
    if (i % 5 === 3) fields.push({ id, type: "integer", label: `Amount ${i}`, required: false, settings: {} });
    else if (i % 5 === 4) {
      fields.push({ id, type: "radio", label: `Choice ${i}`, required: true, settings: { options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } });
      if (rules.length < 10 && i + 1 < 100) rules.push({ id: `rule_${i}`, when: { fieldId: id, op: "eq", value: "yes" }, action: { type: "setVisibility", targetFieldId: `f_${i + 1}`, onTrue: true, onFalse: false } });
    } else fields.push({ id, type: "text", label: `Question ${i}`, required: i % 10 === 0, settings: { maxLength: 500 } });
  }
  const pages = [0, 1, 2, 3, 4].map((p) => ({ id: `page_${p}`, title: `Part ${p + 1}`, fieldIds: fields.slice(p * 20, p * 20 + 20).map((f) => f.id) }));
  return { title, fields, pages, rules };
}

/** About 10 KiB of answers; choices alternate so some rules hide their follow-up. */
function answers(seed: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) {
    if (i % 5 === 3) out[`f_${i}`] = (seed * 7 + i) % 1000;
    else if (i % 5 === 4) out[`f_${i}`] = (seed + i) % 2 === 0 ? "yes" : "no";
    else out[`f_${i}`] = `Answer ${i} for respondent ${seed}: ${"lorem ipsum dolor sit amet ".repeat(5).slice(0, 120)}`;
  }
  return out;
}

async function publishForm(orgId: string, name: string, policy: Record<string, unknown>) {
  const created = await consoleCall("POST", `/api/v1/organizations/${orgId}/forms`, { name });
  const form = created.form as { id: string; slug: string };
  const draft = created.draft as { revision: number };
  const path = `/api/v1/organizations/${orgId}/forms/${form.id}`;
  // Everything else (schema version, locale, theme, success message) comes from the blank draft.
  const blank = (await consoleCall("GET", `${path}/draft`)) as { definition: Record<string, unknown> };
  const saved = await consoleCall("PUT", `${path}/draft`, { ...blank.definition, ...bigForm(name) }, { "if-match": `"draft-${draft.revision}"` });
  await consoleCall("PATCH", `${path}/access-policy`, policy);
  await consoleCall("POST", `${path}/publish`, undefined, { "if-match": `"draft-${saved.revision as number}"`, "idempotency-key": `load-${randomUUID()}` });
  return form;
}

interface Sample {
  at: number;
  phase: string;
  kind: "session" | "submit" | "form";
  ms: number;
  status: number;
}
const samples: Sample[] = [];
const accepted = new Set<string>();
let dropped = 0;

async function timed(phase: string, kind: Sample["kind"], call: () => Promise<Response>): Promise<Response | undefined> {
  const t0 = performance.now();
  try {
    const res = await call();
    samples.push({ at: Date.now(), phase, kind, ms: performance.now() - t0, status: res.status });
    return res;
  } catch {
    samples.push({ at: Date.now(), phase, kind, ms: performance.now() - t0, status: 0 });
    return undefined;
  }
}

async function respondent(phase: string, slug: string, seed: number): Promise<void> {
  const started = await timed(phase, "session", () => fetch(`${API}/public/v1/forms/${slug}/sessions`, { method: "POST", headers: { origin: RESPONDENT_ORIGIN } }));
  if (!started?.ok) return;
  const session = (await started.json()) as { sessionId: string; capability: string; versionId: string };
  const key = `load-${randomUUID()}`;
  const body = JSON.stringify({ formVersionId: session.versionId, answers: answers(seed) });
  const submit = () =>
    timed(phase, "submit", () =>
      fetch(`${API}/public/v1/sessions/${session.sessionId}/submissions`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.capability}`, "idempotency-key": key, "content-type": "application/json", origin: RESPONDENT_ORIGIN },
        body,
      }),
    );
  // One in ten respondents' clients retry at once with the same key (a flaky network).
  const results = await Promise.all(seed % 10 === 0 ? [submit(), submit()] : [submit()]);
  for (const res of results) {
    if (res?.status === 201) accepted.add(((await res.json()) as { submissionId: string }).submissionId);
  }
}

/** Starts `rate` respondents per second for `seconds`, on schedule regardless of responses. */
async function arrivals(phase: string, slug: string, rate: number, seconds: number, seedBase: number, during?: (elapsed: number) => void) {
  const inFlight = new Set<Promise<void>>();
  const start = performance.now();
  const total = Math.round(rate * seconds);
  for (let i = 0; i < total; i++) {
    const due = start + (i * 1000) / rate;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    during?.((performance.now() - start) / 1000);
    if (inFlight.size >= MAX_IN_FLIGHT) {
      dropped++;
      continue;
    }
    const p = respondent(phase, slug, seedBase + i).finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
  await Promise.all(inFlight);
  return (performance.now() - start) / 1000;
}

function stats(phase: string, kind: Sample["kind"]) {
  const list = samples.filter((s) => s.phase === phase && s.kind === kind);
  const ok = list.filter((s) => s.status >= 200 && s.status < 300).map((s) => s.ms).toSorted((a, b) => a - b);
  const pct = (p: number) => (ok.length ? Math.round(ok[Math.min(ok.length - 1, Math.floor((p / 100) * ok.length))]!) : null);
  const statuses: Record<string, number> = {};
  for (const s of list) statuses[s.status] = (statuses[s.status] ?? 0) + 1;
  return { requests: list.length, ok: ok.length, p50: pct(50), p95: pct(95), p99: pct(99), max: ok.length ? Math.round(ok.at(-1)!) : null, statuses };
}

async function storedCount(tenantId: string, formId: string): Promise<number> {
  return withTenant(db, tenantId, async (trx) => {
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM app.submissions WHERE form_id = ${formId}::uuid`.execute(trx);
    return rows[0]!.n;
  });
}

/** Waits (up to 10 minutes) for the integration's deliveries, then reports acceptance-to-delivery times. */
async function deliveryAges(tenantId: string, integrationId: string) {
  const deadline = Date.now() + 10 * 60_000;
  const pending = () =>
    withTenant(db, tenantId, async (trx) => {
      const { rows } = await sql<{ open: number; total: number }>`
        SELECT count(*) FILTER (WHERE completed_at IS NULL)::int AS open, count(*)::int AS total
          FROM app.deliveries WHERE integration_id = ${integrationId}::uuid`.execute(trx);
      return rows[0]!;
    });
  let state = await pending();
  while ((state.open > 0 || state.total === 0) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    state = await pending();
  }
  return withTenant(db, tenantId, async (trx) => {
    const { rows } = await sql<{ n: number; p50: number; p95: number; p99: number; max: number }>`
      SELECT count(*)::int AS n,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY age))::int AS p50,
             round(percentile_cont(0.95) WITHIN GROUP (ORDER BY age))::int AS p95,
             round(percentile_cont(0.99) WITHIN GROUP (ORDER BY age))::int AS p99,
             round(max(age))::int AS max
        FROM (SELECT extract(epoch FROM d.completed_at - s.received_at) * 1000 AS age
                FROM app.deliveries d JOIN app.submissions s ON s.id = d.submission_id
               WHERE d.integration_id = ${integrationId}::uuid AND d.status = 'succeeded') t`.execute(trx);
    return { unfinished: state.open, deliveries: state.total, ageMs: rows[0] };
  });
}

async function main() {
  const tenant = createTenantFixture(`Load test ${new Date().toISOString().slice(0, 16)}`);
  await seedTenantFixture(db, tenant);
  const ownerId = tenant.members.find((m) => m.role === "owner")!.user.id;
  cookie = `we_session=${(await identityRepo.createSession(db, ownerId, 2 * 60 * 60 * 1000)).token}`;
  const hot = await publishForm(tenant.id, "Load test hot form", { spamProtection: false });
  console.log(`hot form ${hot.slug}`);
  const integration = args.deliveries
    ? ((await consoleCall("POST", `/api/v1/organizations/${tenant.id}/forms/${hot.id}/integrations`, { kind: "email", name: "Load test inbox", recipients: ["load-test@example.test"] })).integration as { id: string })
    : undefined;

  const report: Record<string, unknown> = { api: API, startedAt: new Date().toISOString(), node: process.version };

  // The public form, as a respondent's browser fetches it.
  for (let i = 0; i < 200; i++) await timed("form", "form", () => fetch(`${API}/public/v1/forms/${hot.slug}`));
  report.formFetch = stats("form", "form");

  const rate = Number(args.rate);
  const duration = Number(args.duration);
  const steadySeconds = await arrivals("steady", hot.slug, rate, duration, 0);
  report.steady = { targetRate: rate, seconds: Math.round(steadySeconds), session: stats("steady", "session"), submit: stats("steady", "submit") };
  console.log("steady", JSON.stringify(report.steady));

  const burstRate = Number(args["burst-rate"]);
  const burstSeconds = await arrivals("burst", hot.slug, burstRate, Number(args["burst-duration"]), 10_000_000);
  report.burst = { targetRate: burstRate, seconds: Math.round(burstSeconds), session: stats("burst", "session"), submit: stats("burst", "submit") };
  console.log("burst", JSON.stringify(report.burst));

  if (integration) report.deliveries = await deliveryAges(tenant.id, integration.id);

  const stored = await storedCount(tenant.id, hot.id);
  report.exactlyOnce = { acceptedIds: accepted.size, stored, ok: stored === accepted.size };

  // The last slots of a limited form.
  const limited = await publishForm(tenant.id, "Load test limited form", { spamProtection: false, maxResponses: 50 });
  const before = accepted.size;
  await Promise.all(Array.from({ length: 200 }, (_, i) => respondent("quota", limited.slug, 20_000_000 + i)));
  const quotaStored = await storedCount(tenant.id, limited.id);
  report.quota = { limit: 50, attempts: 200, accepted: accepted.size - before, stored: quotaStored, ok: quotaStored === 50 && accepted.size - before === 50, statuses: stats("quota", "submit").statuses };
  console.log("quota", JSON.stringify(report.quota));

  if (args.outage) {
    const outageForm = await publishForm(tenant.id, "Load test outage form", { spamProtection: false });
    const acceptedBefore = accepted.size;
    let paused = false;
    let resumedAt = 0;
    await arrivals("outage", outageForm.slug, 20, 30, 30_000_000, (t) => {
      if (!paused && t >= 10) {
        execFileSync("docker", ["pause", POSTGRES_CONTAINER]);
        paused = true;
        setTimeout(() => {
          execFileSync("docker", ["unpause", POSTGRES_CONTAINER]);
          resumedAt = Date.now();
        }, 5000);
      }
    });
    const after = samples.filter((s) => s.phase === "outage" && s.kind === "submit" && s.at > resumedAt);
    const firstOk = after.filter((s) => s.status === 201).map((s) => s.at).toSorted((a, b) => a - b)[0];
    const outageStored = await storedCount(tenant.id, outageForm.id);
    report.outage = {
      pausedSeconds: 5,
      submit: stats("outage", "submit"),
      session: stats("outage", "session"),
      firstAcceptedAfterResumeMs: firstOk ? firstOk - resumedAt : null,
      exactlyOnce: { accepted: accepted.size - acceptedBefore, stored: outageStored, ok: outageStored === accepted.size - acceptedBefore },
    };
    console.log("outage", JSON.stringify(report.outage));
  }

  report.droppedByClient = dropped;
  report.finishedAt = new Date().toISOString();
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await db.destroy();
}

await main();
