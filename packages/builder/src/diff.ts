import type { Field, FormDefinition, Page, Rule } from "@workeasy/form-schema";
import { FIELD_TYPE_INFO } from "./field-types";

/**
 * Human-readable differences between two definitions, keyed by stable IDs:
 * used to show what changed in a save conflict, and later to review AI
 * proposals before accepting them (docs/03 §4).
 */
export interface DefinitionChange {
  kind: "added" | "removed" | "changed";
  target: "form" | "page" | "question" | "rule";
  /** Stable ID of the page, question or rule ("form" for form details). */
  id: string;
  /** What a person would call it: a question's label, a page title, … */
  name: string;
  /** For "changed": which properties differ, in plain words. */
  details: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function pageName(page: Page, index: number): string {
  return page.title || `Page ${index + 1}`;
}

function fieldName(field: Field): string {
  return field.label || FIELD_TYPE_INFO[field.type].label;
}

function fieldDetails(from: Field, to: Field, fromPage: string | undefined, toPage: string | undefined): string[] {
  const details: string[] = [];
  if (from.label !== to.label) details.push("question text");
  if (from.type !== to.type) details.push("type");
  if (from.required !== to.required) details.push(to.required ? "now required" : "now optional");
  if ((from.helpText ?? "") !== (to.helpText ?? "")) details.push("help text");
  if (!same(from.settings.options, to.settings.options)) details.push("options");
  const { options: _a, ...fromRest } = from.settings;
  const { options: _b, ...toRest } = to.settings;
  if (!same(fromRest, toRest)) details.push("settings");
  if (fromPage !== toPage) details.push("page");
  return details;
}

function pageOfField(def: FormDefinition): Map<string, string> {
  const map = new Map<string, string>();
  for (const page of def.pages) for (const id of page.fieldIds) map.set(id, page.id);
  return map;
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/**
 * A short undo label for an edit ("Add Rating", "Edit Your name") and, when
 * the edit touches a single property, a key so consecutive keystrokes in the
 * same input merge into one undo step.
 */
export function summarizeChanges(changes: readonly DefinitionChange[]): { label: string; key?: string } {
  const pick = (kind: DefinitionChange["kind"], target: DefinitionChange["target"]) =>
    changes.find((c) => c.kind === kind && c.target === target);
  const removedQuestion = pick("removed", "question");
  if (removedQuestion) return { label: `Delete ${removedQuestion.name}` };
  const addedQuestion = pick("added", "question");
  if (addedQuestion) return { label: `Add ${addedQuestion.name}` };
  if (pick("added", "page")) return { label: "Add page" };
  if (pick("removed", "page")) return { label: "Delete page" };
  const [only] = changes;
  if (changes.length === 1 && only?.kind === "changed") {
    const what = only.target !== "form" ? only.name : only.details.join() === "theme" ? "theme" : "form details";
    return { label: `Edit ${what}`, key: `${only.target}:${only.id}:${only.details.join(",")}` };
  }
  const question = pick("changed", "question");
  if (question && changes.every((c) => c.target === "page" || c.id === question.id)) return { label: `Move ${question.name}` };
  return { label: "Edit form" };
}

/** Changes that turn `from` into `to`, in display order: form, pages, questions, rules. */
export function diffDefinitions(from: FormDefinition, to: FormDefinition): DefinitionChange[] {
  const changes: DefinitionChange[] = [];

  const formDetails: string[] = [];
  if (from.title !== to.title) formDetails.push("title");
  if ((from.description ?? "") !== (to.description ?? "")) formDetails.push("description");
  if (from.success.message !== to.success.message) formDetails.push("message after submitting");
  if (from.locale !== to.locale) formDetails.push("language");
  if (!same(from.theme, to.theme)) formDetails.push("theme");
  if (formDetails.length > 0) changes.push({ kind: "changed", target: "form", id: "form", name: to.title, details: formDetails });

  const fromPages = byId(from.pages);
  const toPages = byId(to.pages);
  to.pages.forEach((page, i) => {
    const before = fromPages.get(page.id);
    if (!before) changes.push({ kind: "added", target: "page", id: page.id, name: pageName(page, i), details: [] });
    else {
      const details: string[] = [];
      if (before.title !== page.title) details.push("title");
      if (from.pages.indexOf(before) !== i) details.push("position");
      if (!same(before.fieldIds, page.fieldIds)) details.push("questions or their order");
      if (details.length > 0) changes.push({ kind: "changed", target: "page", id: page.id, name: pageName(page, i), details });
    }
  });
  from.pages.forEach((page, i) => {
    if (!toPages.has(page.id)) changes.push({ kind: "removed", target: "page", id: page.id, name: pageName(page, i), details: [] });
  });

  const fromFields = byId(from.fields);
  const toFields = byId(to.fields);
  const fromPageOf = pageOfField(from);
  const toPageOf = pageOfField(to);
  for (const field of to.fields) {
    const before = fromFields.get(field.id);
    if (!before) {
      changes.push({ kind: "added", target: "question", id: field.id, name: fieldName(field), details: [] });
      continue;
    }
    const details = fieldDetails(before, field, fromPageOf.get(field.id), toPageOf.get(field.id));
    if (details.length > 0) changes.push({ kind: "changed", target: "question", id: field.id, name: fieldName(field), details });
  }
  for (const field of from.fields) {
    if (!toFields.has(field.id)) changes.push({ kind: "removed", target: "question", id: field.id, name: fieldName(field), details: [] });
  }

  const fromRules = byId<Rule>(from.rules);
  const toRules = byId<Rule>(to.rules);
  for (const rule of to.rules) {
    const before = fromRules.get(rule.id);
    if (!before) changes.push({ kind: "added", target: "rule", id: rule.id, name: rule.id, details: [] });
    else if (!same(before, rule)) changes.push({ kind: "changed", target: "rule", id: rule.id, name: rule.id, details: ["condition or action"] });
  }
  for (const rule of from.rules) {
    if (!toRules.has(rule.id)) changes.push({ kind: "removed", target: "rule", id: rule.id, name: rule.id, details: [] });
  }

  return changes;
}
