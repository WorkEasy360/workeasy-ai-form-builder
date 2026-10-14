import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi.js";

describe("OpenAPI contract", () => {
  it("matches contracts/openapi.json (run `pnpm --filter @workeasy/api openapi:write` after changing routes)", () => {
    const committed: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../../contracts/openapi.json", import.meta.url)), "utf8"),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it("documents every organization route with a 404 for invisible organizations", () => {
    const paths = buildOpenApiDocument().paths as Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    for (const [path, item] of Object.entries(paths).filter(([p]) => p.includes("{orgId}"))) {
      for (const [method, operation] of Object.entries(item).filter(([m]) => m !== "parameters")) {
        expect(operation.responses?.["404"], `${method.toUpperCase()} ${path}`).toBeDefined();
      }
    }
  });
});
