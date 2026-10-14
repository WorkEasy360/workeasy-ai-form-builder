// Fails when a server-only secret, or the name of a server-only setting,
// appears in a browser bundle (docs/06 §9: "Production build verifies no
// server-only credentials in client bundles"). Run after `pnpm build`:
//
//   node scripts/client-bundle-check.mjs
//
// Secret values are read from .env when present, otherwise from .env.example,
// so CI checks that the example credentials never reach a client bundle.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Settings that only server processes may know. */
export const SERVER_ONLY_SETTINGS = [
  "DATABASE_URL",
  "DATABASE_ADMIN_URL",
  "DATABASE_MIGRATION_URL",
  "DATABASE_WORKER_URL",
  "DATABASE_PUBLIC_URL",
  "POSTGRES_PASSWORD",
  "OIDC_CLIENT_SECRET",
  "SESSION_SECRET",
  "OBJECT_STORAGE_SECRET_KEY",
  "OBJECT_STORAGE_ACCESS_KEY",
];

const PATTERNS = [
  { name: "database URL with credentials", regex: /postgres(?:ql)?:\/\/[^\s"'`/:@]+:[^\s"'`@]+@/ },
  { name: "private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(m?js|css|html|json|map)$/.test(entry.name)) yield path;
  }
}

/** Returns findings for every client asset directory; empty when clean. */
export function findLeaks(assetDirs, env) {
  const secrets = SERVER_ONLY_SETTINGS.map((key) => [key, env[key]]).filter(([, value]) => typeof value === "string" && value.length >= 8);
  const findings = [];
  for (const dir of assetDirs) {
    if (!existsSync(dir)) {
      findings.push({ file: dir, problem: "client asset directory not found (run `pnpm build` first)" });
      continue;
    }
    for (const file of walk(dir)) {
      const content = readFileSync(file, "utf8");
      for (const key of SERVER_ONLY_SETTINGS) {
        if (content.includes(key)) findings.push({ file, problem: `mentions server-only setting ${key}` });
      }
      for (const [key, value] of secrets) {
        if (content.includes(value)) findings.push({ file, problem: `contains the value of ${key}` });
      }
      for (const { name, regex } of PATTERNS) {
        if (regex.test(content)) findings.push({ file, problem: `contains a ${name}` });
      }
    }
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const envFile = existsSync(join(root, ".env")) ? ".env" : ".env.example";
  const env = { ...parseEnv(readFileSync(join(root, envFile), "utf8")), ...process.env };
  const dirs = ["apps/console/.next/static", "apps/respondent/.next/static"].map((d) => join(root, d));
  const findings = findLeaks(dirs, env);
  if (findings.length > 0) {
    for (const f of findings) console.error(`LEAK ${relative(root, f.file)}: ${f.problem}`);
    process.exit(1);
  }
  console.log(`client bundles clean (checked against ${envFile}): ${dirs.map((d) => relative(root, d)).join(", ")}`);
}
