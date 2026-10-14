import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findLeaks, parseEnv } from "./client-bundle-check.mjs";

type Finding = { file: string; problem: string };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function bundle(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-check-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const env = parseEnv("SESSION_SECRET=super-secret-session-value\nOIDC_CLIENT_SECRET=client-secret-value\nAPI_PORT=4000\n");

describe("client bundle check", () => {
  it("passes clean bundles", () => {
    expect(findLeaks([bundle({ "chunks/a.js": "console.log('hello')" })], env)).toEqual([]);
  });

  it("finds secret values, server-only setting names and credentialed database URLs", () => {
    const dir = bundle({
      "chunks/a.js": 'const s="super-secret-session-value";',
      "chunks/b.js": "process.env.DATABASE_URL",
      "chunks/c.js": 'fetch("postgres://user:pass@db/forms")',
    });
    const problems = (findLeaks([dir], env) as Finding[]).map((f) => f.problem).toSorted();
    expect(problems).toEqual([
      "contains a database URL with credentials",
      "contains the value of SESSION_SECRET",
      "mentions server-only setting DATABASE_URL",
    ]);
  });

  it("fails when there is nothing built to check", () => {
    expect(findLeaks([join(tmpdir(), "does-not-exist-bundle-dir")], env)).toHaveLength(1);
  });
});
