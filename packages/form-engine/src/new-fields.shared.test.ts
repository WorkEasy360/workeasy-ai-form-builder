import type { Field, FormDefinition } from "@workeasy/form-schema";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate";
import { FIELD_REGISTRY, isEmptyValue, isLayoutType } from "./fields";
import { blankDefinition } from "./templates";
import { validateDefinition } from "./validate-definition";

const runtime = typeof window === "undefined" ? "node" : "browser";

function formWith(fields: Field[], rules: FormDefinition["rules"] = []): FormDefinition {
  const def = blankDefinition("New fields");
  def.fields = fields;
  def.pages = [{ id: "page_1", title: "", fieldIds: fields.map((f) => f.id) }];
  def.rules = rules;
  return def;
}

const f = (id: string, type: Field["type"], extra: Partial<Field> = {}): Field => ({ id, type, label: id, required: false, settings: {}, ...extra });

describe(`name, address, date and time, slider and layout items (${runtime})`, () => {
  const def = formWith([
    f("f_intro", "section", { label: "About you", helpText: "Tell us who you are." }),
    f("f_name", "name", { required: true }),
    f("f_address", "address"),
    f("f_when", "date_time", { settings: { min: "2026-01-01T00:00", max: "2026-12-31T23:59" } }),
    f("f_score", "slider", { settings: { min: 0, max: 100, step: 5 } }),
    f("f_note", "description", { label: "Thanks for taking part." }),
  ]);

  it("are valid in a definition with sensible settings", () => {
    expect(validateDefinition(def)).toMatchObject({ ok: true });
  });

  it("evaluate to canonical answers, and layout items are never answered or required", () => {
    const result = evaluate(def, {
      f_name: { first: " Ada ", last: "Lovelace" },
      f_address: { line1: "12 St James's Square", city: "London", country: "United Kingdom", region: "" },
      f_when: "2026-06-01T14:30",
      f_score: 75,
    });
    expect(result.errors).toEqual([]);
    expect(result.answers).toEqual({
      f_name: { first: "Ada", last: "Lovelace" },
      f_address: { line1: "12 St James's Square", city: "London", country: "United Kingdom" },
      f_when: "2026-06-01T14:30",
      f_score: 75,
    });
    expect(result.visibleFieldIds).toContain("f_intro");
    expect(result.requiredFieldIds).toEqual(["f_name"]);
  });

  it("refuses wrong shapes, missing parts, out-of-range and off-step values, and answers to layout items", () => {
    const codes = (answers: Record<string, unknown>) => evaluate(def, answers).errors.map((e) => `${e.fieldId}:${e.code}`);
    expect(codes({ f_name: { first: "Ada" } })).toEqual(["f_name:INCOMPLETE"]);
    expect(codes({ f_name: "Ada Lovelace" })).toEqual(["f_name:INVALID_TYPE"]);
    expect(codes({ f_name: { first: "Ada", last: "L", middle: "B" } })).toEqual(["f_name:UNKNOWN_PART"]);
    expect(codes({ f_name: { first: "Ada\nLovelace", last: "L" } })).toEqual(["f_name:INVALID_VALUE"]);
    expect(codes({ f_name: { first: "Ada", last: "L" }, f_when: "2027-01-01T00:00" })).toEqual(["f_when:TOO_LARGE"]);
    expect(codes({ f_name: { first: "Ada", last: "L" }, f_score: 72 })).toEqual(["f_score:OFF_STEP"]);
    expect(codes({ f_name: { first: "Ada", last: "L" }, f_score: 105 })).toEqual(["f_score:OUT_OF_RANGE"]);
    expect(codes({ f_name: { first: "Ada", last: "L" }, f_intro: "hello" })).toEqual(["f_intro:NOT_AN_INPUT"]);
    // A required name left blank is simply missing.
    expect(codes({ f_name: { first: " ", last: "" } })).toEqual(["f_name:REQUIRED"]);
  });

  it("can be compared in rules where it makes sense: date-times and sliders by order, names by presence", () => {
    const ruled = formWith(
      [f("f_name", "name"), f("f_score", "slider", { settings: { min: 0, max: 10 } }), f("f_when", "date_time"), f("f_more", "text")],
      [
        {
          id: "r_1",
          when: { all: [{ fieldId: "f_name", op: "isNotEmpty" }, { fieldId: "f_score", op: "gte", value: 7 }, { fieldId: "f_when", op: "lt", value: "2026-07-01T00:00" }] },
          action: { type: "setVisibility", targetFieldId: "f_more", onTrue: true, onFalse: false },
        },
      ],
    );
    expect(validateDefinition(ruled)).toMatchObject({ ok: true });
    const shown = (answers: Record<string, unknown>) => evaluate(ruled, answers).visibleFieldIds.includes("f_more");
    expect(shown({ f_name: { first: "A", last: "B" }, f_score: 8, f_when: "2026-06-30T23:59" })).toBe(true);
    expect(shown({ f_name: { first: "A", last: "B" }, f_score: 6, f_when: "2026-06-30T23:59" })).toBe(false);
    expect(shown({ f_score: 8, f_when: "2026-06-30T23:59" })).toBe(false);
  });

  it("rejects required layout items, rules that use them or make them required, and bad slider or date-time settings", () => {
    const codes = (d: FormDefinition) => {
      const r = validateDefinition(d);
      return r.ok ? [] : r.issues.map((i) => i.code);
    };
    // The contract itself refuses a required heading.
    expect(codes(formWith([f("f_h", "section", { required: true }), f("f_t", "text")]))).toContain("SCHEMA_CONST");
    expect(
      codes(
        formWith(
          [f("f_t", "text"), f("f_d", "description")],
          [{ id: "r_1", when: { fieldId: "f_t", op: "isNotEmpty" }, action: { type: "setRequired", targetFieldId: "f_d", onTrue: true, onFalse: false } }],
        ),
      ),
    ).toContain("NOT_AN_INPUT");
    expect(
      codes(
        formWith(
          [f("f_h", "section"), f("f_t", "text")],
          [{ id: "r_1", when: { fieldId: "f_h", op: "isNotEmpty" }, action: { type: "setVisibility", targetFieldId: "f_t", onTrue: true, onFalse: false } }],
        ),
      ),
    ).toContain("OPERATOR_NOT_SUPPORTED");
    expect(codes(formWith([f("f_s", "slider", { settings: { min: 0, max: 10, step: 20 } })]))).toContain("INVALID_BOUND");
    expect(codes(formWith([f("f_s", "slider", { settings: { min: 0, max: 100000, step: 1 } })]))).toContain("INVALID_BOUND");
    expect(codes(formWith([f("f_s", "slider", { settings: { min: 5, max: 1 } })]))).toContain("INVERTED_RANGE");
    expect(codes(formWith([f("f_s", "slider", { settings: { max: 10 } })])).length).toBeGreaterThan(0);
    expect(codes(formWith([f("f_w", "date_time", { settings: { min: "2026-13-01T00:00" } })]))).toContain("INVALID_BOUND");
    expect(codes(formWith([f("f_n", "name", { settings: { placeholder: "x" } })]))).toContain("SETTING_NOT_ALLOWED");
  });

  it("export names and addresses as readable text and treat blank parts as empty", () => {
    const name = f("f_name", "name");
    expect(FIELD_REGISTRY.name.exportValue({ first: "Ada", last: "Lovelace" }, name)).toBe("Ada Lovelace");
    expect(isEmptyValue({ first: " ", last: "" })).toBe(true);
    expect(isEmptyValue({ first: "Ada" })).toBe(false);
    expect(isLayoutType("section")).toBe(true);
    expect(isLayoutType("slider")).toBe(false);
  });
});
