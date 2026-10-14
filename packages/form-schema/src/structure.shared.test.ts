import { describe, expect, it } from "vitest";
import example from "../../../contracts/support-request.example.json";
import { DEFINITION_MAX_BYTES, validateStructure } from "./structure.js";
import type { FormDefinition } from "./types.js";

// Compile-time check: the example contract satisfies the TypeScript types.
const typedExample: FormDefinition = example as FormDefinition;

const clone = (): FormDefinition => structuredClone(typedExample);

describe("validateStructure (generated from the JSON Schema contract)", () => {
  it("accepts the example contract", () => {
    expect(validateStructure(example)).toEqual({ ok: true, definition: example });
  });

  it("rejects unknown properties and wrong schema versions", () => {
    const extra = { ...clone(), script: "alert(1)" };
    expect(validateStructure(extra)).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "SCHEMA_ADDITIONALPROPERTIES" })] });
    const version = { ...clone(), schemaVersion: "2.0" };
    expect(validateStructure(version)).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "/schemaVersion" })] });
  });

  it("requires options for choice fields and file limits for file fields", () => {
    const def = clone();
    delete def.fields[2]!.settings.options;
    const result = validateStructure(def);
    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.issues;
    expect(issues.some((i) => i.path === "/fields/2/settings" && i.code === "SCHEMA_REQUIRED")).toBe(true);
  });

  it("enforces the contract's count limits", () => {
    const def = clone();
    def.pages = Array.from({ length: 21 }, (_, i) => ({ id: `page_${i}`, title: "", fieldIds: [] }));
    const result = validateStructure(def);
    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.issues;
    expect(issues.some((i) => i.path === "/pages" && i.code === "SCHEMA_MAXITEMS")).toBe(true);
  });

  it("counts string lengths in code points, as JSON Schema requires", () => {
    const def = clone();
    def.title = "😀".repeat(200); // 200 code points, 400 UTF-16 units
    expect(validateStructure(def).ok).toBe(true);
    def.title = "😀".repeat(201);
    expect(validateStructure(def).ok).toBe(false);
  });

  it("rejects hostile nesting before schema validation, without recursion", () => {
    let deep: unknown = {};
    for (let i = 0; i < 100_000; i++) deep = { not: deep };
    const result = validateStructure({ ...clone(), rules: [{ id: "rule_deep", when: deep, action: {} }] });
    expect(result).toEqual({ ok: false, issues: [expect.objectContaining({ code: "DEFINITION_TOO_DEEP" })] });
  });

  it("rejects definitions over 1 MiB", () => {
    const def = clone();
    def.fields = Array.from({ length: 100 }, (_, i) => ({
      id: `f_${i}`,
      type: "text" as const,
      label: "x",
      helpText: "y".repeat(2000),
      required: false,
      settings: { placeholder: "z".repeat(300) },
    }));
    // ~230 KB is still fine: the byte cap is about total size, not field count.
    expect(JSON.stringify(def).length).toBeLessThan(DEFINITION_MAX_BYTES);
    const huge = { ...def, description: "d".repeat(4000), success: { message: "m" }, extra: "e".repeat(DEFINITION_MAX_BYTES) };
    expect(validateStructure(huge)).toEqual({ ok: false, issues: [expect.objectContaining({ code: "DEFINITION_TOO_LARGE" })] });
  });

  it("rejects non-objects", () => {
    for (const value of [null, 42, "form", []]) expect(validateStructure(value).ok).toBe(false);
  });
});
