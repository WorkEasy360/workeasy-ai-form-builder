import { validate } from "./generated/validate-definition.js";
import type { FormDefinition } from "./types";

/** Total definition size limit (docs/03 §3). */
export const DEFINITION_MAX_BYTES = 1024 * 1024;
/**
 * Generic JSON nesting cap applied before schema validation, so hostile input
 * cannot exhaust the stack. Legitimate definitions nest well below this; the
 * engine separately limits condition trees to depth 8.
 */
export const DEFINITION_MAX_NESTING = 40;
/** Cap on reported structural issues; one bad value can yield many schema errors. */
const MAX_REPORTED_ISSUES = 50;

export interface DefinitionIssue {
  /** JSON Pointer to the offending value ("" is the whole definition). */
  path: string;
  code: string;
  message: string;
}

export type StructureResult = { ok: true; definition: FormDefinition } | { ok: false; issues: DefinitionIssue[] };

/** Iterative nesting check: never recurses, whatever the input shape. */
function nestingExceeds(value: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (depth > limit) return true;
    const children = Array.isArray(current) ? current : Object.values(current as Record<string, unknown>);
    for (const child of children) stack.push([child, depth + 1]);
  }
  return false;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Validates a parsed definition against the 1.0 JSON Schema contract, after
 * bounding nesting and size. Semantic checks (references, rules, type-specific
 * settings) are the form engine's job and run after this succeeds.
 */
export function validateStructure(input: unknown): StructureResult {
  if (nestingExceeds(input, DEFINITION_MAX_NESTING)) {
    return { ok: false, issues: [{ path: "", code: "DEFINITION_TOO_DEEP", message: "The definition is nested too deeply." }] };
  }
  const json = JSON.stringify(input) ?? "";
  if (utf8Length(json) > DEFINITION_MAX_BYTES) {
    return { ok: false, issues: [{ path: "", code: "DEFINITION_TOO_LARGE", message: "The definition is larger than 1 MiB." }] };
  }
  if (validate(input)) return { ok: true, definition: input as FormDefinition };
  const issues = (validate.errors ?? []).slice(0, MAX_REPORTED_ISSUES).map((error) => ({
    path: error.instancePath,
    code: `SCHEMA_${error.keyword.toUpperCase()}`,
    message: error.message ?? "is invalid",
  }));
  return { ok: false, issues };
}
