import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { DEFAULT_MIGRATIONS_DIR, migrate } from "./migrate.js";

const urls = inject("testDatabase");
const tempDirs: string[] = [];

async function copyMigrations(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "workeasy-migrations-"));
  tempDirs.push(dir);
  await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("migrate", () => {
  it("is a no-op when every migration is already applied", async () => {
    const result = await migrate({ connectionString: urls.owner });
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(await readdir(DEFAULT_MIGRATIONS_DIR).then((f) => f.filter((n) => n.endsWith(".sql")).sort()));
  });

  it("refuses to run when an applied migration was edited", async () => {
    const dir = await copyMigrations();
    await writeFile(join(dir, "0001_tenancy_foundation.sql"), "-- edited\nSELECT 1;\n");
    await expect(migrate({ connectionString: urls.owner, migrationsDir: dir })).rejects.toThrow(/checksum mismatch/);
  });

  it("refuses to run when an applied migration is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workeasy-migrations-empty-"));
    tempDirs.push(dir);
    await expect(migrate({ connectionString: urls.owner, migrationsDir: dir })).rejects.toThrow(/is missing/);
  });

  it("rolls back a failing migration and records nothing", async () => {
    const dir = await copyMigrations();
    await writeFile(join(dir, "9999_broken.sql"), "CREATE TABLE app.should_not_exist (id int);\nSELECT 1/0;\n");
    await expect(migrate({ connectionString: urls.owner, migrationsDir: dir })).rejects.toThrow(/9999_broken\.sql failed/);
    const again = await migrate({ connectionString: urls.owner });
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).not.toContain("9999_broken.sql");
  });
});
