import { FIELD_TYPES, type FormDefinition } from "@workeasy/form-schema";
import { blankDefinition, definitionFromTemplate, validateDefinition, validateDraft } from "@workeasy/form-engine";
import { describe, expect, it } from "vitest";
import { FIELD_TYPE_INFO, newId, PALETTE_GROUPS } from "./field-types";
import {
  addField,
  addOption,
  addPage,
  BuilderError,
  duplicateField,
  moveField,
  moveOption,
  movePage,
  removeField,
  removeOption,
  removePage,
  renamePage,
  updateField,
  updateFieldSettings,
  updateFormDetails,
} from "./operations";

const runtime = typeof window === "undefined" ? "node" : "browser";
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,79}$/;

function withEveryFieldType(): FormDefinition {
  let def = blankDefinition("Every type");
  for (const type of FIELD_TYPES) def = addField(def, type, def.pages[0]!.id).definition;
  return def;
}

describe(`builder palette (${runtime})`, () => {
  it("describes every field type exactly once", () => {
    expect(Object.keys(FIELD_TYPE_INFO).toSorted()).toEqual([...FIELD_TYPES].toSorted());
    expect(PALETTE_GROUPS.flatMap((g) => g.types).toSorted()).toEqual([...FIELD_TYPES].toSorted());
  });

  it("adds every field type with defaults that are publishable as they are", () => {
    const def = withEveryFieldType();
    expect(def.fields.map((f) => f.type)).toEqual([...FIELD_TYPES]);
    expect(validateDefinition(def)).toMatchObject({ ok: true });
  });

  it("issues unique opaque IDs that satisfy the contract", () => {
    const def = withEveryFieldType();
    const ids = [...def.fields.map((f) => f.id), ...def.fields.flatMap((f) => (f.settings.options ?? []).map((o) => o.id))];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
    expect(newId("f", new Set())).toMatch(/^f_[a-z0-9]{12}$/);
  });
});

describe(`builder operations (${runtime})`, () => {
  it("never mutates its input", () => {
    const original = definitionFromTemplate("support-request", "Support")!;
    const snapshot = JSON.stringify(original);
    const fieldId = original.fields[0]!.id;
    addField(original, "text", original.pages[0]!.id);
    updateField(original, fieldId, { label: "Changed" });
    removeField(original, "f_category");
    duplicateField(original, "f_category");
    moveField(original, fieldId, 1);
    addPage(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("edits labels, help text and required state", () => {
    let def = definitionFromTemplate("contact", "Contact")!;
    def = updateField(def, "f_name", { label: "Full name", helpText: "As on your ID", required: false });
    expect(def.fields[0]).toMatchObject({ label: "Full name", helpText: "As on your ID", required: false });
    def = updateField(def, "f_name", { helpText: "" });
    expect(def.fields[0]).not.toHaveProperty("helpText");
  });

  it("replaces settings and drops undefined values", () => {
    const def = updateFieldSettings(definitionFromTemplate("contact", "Contact")!, "f_name", { maxLength: 80, minLength: undefined });
    expect(def.fields[0]!.settings).toEqual({ maxLength: 80 });
  });

  it("removes a field together with the rules that depend on it", () => {
    const { definition, removedRules } = removeField(definitionFromTemplate("support-request", "Support")!, "f_category");
    expect(definition.fields.map((f) => f.id)).not.toContain("f_category");
    expect(definition.pages[0]!.fieldIds).not.toContain("f_category");
    expect(removedRules.map((r) => r.id)).toEqual(["rule_technical_details"]);
    expect(definition.rules).toEqual([]);
    expect(validateDefinition(definition)).toMatchObject({ ok: true });
  });

  it("duplicates a field with new field and option IDs, without copying rules", () => {
    const source = definitionFromTemplate("support-request", "Support")!;
    const { definition, fieldId } = duplicateField(source, "f_category");
    const copy = definition.fields.find((f) => f.id === fieldId)!;
    expect(copy.label).toBe("Request category (copy)");
    expect(definition.pages[0]!.fieldIds.indexOf(fieldId)).toBe(definition.pages[0]!.fieldIds.indexOf("f_category") + 1);
    const originalOptions = source.fields.find((f) => f.id === "f_category")!.settings.options!.map((o) => o.id);
    expect(copy.settings.options!.map((o) => o.id).some((id) => originalOptions.includes(id))).toBe(false);
    expect(definition.rules).toHaveLength(1);
    expect(validateDefinition(definition)).toMatchObject({ ok: true });
  });

  it("moves fields within a page and across page boundaries", () => {
    let def = definitionFromTemplate("contact", "Contact")!;
    def = moveField(def, "f_email", -1);
    expect(def.pages[0]!.fieldIds.slice(0, 2)).toEqual(["f_email", "f_name"]);
    const { definition, pageId } = addPage(def);
    def = moveField(definition, "f_consent", 1);
    expect(def.pages.find((p) => p.id === pageId)!.fieldIds).toEqual(["f_consent"]);
    def = moveField(def, "f_consent", -1);
    expect(def.pages[0]!.fieldIds.at(-1)).toBe("f_consent");
    // Moving past the first field of the first page does nothing.
    expect(moveField(def, "f_email", -1)).toBe(def);
  });

  it("adds, renames, reorders and removes options, keeping at least one", () => {
    let def = definitionFromTemplate("support-request", "Support")!;
    const { definition, optionId } = addOption(def, "f_category");
    def = definition;
    expect(def.fields[2]!.settings.options).toHaveLength(3);
    def = moveOption(def, "f_category", optionId, -1);
    expect(def.fields[2]!.settings.options![1]!.id).toBe(optionId);
    def = removeOption(def, "f_category", optionId);
    def = removeOption(def, "f_category", "opt_general");
    expect(() => removeOption(def, "f_category", "opt_technical")).toThrow(BuilderError);
  });

  it("adds, renames, reorders and removes pages, keeping the last page and non-empty pages", () => {
    let def = blankDefinition("Pages");
    const second = addPage(def);
    def = renamePage(second.definition, second.pageId, "Details");
    def = movePage(def, second.pageId, -1);
    expect(def.pages.map((p) => p.title)).toEqual(["Details", ""]);
    const withField = addField(def, "text", second.pageId).definition;
    expect(() => removePage(withField, second.pageId)).toThrow(/Move or delete/);
    def = removePage(def, second.pageId).definition;
    expect(def.pages).toHaveLength(1);
    expect(() => removePage(def, def.pages[0]!.id)).toThrow(/at least one page/);
  });

  it("updates form details", () => {
    const def = updateFormDetails(blankDefinition("Old"), { title: "New", description: "About", successMessage: "Done" });
    expect(def).toMatchObject({ title: "New", description: "About", success: { message: "Done" } });
    expect(updateFormDetails(def, { description: "" })).not.toHaveProperty("description");
    expect(validateDraft(def).ok).toBe(true);
  });
});
