import { definitionFromTemplate, evaluate, validateDefinition } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import { describe, expect, it } from "vitest";
import { addField, addPage, moveField, moveFieldToPage, updateField } from "./operations";
import {
  conditionFieldsFor,
  defaultLeaf,
  fieldRuleOf,
  fromSimpleCondition,
  guardRuleEdit,
  operatorsFor,
  removeRule,
  ruleProblems,
  setFieldRule,
  setSkipRule,
  skipRuleOf,
  skipTargetsFor,
  toSimpleCondition,
} from "./rules";

const runtime = typeof window === "undefined" ? "node" : "browser";

/** Contact template: f_name, f_email, f_message, f_consent on one page. */
const contact = () => definitionFromTemplate("contact", "Contact")!;

/** Three pages: f_type (radio yes/no) | f_detail (text, required) | f_end (text). */
function threePages(): FormDefinition {
  let def = contact();
  def = { ...def, fields: [], pages: [{ id: "page_1", title: "", fieldIds: [] }], rules: [] };
  const radio = addField(def, "radio", "page_1");
  def = updateField(radio.definition, radio.fieldId, { label: "Have an account?" });
  const p2 = addPage(def);
  const detail = addField(p2.definition, "text", p2.pageId);
  def = updateField(detail.definition, detail.fieldId, { label: "Account ID", required: true });
  const p3 = addPage(def);
  def = addField(p3.definition, "text", p3.pageId).definition;
  return def;
}

describe(`rule helpers (${runtime})`, () => {
  it("offers only earlier questions as conditions, never the question itself", () => {
    const def = contact();
    expect(conditionFieldsFor(def, { kind: "field", id: "f_message" }).map((f) => f.id)).toEqual(["f_name", "f_email"]);
    expect(conditionFieldsFor(def, { kind: "field", id: "f_name" })).toEqual([]);
    expect(conditionFieldsFor(def, { kind: "page", id: def.pages[0]!.id }).map((f) => f.id)).toEqual([
      "f_name",
      "f_email",
      "f_message",
      "f_consent",
    ]);
  });

  it("offers operators that suit the question type", () => {
    const def = definitionFromTemplate("support-request", "S")!;
    expect(operatorsFor(def.fields.find((f) => f.id === "f_category")!)).toEqual(["eq", "neq", "isEmpty", "isNotEmpty"]);
    expect(operatorsFor(def.fields.find((f) => f.id === "f_name")!)).toContain("contains");
  });

  it("only offers later pages (beyond the next one) as skip targets", () => {
    const def = threePages();
    expect(skipTargetsFor(def, def.pages[0]!.id).map((p) => p.id)).toEqual([def.pages[2]!.id]);
    expect(skipTargetsFor(def, def.pages[1]!.id)).toEqual([]);
  });

  it("round-trips simple conditions and recognises nested ones as not editable", () => {
    const leafA = { fieldId: "f_name", op: "isNotEmpty" } as const;
    const leafB = { fieldId: "f_email", op: "contains", value: "@acme" } as const;
    expect(toSimpleCondition(fromSimpleCondition({ match: "any", items: [leafA, leafB] }))).toEqual({ match: "any", items: [leafA, leafB] });
    expect(fromSimpleCondition({ match: "all", items: [leafA] })).toEqual(leafA);
    expect(toSimpleCondition({ not: leafA })).toBeUndefined();
    expect(toSimpleCondition({ all: [{ any: [leafA] }] })).toBeUndefined();
    expect(() => fromSimpleCondition({ match: "all", items: [] })).toThrow(/at least one comparison/);
  });
});

describe(`rule operations (${runtime})`, () => {
  it("creates one valid rule per question property and updates it in place", () => {
    let def = contact();
    const created = setFieldRule(def, "f_message", "visibility", { fieldId: "f_email", op: "isNotEmpty" }, true);
    def = created.definition;
    expect(validateDefinition(def)).toMatchObject({ ok: true });
    const updated = setFieldRule(def, "f_message", "visibility", { fieldId: "f_name", op: "isEmpty" }, false);
    expect(updated.ruleId).toBe(created.ruleId);
    expect(updated.definition.rules).toHaveLength(1);
    expect(fieldRuleOf(updated.definition, "f_message", "visibility")?.action).toEqual({
      type: "setVisibility",
      targetFieldId: "f_message",
      onTrue: false,
      onFalse: true,
    });
    expect(removeRule(updated.definition, created.ruleId).rules).toEqual([]);
  });

  it("refuses a rule that depends on the question it controls", () => {
    const result = guardRuleEdit(setFieldRule(contact(), "f_email", "required", { fieldId: "f_email", op: "isEmpty" }, true));
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/cannot depend on the field it controls/) });
  });

  it("refuses a rule that would create a cycle", () => {
    let def = setFieldRule(contact(), "f_email", "visibility", { fieldId: "f_name", op: "isNotEmpty" }, true).definition;
    const cyclic = guardRuleEdit(setFieldRule(def, "f_name", "visibility", { fieldId: "f_email", op: "isNotEmpty" }, true));
    expect(cyclic).toMatchObject({ ok: false, message: expect.stringMatching(/only depend on fields before it/) });
    // Reordering can still break a rule later; the problem is then reported, not hidden.
    def = moveField(def, "f_email", -1);
    const ruleId = fieldRuleOf(def, "f_email", "visibility")!.id;
    expect(ruleProblems(def, ruleId).map((i) => i.code)).toEqual(["RULE_REFERENCES_LATER_FIELD"]);
  });

  it("refuses values that do not suit the question", () => {
    const support = definitionFromTemplate("support-request", "S")!;
    const bad = guardRuleEdit(setFieldRule(support, "f_details", "required", { fieldId: "f_category", op: "eq", value: "opt_missing" }, true));
    expect(bad).toMatchObject({ ok: false, message: expect.stringMatching(/not an option/) });
    const badOp = guardRuleEdit(setFieldRule(support, "f_details", "required", { fieldId: "f_category", op: "gt", value: "opt_general" }, true));
    expect(badOp.ok).toBe(false);
  });

  it("keeps skips forward and allows one per page", () => {
    const def = threePages();
    const [p1, p2, p3] = def.pages;
    const radio = def.fields[0]!;
    const skip = guardRuleEdit(setSkipRule(def, p1!.id, p3!.id, { fieldId: radio.id, op: "eq", value: radio.settings.options![1]!.id }));
    expect(skip.ok).toBe(true);
    const backward = guardRuleEdit(setSkipRule(def, p3!.id, p1!.id, defaultLeaf(radio)));
    expect(backward).toMatchObject({ ok: false, message: expect.stringMatching(/only move forward/) });
    if (!skip.ok) throw new Error(skip.message);
    const replaced = setSkipRule(skip.definition, p1!.id, p3!.id, defaultLeaf(radio));
    expect(replaced.definition.rules).toHaveLength(1);
    expect(skipRuleOf(replaced.definition, p1!.id)?.when).toEqual(defaultLeaf(radio));
    expect(guardRuleEdit(setSkipRule(def, p2!.id, p3!.id, { fieldId: def.fields[2]!.id, op: "isEmpty" })).ok).toBe(false);
  });
});

describe(`rules end to end with the engine (${runtime})`, () => {
  it("never lets a hidden required question block a submission", () => {
    const def = threePages();
    const [radio, detail] = def.fields;
    const [yes, no] = radio!.settings.options!;
    // Show "Account ID" (required) only when the answer is "yes".
    const ruled = guardRuleEdit(setFieldRule(def, detail!.id, "visibility", { fieldId: radio!.id, op: "eq", value: yes!.id }, true));
    expect(ruled.ok).toBe(true);
    if (!ruled.ok) return;
    const hidden = evaluate(ruled.definition, { [radio!.id]: no!.id, [detail!.id]: "sent anyway" });
    expect(hidden.errors).toEqual([]);
    expect(hidden.answers).not.toHaveProperty(detail!.id);
    const shown = evaluate(ruled.definition, { [radio!.id]: yes!.id });
    expect(shown.errors).toEqual([expect.objectContaining({ fieldId: detail!.id, code: "REQUIRED" })]);
  });

  it("skips a required page entirely when routed past it", () => {
    const def = threePages();
    const [p1, , p3] = def.pages;
    const [radio, detail] = def.fields;
    const no = radio!.settings.options![1]!;
    const skip = guardRuleEdit(setSkipRule(def, p1!.id, p3!.id, { fieldId: radio!.id, op: "eq", value: no.id }));
    if (!skip.ok) throw new Error(skip.message);
    const result = evaluate(skip.definition, { [radio!.id]: no.id });
    expect(result.reachablePageIds).toEqual([p1!.id, p3!.id]);
    expect(result.errors).toEqual([]);
    expect(result.visibleFieldIds).not.toContain(detail!.id);
  });

  it("moving a question to an earlier page keeps condition choices consistent", () => {
    const def = threePages();
    const [, p2] = def.pages;
    const last = def.fields[2]!;
    const moved = moveFieldToPage(def, last.id, p2!.id);
    expect(conditionFieldsFor(moved, { kind: "page", id: p2!.id }).map((f) => f.id)).toContain(last.id);
  });
});
