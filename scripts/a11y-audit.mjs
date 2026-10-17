// UX-01 accessibility and mobile audit against a running local stack
// (`pnpm infra:up`, `pnpm db:seed`, `pnpm dev`). Signs in to the console,
// creates and publishes a form, then on every console page and the
// respondent form, at desktop and phone widths:
//   - runs axe-core (WCAG 2.0/2.1/2.2 A and AA rules, plus best practices
//     reported as advisory), in light and dark mode
//   - checks that the page does not scroll sideways
// and walks two keyboard-only journeys: adding fields in the builder and
// filling and submitting the public form.
//
// Usage: node scripts/a11y-audit.mjs [--out <dir>]
// Signs in with the local Dex fixture account unless A11Y_EMAIL and
// A11Y_PASSWORD are set. Exits 1 when a serious or critical issue is found.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");
const CONSOLE = process.env.A11Y_CONSOLE_URL ?? "http://localhost:3000";
const RESPONDENT = process.env.A11Y_RESPONDENT_URL ?? "http://localhost:3001";
const local = (url) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);
if (!process.env.A11Y_EMAIL && !local(CONSOLE)) throw new Error("Set A11Y_EMAIL and A11Y_PASSWORD for a non-local console.");
const EMAIL = process.env.A11Y_EMAIL ?? "asha@acme.test";
const PASSWORD = process.env.A11Y_PASSWORD ?? "local-dev-password";
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
if (OUT) mkdirSync(OUT, { recursive: true });

const VIEWPORTS = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 }, "desktop-dark": { width: 1366, height: 900 } };
const BLOCKING = new Set(["serious", "critical"]);
const findings = [];
const checks = [];

function record(page, viewport, kind, detail) {
  findings.push({ page, viewport, kind, ...detail });
}

async function audit(page, name, viewport) {
  await page.addScriptTag({ path: AXE_PATH });
  const result = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
    return r.violations.map((v) => ({
      id: v.id,
      // Best-practice rules are reported but never block.
      impact: v.tags.some((t) => t.startsWith("wcag")) ? v.impact : "advisory",
      help: v.help,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
  });
  for (const v of result) record(name, viewport, "axe", v);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) record(name, viewport, "overflow", { id: "horizontal-scroll", impact: "serious", help: `Page scrolls sideways by ${overflow}px` });
  checks.push(`${name} @ ${viewport}`);
  if (OUT) await page.screenshot({ path: `${OUT}/${name.replace(/[^a-z0-9]+/gi, "-")}-${viewport}.png`, fullPage: true });
}

async function settle(page, selector) {
  if (selector) await page.waitForSelector(selector, { timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
}

const browser = await chromium.launch();
let exitCode = 0;
try {
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  // Sign in through the identity provider.
  await page.goto(`${CONSOLE}/auth/login`);
  if (await page.locator("text=/Log in with Email/i").count()) await page.locator("text=/Log in with Email/i").first().click();
  await page.locator('input[name="login"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/o\/[^/]+\/forms/);
  const orgId = page.url().match(/\/o\/([^/]+)/)[1];
  const api = `${CONSOLE}/api/v1/organizations/${orgId}`;
  const headers = { Origin: CONSOLE, "content-type": "application/json" };

  // A published contact form to audit.
  const created = await (await page.request.post(`${api}/forms`, { headers, data: { name: "Accessibility audit", template: "contact" } })).json();
  const formId = created.form.id;
  const published = await page.request.post(`${api}/forms/${formId}/publish`, {
    headers: { ...headers, "If-Match": `"draft-${created.draft.revision}"`, "Idempotency-Key": `a11y-${randomUUID()}` },
  });
  if (published.status() !== 201) throw new Error(`Publishing failed: ${published.status()}`);
  const slug = created.form.slug;

  // Keyboard journey 1: the public form, filled and submitted without a mouse.
  const respondent = await (await browser.newContext({ viewport: VIEWPORTS.desktop })).newPage();
  await respondent.goto(`${RESPONDENT}/f/${slug}`);
  await settle(respondent, "form");
  const keyboardFill = async () => {
    await respondent.keyboard.press("Tab");
    for (const [type, value] of [["text", "Ada Lovelace"], ["email", "ada@example.test"], ["textarea", "Testing with the keyboard only."]]) {
      while (!(await respondent.evaluate((t) => (t === "textarea" ? document.activeElement?.tagName === "TEXTAREA" : document.activeElement?.getAttribute("type") === t), type))) {
        await respondent.keyboard.press("Tab");
      }
      await respondent.keyboard.type(value);
    }
    while ((await respondent.evaluate(() => document.activeElement?.getAttribute("type"))) !== "checkbox") await respondent.keyboard.press("Tab");
    await respondent.keyboard.press("Space");
    while ((await respondent.evaluate(() => document.activeElement?.getAttribute("type"))) !== "submit") await respondent.keyboard.press("Tab");
  };
  await audit(respondent, "respondent form", "desktop");
  await keyboardFill();
  // Spam protection rejects forms filled faster than a person could.
  await respondent.waitForTimeout(2500);
  await respondent.keyboard.press("Enter");
  const submitted = await respondent
    .waitForSelector("text=/thank|received|submitted/i", { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!submitted) record("respondent form", "desktop", "keyboard", { id: "keyboard-submit", impact: "critical", help: "Form could not be submitted with the keyboard" });
  await audit(respondent, "respondent confirmation", "desktop");
  await respondent.setViewportSize(VIEWPORTS.phone);
  await respondent.goto(`${RESPONDENT}/f/${slug}`);
  await settle(respondent, "form");
  await audit(respondent, "respondent form", "phone");
  await respondent.setViewportSize(VIEWPORTS["desktop-dark"]);
  await respondent.emulateMedia({ colorScheme: "dark" });
  await respondent.reload();
  await settle(respondent, "form");
  await audit(respondent, "respondent form", "desktop-dark");

  // Keyboard journey 2: adding a field in the builder from the palette.
  await page.goto(`${CONSOLE}/o/${orgId}/forms/${formId}/build`);
  await settle(page, ".b-tiles");
  const before = await page.locator(".b-card").count();
  await page.locator(".b-tile").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  if ((await page.locator(".b-card").count()) !== before + 1) {
    record("builder", "desktop", "keyboard", { id: "keyboard-add-field", impact: "critical", help: "Enter on a palette tile did not add a field" });
  }

  const responses = await (await page.request.get(`${api}/forms/${formId}/submissions?limit=1`)).json().catch(() => ({}));
  const submissionId = responses.items?.[0]?.id;
  const pages = [
    ["organizations", `${CONSOLE}/`, "main"],
    ["forms list", `${CONSOLE}/o/${orgId}/forms`, "table, .c-empty"],
    ["create form", `${CONSOLE}/o/${orgId}/forms/new`, "form"],
    ["builder", `${CONSOLE}/o/${orgId}/forms/${formId}/build`, ".b-tiles"],
    ["preview", `${CONSOLE}/o/${orgId}/forms/${formId}/preview`, ".b-shell"],
    ["responses", `${CONSOLE}/o/${orgId}/forms/${formId}/responses`, "main"],
    ...(submissionId ? [["response detail", `${CONSOLE}/o/${orgId}/forms/${formId}/responses/${submissionId}`, "main"]] : []),
    ["analytics", `${CONSOLE}/o/${orgId}/forms/${formId}/analytics`, "main"],
    ["integrations", `${CONSOLE}/o/${orgId}/forms/${formId}/integrations`, "main"],
    ["form settings", `${CONSOLE}/o/${orgId}/forms/${formId}/settings`, ".s-nav"],
    ["members", `${CONSOLE}/o/${orgId}/members`, "table"],
    ["ai settings", `${CONSOLE}/o/${orgId}/ai`, "main"],
    ["audit log", `${CONSOLE}/o/${orgId}/audit`, "main"],
    ["background jobs", `${CONSOLE}/o/${orgId}/jobs`, "main"],
    ["invitation", `${CONSOLE}/invite/${"x".repeat(43)}`, ".c-card"],
    ["help", `${CONSOLE}/o/${orgId}/help`, "#create"],
  ];
  for (const [viewport, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    await page.emulateMedia({ colorScheme: viewport.endsWith("-dark") ? "dark" : "light" });
    for (const [name, url, selector] of pages) {
      await page.goto(url);
      await settle(page, selector);
      await audit(page, name, viewport);
    }
  }

  // Clean up: archive the audit form so it does not clutter the list.
  await page.request.post(`${api}/forms/${formId}/archive`, { headers });
} catch (err) {
  console.error("Audit could not finish:", err.message.split("\n")[0]);
  exitCode = 2;
} finally {
  await browser.close();
}

const blocking = findings.filter((f) => BLOCKING.has(f.impact));
const report = { checkedAt: new Date().toISOString(), checks, findings };
if (OUT) writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`Checked ${checks.length} page views and the keyboard journeys.`);
for (const f of findings) console.log(`[${f.impact}] ${f.page} @ ${f.viewport}: ${f.id} - ${f.help}${f.targets ? `\n    ${f.targets.join("\n    ")}` : ""}`);
if (exitCode) console.log("The audit did not finish, so these results are incomplete.");
else console.log(blocking.length === 0 ? "No serious or critical issues." : `${blocking.length} serious or critical issue(s).`);
process.exit(exitCode || (blocking.length > 0 ? 1 : 0));
