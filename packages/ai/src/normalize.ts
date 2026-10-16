import { randomBytes } from "node:crypto";
import { validateDefinition } from "@workeasy/form-engine";
import type { DefinitionIssue, Field, FormDefinition } from "@workeasy/form-schema";
import { AI_LIMITS } from "./prompt.js";

/**
 * Turns a model reply into a proposal (docs/03 §4). The reply is untrusted:
 * it is parsed, given server IDs (keeping the IDs of items that exist in the
 * base draft when editing), checked for AI-specific limits and markup, and
 * then validated exactly like a draft being published. Anything wrong comes
 * back as issues; nothing partial is ever returned.
 */
export type ProposalResult =
  | { ok: true; definition: FormDefinition; summary: ProposalSummary }
  | { ok: false; issues: DefinitionIssue[] };

/** Identifiers and counts only, never text from the model. */
export interface ProposalSummary {
  fields: number;
  pages: number;
  rules: number;
  addedFieldIds: string[];
  removedFieldIds: string[];
  typeChangedFieldIds: string[];
  warnings: string[];
}

const MARKUP = /<\s*\/?\s*[a-z!][^>]*>|javascript:/i;

const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every string a respondent would see, with its path, for the markup check. */
function visibleText(def: Record<string, unknown>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [
    ["title", def.title],
    ["description", def.description],
    ["success.message", isRecord(def.success) ? def.success.message : undefined],
  ];
  (Array.isArray(def.pages) ? def.pages : []).forEach((p, i) => out.push([`pages[${i}].title`, isRecord(p) ? p.title : undefined]));
  (Array.isArray(def.fields) ? def.fields : []).forEach((f, i) => {
    if (!isRecord(f)) return;
    out.push([`fields[${i}].label`, f.label], [`fields[${i}].helpText`, f.helpText]);
    const settings = isRecord(f.settings) ? f.settings : {};
    out.push([`fields[${i}].settings.placeholder`, settings.placeholder]);
    (Array.isArray(settings.options) ? settings.options : []).forEach((o, j) => out.push([`fields[${i}].settings.options[${j}].label`, isRecord(o) ? o.label : undefined]));
  });
  return out;
}

export function proposalFromReply(text: string, base: FormDefinition, operation: "create" | "edit"): ProposalResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ path: "", code: "NOT_JSON", message: "The reply is not a JSON object" }] };
  }
  // Accept the form at the top level or under a single wrapping key.
  if (isRecord(parsed) && !("fields" in parsed) && Object.keys(parsed).length === 1) {
    const inner = Object.values(parsed)[0];
    if (isRecord(inner)) parsed = inner;
  }
  if (!isRecord(parsed)) return { ok: false, issues: [{ path: "", code: "NOT_AN_OBJECT", message: "The reply is not a JSON object" }] };

  const issues: DefinitionIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const reply = parsed;
  const fields = Array.isArray(reply.fields) ? reply.fields : [];
  const pages = Array.isArray(reply.pages) ? reply.pages : [];
  const rules = Array.isArray(reply.rules) ? reply.rules : [];
  if (fields.length > AI_LIMITS.maxFields) add("fields", "TOO_MANY_FIELDS", `At most ${AI_LIMITS.maxFields} fields`);
  if (pages.length > AI_LIMITS.maxPages) add("pages", "TOO_MANY_PAGES", `At most ${AI_LIMITS.maxPages} pages`);
  if (rules.length > AI_LIMITS.maxRules) add("rules", "TOO_MANY_RULES", `At most ${AI_LIMITS.maxRules} rules`);
  for (const [path, value] of visibleText(reply)) {
    if (typeof value === "string" && MARKUP.test(value)) add(path, "MARKUP_NOT_ALLOWED", "Use plain text, not HTML or scripts");
  }
  if (issues.length > 0) return { ok: false, issues };

  // Server IDs: keep an existing item's ID when editing, otherwise assign a new one.
  const keepFields = new Map(operation === "edit" ? base.fields.map((f) => [f.id, f]) : []);
  const keepPages = new Set(operation === "edit" ? base.pages.map((p) => p.id) : []);
  const keepRules = new Set(operation === "edit" ? base.rules.map((r) => r.id) : []);
  const fieldIds = new Map<string, string>();
  const pageIds = new Map<string, string>();
  const optionIds = new Map<string, Map<string, string>>();
  const assign = (map: Map<string, string>, keep: { has(id: string): boolean }, raw: unknown, prefix: string, path: string): unknown => {
    if (typeof raw !== "string") return raw;
    if (map.has(raw)) {
      add(path, "DUPLICATE_ID", "Each item needs its own ID");
      return raw;
    }
    const id = keep.has(raw) ? raw : newId(prefix);
    map.set(raw, id);
    return id;
  };

  const outFields = fields.map((f, i) => {
    if (!isRecord(f)) return f;
    const id = assign(fieldIds, keepFields, f.id, "f", `fields[${i}].id`);
    const settings = isRecord(f.settings) ? { ...f.settings } : f.settings;
    if (isRecord(settings) && Array.isArray(settings.options)) {
      const kept = new Set((typeof id === "string" ? keepFields.get(id)?.settings.options : undefined)?.map((o) => o.id) ?? []);
      const map = new Map<string, string>();
      settings.options = settings.options.map((o, j) =>
        isRecord(o) ? { ...o, id: assign(map, kept, o.id, "o", `fields[${i}].settings.options[${j}].id`) } : o,
      );
      if (typeof f.id === "string") optionIds.set(f.id, map);
    }
    return { ...f, id, settings };
  });
  const outPages = pages.map((p, i) =>
    isRecord(p)
      ? {
          ...p,
          id: assign(pageIds, keepPages, p.id, "p", `pages[${i}].id`),
          fieldIds: Array.isArray(p.fieldIds) ? p.fieldIds.map((id) => (typeof id === "string" ? (fieldIds.get(id) ?? id) : id)) : p.fieldIds,
        }
      : p,
  );
  const ruleIds = new Map<string, string>();
  const mapCondition = (c: unknown): unknown => {
    if (!isRecord(c)) return c;
    if (Array.isArray(c.all)) return { ...c, all: c.all.map(mapCondition) };
    if (Array.isArray(c.any)) return { ...c, any: c.any.map(mapCondition) };
    if ("not" in c) return { ...c, not: mapCondition(c.not) };
    if (typeof c.fieldId !== "string") return c;
    const options = optionIds.get(c.fieldId);
    const value = typeof c.value === "string" && options?.has(c.value) ? options.get(c.value) : c.value;
    return { ...c, fieldId: fieldIds.get(c.fieldId) ?? c.fieldId, ...("value" in c ? { value } : {}) };
  };
  const outRules = rules.map((r, i) => {
    if (!isRecord(r)) return r;
    const action = isRecord(r.action) ? { ...r.action } : r.action;
    if (isRecord(action)) {
      if (typeof action.targetFieldId === "string") action.targetFieldId = fieldIds.get(action.targetFieldId) ?? action.targetFieldId;
      if (typeof action.sourcePageId === "string") action.sourcePageId = pageIds.get(action.sourcePageId) ?? action.sourcePageId;
      if (typeof action.targetPageId === "string") action.targetPageId = pageIds.get(action.targetPageId) ?? action.targetPageId;
    }
    return { ...r, id: assign(ruleIds, keepRules, r.id, "r", `rules[${i}].id`), when: mapCondition(r.when), action };
  });
  if (issues.length > 0) return { ok: false, issues };

  // The model chooses content; format, locale and theme stay the draft's.
  const candidate: Record<string, unknown> = {
    schemaVersion: base.schemaVersion,
    title: reply.title,
    ...(reply.description !== undefined && reply.description !== "" ? { description: reply.description } : {}),
    locale: base.locale,
    pages: outPages,
    fields: outFields,
    rules: outRules,
    theme: base.theme,
    success: isRecord(reply.success) ? reply.success : base.success,
  };
  const validation = validateDefinition(candidate);
  if (!validation.ok) return { ok: false, issues: validation.issues };
  return { ok: true, definition: validation.definition, summary: summarize(validation.definition, base, operation) };
}

function summarize(def: FormDefinition, base: FormDefinition, operation: "create" | "edit"): ProposalSummary {
  const before = new Map<string, Field>(operation === "edit" ? base.fields.map((f) => [f.id, f]) : []);
  const after = new Map(def.fields.map((f) => [f.id, f]));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const typeChanged = def.fields.filter((f) => before.has(f.id) && before.get(f.id)!.type !== f.type).map((f) => f.id);
  const warnings: string[] = [];
  if (removed.length > 0) warnings.push("removes_fields");
  if (typeChanged.length > 0) warnings.push("changes_field_types");
  if (def.fields.some((f) => f.type === "consent")) warnings.push("review_consent_wording");
  if (def.fields.some((f) => f.type === "file")) warnings.push("review_file_settings");
  return {
    fields: def.fields.length,
    pages: def.pages.length,
    rules: def.rules.length,
    addedFieldIds: def.fields.filter((f) => !before.has(f.id)).map((f) => f.id),
    removedFieldIds: removed,
    typeChangedFieldIds: typeChanged,
    warnings,
  };
}

