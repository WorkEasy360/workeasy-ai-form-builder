import { definitionFromTemplate } from "@workeasy/form-engine";
import { describe, expect, it } from "vitest";
import { diffDefinitions, summarizeChanges } from "./diff";
import { addField, addPage, moveField, removeField, renameOption, updateField, updateFieldSettings, updateFormDetails } from "./operations";

const runtime = typeof window === "undefined" ? "node" : "browser";

describe(`definition diff (${runtime})`, () => {
  const base = definitionFromTemplate("support-request", "Support")!;

  it("finds no changes between identical definitions", () => {
    expect(diffDefinitions(base, structuredClone(base))).toEqual([]);
  });

  it("describes form, question, option and settings changes by stable ID", () => {
    let next = updateFormDetails(base, { title: "Help desk", successMessage: "Thanks!" });
    next = updateField(next, "f_name", { label: "Full name", required: false });
    next = renameOption(next, "f_category", "opt_general", "Other");
    next = updateFieldSettings(next, "f_details", { maxLength: 100 });
    expect(diffDefinitions(base, next)).toEqual([
      { kind: "changed", target: "form", id: "form", name: "Help desk", details: ["title", "message after submitting"] },
      { kind: "changed", target: "question", id: "f_name", name: "Full name", details: ["question text", "now optional"] },
      { kind: "changed", target: "question", id: "f_category", name: "Request category", details: ["options"] },
      { kind: "changed", target: "question", id: "f_details", name: "Technical details", details: ["settings"] },
    ]);
  });

  it("reports added and removed questions, and rules removed with them", () => {
    const added = addField(base, "rating", base.pages[0]!.id);
    const next = removeField(added.definition, "f_category").definition;
    const changes = diffDefinitions(base, next);
    expect(changes).toContainEqual({ kind: "added", target: "question", id: added.fieldId, name: "Rating", details: [] });
    expect(changes).toContainEqual({ kind: "removed", target: "question", id: "f_category", name: "Request category", details: [] });
    expect(changes).toContainEqual({ kind: "removed", target: "rule", id: "rule_technical_details", name: "rule_technical_details", details: [] });
  });

  it("names undo steps and gives single-property edits a merge key", () => {
    const summary = (next: typeof base) => summarizeChanges(diffDefinitions(base, next));
    const added = addField(base, "rating", base.pages[0]!.id).definition;
    expect(summary(added)).toEqual({ label: "Add Rating" });
    expect(summary(removeField(base, "f_category").definition)).toEqual({ label: "Delete Request category" });
    expect(summary(updateField(base, "f_name", { label: "Full name" }))).toEqual({
      label: "Edit Full name",
      key: "question:f_name:question text",
    });
    expect(summary(updateFormDetails(base, { title: "New title" }))).toEqual({ label: "Edit form details", key: "form:form:title" });
    expect(summary(moveField(base, "f_email", -1))).toEqual({ label: "Edit Your request", key: "page:page_contact:questions or their order" });
    expect(summary(addPage(base).definition)).toEqual({ label: "Add page" });
  });

  it("reports pages added and questions moved between pages", () => {
    const { definition, pageId } = addPage(base);
    const next = moveField(definition, "f_consent", 1);
    const changes = diffDefinitions(base, next);
    expect(changes).toContainEqual({ kind: "added", target: "page", id: pageId, name: "Page 2", details: [] });
    expect(changes).toContainEqual(expect.objectContaining({ target: "question", id: "f_consent", details: ["page"] }));
    expect(changes).toContainEqual(expect.objectContaining({ target: "page", id: "page_contact", details: ["questions or their order"] }));
  });
});
