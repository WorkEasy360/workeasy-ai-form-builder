import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateValidatorSource } from "../scripts/validator-source";

describe("generated validator", () => {
  it("is up to date with contracts/form-definition.schema.json (run `pnpm --filter @workeasy/form-schema generate`)", () => {
    const committed = readFileSync(fileURLToPath(new URL("./generated/validate-definition.js", import.meta.url)), "utf8");
    expect(committed.replace(/\r\n/g, "\n")).toBe(generateValidatorSource());
  });
});
