import { describe, expect, it } from "vitest";
import { blankDefinition, definitionFromTemplate, FORM_TEMPLATES } from "./templates";
import { validateDefinition } from "./validate-definition";

const runtime = typeof window === "undefined" ? "node" : "browser";

describe(`form templates (${runtime})`, () => {
  for (const template of FORM_TEMPLATES) {
    const { id } = template;
    it(`template "${id}" is a valid, publishable definition`, () => {
      expect(validateDefinition(template.definition)).toMatchObject({ ok: true });
    });
  }

  it("has unique template IDs", () => {
    expect(new Set(FORM_TEMPLATES.map((t) => t.id)).size).toBe(FORM_TEMPLATES.length);
  });

  it("titles a template copy without changing the template", () => {
    const copy = definitionFromTemplate("contact", "Partner enquiries");
    expect(copy?.title).toBe("Partner enquiries");
    expect(FORM_TEMPLATES.find((t) => t.id === "contact")?.definition.title).toBe("Contact us");
    copy!.fields.pop();
    expect(FORM_TEMPLATES.find((t) => t.id === "contact")?.definition.fields).toHaveLength(4);
    expect(definitionFromTemplate("missing", "x")).toBeUndefined();
  });

  it("starts blank forms as an incomplete draft that only lacks fields", () => {
    const result = validateDefinition(blankDefinition("New form"));
    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.issues;
    expect(issues.map((i) => `${i.path}:${i.code}`)).toEqual(["/fields:SCHEMA_MINITEMS"]);
  });
});
