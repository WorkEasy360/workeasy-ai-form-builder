/**
 * Compiles contracts/form-definition.schema.json into a standalone Ajv
 * validator module, so neither browsers nor servers compile code at runtime
 * (no eval/new Function; compatible with a strict Content-Security-Policy).
 *
 * Run after changing the contract: pnpm --filter @workeasy/form-schema generate
 * A unit test fails when the committed module is stale.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateValidatorSource } from "./validator-source.js";

const target = fileURLToPath(new URL("../src/generated/validate-definition.js", import.meta.url));
writeFileSync(target, generateValidatorSource());
console.log(`wrote ${target}`);
