import type { Condition, Field, FieldSettings, FieldType, FormDefinition, PrivacyClass, Rule, Theme } from "@workeasy/form-schema";
import { newField, newId } from "./field-types";

/**
 * Pure editing operations on a form definition. Each returns a new
 * definition and never mutates its input, so callers can keep history
 * (undo/redo arrives with the command model in BLD-03).
 */

export class BuilderError extends Error {
  override name = "BuilderError";
}

function clone(def: FormDefinition): FormDefinition {
  return structuredClone(def);
}

function allIds(def: FormDefinition): Set<string> {
  const ids = new Set<string>();
  for (const page of def.pages) ids.add(page.id);
  for (const field of def.fields) {
    ids.add(field.id);
    for (const option of field.settings.options ?? []) ids.add(option.id);
  }
  for (const rule of def.rules) ids.add(rule.id);
  return ids;
}

function findField(def: FormDefinition, fieldId: string): Field {
  const field = def.fields.find((f) => f.id === fieldId);
  if (!field) throw new BuilderError(`Unknown field "${fieldId}".`);
  return field;
}

function pageOf(def: FormDefinition, fieldId: string) {
  const page = def.pages.find((p) => p.fieldIds.includes(fieldId));
  if (!page) throw new BuilderError(`Field "${fieldId}" is not on a page.`);
  return page;
}

function conditionFields(condition: Condition, out = new Set<string>()): Set<string> {
  if ("all" in condition) condition.all.forEach((c) => conditionFields(c, out));
  else if ("any" in condition) condition.any.forEach((c) => conditionFields(c, out));
  else if ("not" in condition) conditionFields(condition.not, out);
  else out.add(condition.fieldId);
  return out;
}

/** Rules that use the field in a condition or act on it. */
export function rulesDependingOnField(def: FormDefinition, fieldId: string): Rule[] {
  return def.rules.filter(
    (rule) => conditionFields(rule.when).has(fieldId) || ("targetFieldId" in rule.action && rule.action.targetFieldId === fieldId),
  );
}

// Form details -------------------------------------------------------------

export function updateFormDetails(
  def: FormDefinition,
  details: { title?: string; description?: string; successMessage?: string },
): FormDefinition {
  const next = clone(def);
  if (details.title !== undefined) next.title = details.title;
  if (details.description !== undefined) {
    if (details.description === "") delete next.description;
    else next.description = details.description;
  }
  if (details.successMessage !== undefined) next.success = { message: details.successMessage };
  return next;
}

/** Changes theme tokens. Colours must be #RRGGBB and the radius 0–24; contrast is checked by validation. */
export function updateTheme(def: FormDefinition, patch: Partial<Theme>): FormDefinition {
  const next = clone(def);
  for (const key of ["accent", "background", "text"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new BuilderError("Enter a colour as # followed by six hex digits, like #4F46E5.");
    next.theme[key] = value.toUpperCase();
  }
  if (patch.radius !== undefined) {
    if (!Number.isInteger(patch.radius) || patch.radius < 0 || patch.radius > 24) throw new BuilderError("Corner rounding must be a whole number from 0 to 24.");
    next.theme.radius = patch.radius;
  }
  return next;
}

// Fields -------------------------------------------------------------------

export function addField(def: FormDefinition, type: FieldType, pageId: string, index?: number): { definition: FormDefinition; fieldId: string } {
  const next = clone(def);
  const page = next.pages.find((p) => p.id === pageId);
  if (!page) throw new BuilderError(`Unknown page "${pageId}".`);
  const field = newField(type, allIds(next));
  next.fields.push(field);
  page.fieldIds.splice(index ?? page.fieldIds.length, 0, field.id);
  return { definition: next, fieldId: field.id };
}

/** `privacy: null` returns the field to its type's default classification. */
export type FieldPatch = Partial<Pick<Field, "label" | "required">> & { helpText?: string; privacy?: PrivacyClass | null };

export function updateField(def: FormDefinition, fieldId: string, patch: FieldPatch): FormDefinition {
  const next = clone(def);
  const field = findField(next, fieldId);
  if (patch.label !== undefined) field.label = patch.label;
  if (patch.required !== undefined) field.required = patch.required;
  if (patch.helpText !== undefined) {
    if (patch.helpText === "") delete field.helpText;
    else field.helpText = patch.helpText;
  }
  if (patch.privacy !== undefined) {
    if (patch.privacy === null) delete field.privacy;
    else field.privacy = patch.privacy;
  }
  return next;
}

/** Settings as edited in the inspector: a cleared value is `undefined`. */
export type SettingsInput = { [K in keyof FieldSettings]?: FieldSettings[K] | undefined };

/** Replaces a field's settings; undefined values are dropped. */
export function updateFieldSettings(def: FormDefinition, fieldId: string, settings: SettingsInput): FormDefinition {
  const next = clone(def);
  const field = findField(next, fieldId);
  field.settings = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) as FieldSettings;
  return next;
}

/**
 * Removes a field and every rule that depends on it, returning those rules so
 * the builder can tell the user what else changed (docs/03 §2).
 */
export function removeField(def: FormDefinition, fieldId: string): { definition: FormDefinition; removedRules: Rule[] } {
  findField(def, fieldId);
  const removedRules = rulesDependingOnField(def, fieldId);
  const removedIds = new Set(removedRules.map((r) => r.id));
  const next = clone(def);
  next.fields = next.fields.filter((f) => f.id !== fieldId);
  for (const page of next.pages) page.fieldIds = page.fieldIds.filter((id) => id !== fieldId);
  next.rules = next.rules.filter((r) => !removedIds.has(r.id));
  return { definition: next, removedRules };
}

/** Copies a field with new field and option IDs, placed right after the original. Rules are not copied. */
export function duplicateField(def: FormDefinition, fieldId: string): { definition: FormDefinition; fieldId: string } {
  const next = clone(def);
  const taken = allIds(next);
  const source = findField(next, fieldId);
  const copy: Field = structuredClone(source);
  copy.id = newId("f", taken);
  taken.add(copy.id);
  copy.label = `${source.label} (copy)`.slice(0, 300);
  if (copy.settings.options) {
    copy.settings.options = copy.settings.options.map((o) => {
      const id = newId("opt", taken);
      taken.add(id);
      return { ...o, id };
    });
  }
  next.fields.splice(next.fields.indexOf(source) + 1, 0, copy);
  const page = pageOf(next, fieldId);
  page.fieldIds.splice(page.fieldIds.indexOf(fieldId) + 1, 0, copy.id);
  return { definition: next, fieldId: copy.id };
}

/**
 * Moves a field one step up or down. At the edge of a page it moves to the
 * end of the previous page or the start of the next one.
 */
export function moveField(def: FormDefinition, fieldId: string, direction: -1 | 1): FormDefinition {
  const next = clone(def);
  const page = pageOf(next, fieldId);
  const pageIndex = next.pages.indexOf(page);
  const index = page.fieldIds.indexOf(fieldId);
  const target = index + direction;
  if (target >= 0 && target < page.fieldIds.length) {
    page.fieldIds.splice(index, 1);
    page.fieldIds.splice(target, 0, fieldId);
    return next;
  }
  const neighbour = next.pages[pageIndex + direction];
  if (!neighbour) return def;
  page.fieldIds.splice(index, 1);
  if (direction === -1) neighbour.fieldIds.push(fieldId);
  else neighbour.fieldIds.unshift(fieldId);
  return next;
}

export function moveFieldToPage(def: FormDefinition, fieldId: string, pageId: string): FormDefinition {
  const next = clone(def);
  const from = pageOf(next, fieldId);
  const to = next.pages.find((p) => p.id === pageId);
  if (!to) throw new BuilderError(`Unknown page "${pageId}".`);
  if (from === to) return def;
  from.fieldIds = from.fieldIds.filter((id) => id !== fieldId);
  to.fieldIds.push(fieldId);
  return next;
}

// Choice options -----------------------------------------------------------

export function addOption(def: FormDefinition, fieldId: string): { definition: FormDefinition; optionId: string } {
  const next = clone(def);
  const field = findField(next, fieldId);
  const options = field.settings.options;
  if (!options) throw new BuilderError(`Field "${fieldId}" has no options.`);
  const id = newId("opt", allIds(next));
  options.push({ id, label: `Option ${options.length + 1}` });
  return { definition: next, optionId: id };
}

export function renameOption(def: FormDefinition, fieldId: string, optionId: string, label: string): FormDefinition {
  const next = clone(def);
  const option = findField(next, fieldId).settings.options?.find((o) => o.id === optionId);
  if (!option) throw new BuilderError(`Unknown option "${optionId}".`);
  option.label = label;
  return next;
}

/** Removes an option; the last option cannot be removed (choices need at least one). */
export function removeOption(def: FormDefinition, fieldId: string, optionId: string): FormDefinition {
  const next = clone(def);
  const field = findField(next, fieldId);
  const options = field.settings.options ?? [];
  if (options.length <= 1) throw new BuilderError("A choice field needs at least one option.");
  field.settings.options = options.filter((o) => o.id !== optionId);
  return next;
}

export function moveOption(def: FormDefinition, fieldId: string, optionId: string, direction: -1 | 1): FormDefinition {
  const next = clone(def);
  const options = findField(next, fieldId).settings.options ?? [];
  const index = options.findIndex((o) => o.id === optionId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= options.length) return def;
  const [moved] = options.splice(index, 1);
  options.splice(target, 0, moved!);
  return next;
}

// Pages --------------------------------------------------------------------

export function addPage(def: FormDefinition, afterPageId?: string): { definition: FormDefinition; pageId: string } {
  const next = clone(def);
  const id = newId("page", allIds(next));
  const index = afterPageId ? next.pages.findIndex((p) => p.id === afterPageId) + 1 : next.pages.length;
  next.pages.splice(index, 0, { id, title: `Page ${next.pages.length + 1}`, fieldIds: [] });
  return { definition: next, pageId: id };
}

export function renamePage(def: FormDefinition, pageId: string, title: string): FormDefinition {
  const next = clone(def);
  const page = next.pages.find((p) => p.id === pageId);
  if (!page) throw new BuilderError(`Unknown page "${pageId}".`);
  page.title = title;
  return next;
}

export function movePage(def: FormDefinition, pageId: string, direction: -1 | 1): FormDefinition {
  const next = clone(def);
  const index = next.pages.findIndex((p) => p.id === pageId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.pages.length) return def;
  const [moved] = next.pages.splice(index, 1);
  next.pages.splice(target, 0, moved!);
  return next;
}

/**
 * Removes an empty page (move or delete its fields first) and any skip rules
 * that route from or to it. The last page cannot be removed.
 */
export function removePage(def: FormDefinition, pageId: string): { definition: FormDefinition; removedRules: Rule[] } {
  const page = def.pages.find((p) => p.id === pageId);
  if (!page) throw new BuilderError(`Unknown page "${pageId}".`);
  if (def.pages.length <= 1) throw new BuilderError("A form needs at least one page.");
  if (page.fieldIds.length > 0) throw new BuilderError("Move or delete this page's questions first.");
  const removedRules = def.rules.filter(
    (r) => r.action.type === "skipToPage" && (r.action.sourcePageId === pageId || r.action.targetPageId === pageId),
  );
  const removedIds = new Set(removedRules.map((r) => r.id));
  const next = clone(def);
  next.pages = next.pages.filter((p) => p.id !== pageId);
  next.rules = next.rules.filter((r) => !removedIds.has(r.id));
  return { definition: next, removedRules };
}
