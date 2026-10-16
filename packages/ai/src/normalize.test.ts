import { blankDefinition } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import { describe, expect, it } from "vitest";
import { proposalFromReply } from "./normalize.js";

const base = (): FormDefinition => ({ ...blankDefinition("Draft"), locale: "en-GB" });

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: "Event sign-up",
    pages: [{ id: "p1", title: "", fieldIds: ["name", "diet", "notes"] }],
    fields: [
      { id: "name", type: "text", label: "Name", required: true, privacy: "personal", settings: {} },
      { id: "diet", type: "radio", label: "Diet", required: true, settings: { options: [{ id: "veg", label: "Vegetarian" }, { id: "any", label: "Anything" }] } },
      { id: "notes", type: "textarea", label: "Dietary notes", required: false, settings: {} },
    ],
    rules: [{ id: "r1", when: { fieldId: "diet", op: "eq", value: "veg" }, action: { type: "setVisibility", targetFieldId: "notes", onTrue: true, onFalse: false } }],
    success: { message: "See you there." },
    ...over,
  });

describe("proposalFromReply", () => {
  it("assigns server IDs and rewrites every reference, keeping format, locale and theme from the draft", () => {
    const result = proposalFromReply(reply(), base(), "create");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const def = result.definition;
    const [name, diet, notes] = def.fields;
    for (const f of def.fields) expect(f.id).toMatch(/^f_[0-9a-f]{10}$/);
    expect(def.pages[0]!.id).toMatch(/^p_[0-9a-f]{10}$/);
    expect(def.pages[0]!.fieldIds).toEqual([name!.id, diet!.id, notes!.id]);
    const veg = diet!.settings.options![0]!.id;
    expect(veg).toMatch(/^o_[0-9a-f]{10}$/);
    expect(def.rules[0]).toMatchObject({ when: { fieldId: diet!.id, op: "eq", value: veg }, action: { targetFieldId: notes!.id } });
    expect(def).toMatchObject({ schemaVersion: "1.0", locale: "en-GB", theme: base().theme, title: "Event sign-up", success: { message: "See you there." } });
    expect(result.summary).toMatchObject({ fields: 3, pages: 1, rules: 1, removedFieldIds: [], warnings: [] });
    expect(result.summary.addedFieldIds).toHaveLength(3);
  });

  it("keeps the IDs of fields, options and pages that exist in the draft when editing, and reports removals and type changes", () => {
    const draft = base();
    draft.fields = [
      { id: "f_keep", type: "radio", label: "Size", required: true, settings: { options: [{ id: "o_s", label: "S" }] } },
      { id: "f_gone", type: "text", label: "Old", required: false, settings: {} },
      { id: "f_kind", type: "text", label: "Age", required: false, settings: {} },
    ];
    draft.pages = [{ id: "p_main", title: "", fieldIds: ["f_keep", "f_gone", "f_kind"] }];
    const edited = JSON.stringify({
      title: "Sizes",
      pages: [{ id: "p_main", title: "", fieldIds: ["f_keep", "f_kind", "extra"] }],
      fields: [
        { id: "f_keep", type: "radio", label: "Size", required: true, settings: { options: [{ id: "o_s", label: "S" }, { id: "m", label: "M" }] } },
        { id: "f_kind", type: "integer", label: "Age", required: false, settings: {} },
        { id: "extra", type: "email", label: "Email", required: false, settings: {} },
      ],
      rules: [],
      success: { message: "Thanks" },
    });
    const result = proposalFromReply(edited, draft, "edit");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.pages[0]!.id).toBe("p_main");
    expect(result.definition.fields.map((f) => f.id).slice(0, 2)).toEqual(["f_keep", "f_kind"]);
    expect(result.definition.fields[0]!.settings.options!.map((o) => o.id)[0]).toBe("o_s");
    expect(result.definition.fields[0]!.settings.options![1]!.id).toMatch(/^o_/);
    expect(result.summary).toMatchObject({ removedFieldIds: ["f_gone"], typeChangedFieldIds: ["f_kind"], warnings: ["removes_fields", "changes_field_types"] });
  });

  it("does not let a create keep the draft's IDs", () => {
    const draft = base();
    draft.fields = [{ id: "name", type: "text", label: "Name", required: true, settings: {} }];
    const result = proposalFromReply(reply(), draft, "create");
    expect(result.ok && result.definition.fields[0]!.id).not.toBe("name");
  });

  it.each([
    ["not JSON", "here is your form: {", "NOT_JSON"],
    ["an array", "[]", "NOT_AN_OBJECT"],
    ["HTML in a label", reply({ title: "<b>Sign up</b>" }), "MARKUP_NOT_ALLOWED"],
    ["a script URL", reply({ success: { message: "javascript:alert(1)" } }), "MARKUP_NOT_ALLOWED"],
    ["too many fields", reply({ fields: Array.from({ length: 51 }, (_, i) => ({ id: `x${i}`, type: "text", label: "X", required: false, settings: {} })) }), "TOO_MANY_FIELDS"],
    ["duplicate IDs", reply({ fields: [{ id: "a1", type: "text", label: "A", required: false, settings: {} }, { id: "a1", type: "text", label: "B", required: false, settings: {} }] }), "DUPLICATE_ID"],
  ])("rejects %s", (_name, text, code) => {
    const result = proposalFromReply(text, base(), "create");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((i) => i.code)).toContain(code);
  });

  it("rejects references to fields that do not exist and rule cycles, through the shared validator", () => {
    const dangling = proposalFromReply(reply({ pages: [{ id: "p1", title: "", fieldIds: ["name", "diet", "notes", "ghost"] }] }), base(), "create");
    expect(dangling.ok).toBe(false);
    const cyclic = proposalFromReply(
      reply({
        rules: [
          { id: "r1", when: { fieldId: "name", op: "isNotEmpty" }, action: { type: "setVisibility", targetFieldId: "notes", onTrue: true, onFalse: false } },
          { id: "r2", when: { fieldId: "notes", op: "isNotEmpty" }, action: { type: "setVisibility", targetFieldId: "name", onTrue: true, onFalse: false } },
        ],
      }),
      base(),
      "create",
    );
    expect(cyclic.ok).toBe(false);
  });

  it("accepts the form wrapped in a single key and flags consent wording for review", () => {
    const wrapped = JSON.stringify({
      form: JSON.parse(
        reply({
          pages: [{ id: "p1", title: "", fieldIds: ["name", "ok"] }],
          fields: [
            { id: "name", type: "text", label: "Name", required: true, settings: {} },
            { id: "ok", type: "consent", label: "I agree to be contacted", required: true, settings: { consentTextVersion: "v1" } },
          ],
          rules: [],
        }),
      ),
    });
    const result = proposalFromReply(wrapped, base(), "create");
    expect(result.ok && result.summary.warnings).toEqual(["review_consent_wording"]);
  });
});
