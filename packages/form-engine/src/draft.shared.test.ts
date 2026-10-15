import { describe, expect, it } from "vitest";
import { blankDefinition, definitionFromTemplate } from "./templates";
import { validateDraft } from "./validate-definition";

const runtime = typeof window === "undefined" ? "node" : "browser";

describe(`validateDraft (${runtime})`, () => {
  it("accepts a blank draft and reports that it has no fields yet", () => {
    const result = validateDraft(blankDefinition("New form"));
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => `${i.path}:${i.code}`)).toEqual(["/fields:SCHEMA_MINITEMS"]);
  });

  it("accepts a complete draft with no issues", () => {
    expect(validateDraft(definitionFromTemplate("contact", "Contact"))).toMatchObject({ ok: true, issues: [] });
  });

  it("keeps semantic problems as issues instead of rejecting the save", () => {
    const draft = definitionFromTemplate("contact", "Contact")!;
    draft.fields[0]!.settings = { minLength: 10, maxLength: 5 };
    const result = validateDraft(draft);
    expect(result.ok).toBe(true);
    expect(result.issues.map((i) => i.code)).toEqual(["INVERTED_RANGE"]);
  });

  it("rejects malformed drafts so stored drafts are always loadable", () => {
    const missingPages = { ...blankDefinition("x"), pages: [] };
    expect(validateDraft(missingPages).ok).toBe(false);
    const unknownType = definitionFromTemplate("contact", "Contact")!;
    (unknownType.fields[0] as { type: string }).type = "script";
    expect(validateDraft(unknownType).ok).toBe(false);
    const noFieldsAndBadTheme = { ...blankDefinition("x"), theme: { accent: "red" } };
    expect(validateDraft(noFieldsAndBadTheme).ok).toBe(false);
    for (const value of [null, [], "draft", { schemaVersion: "1.0" }]) expect(validateDraft(value).ok).toBe(false);
  });
});
