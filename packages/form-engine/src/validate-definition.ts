import {
  PRESENCE_OPERATORS,
  validateStructure,
  type Condition,
  type DefinitionIssue,
  type Field,
  type FieldSettings,
  type FormDefinition,
  type Literal,
} from "@workeasy/form-schema";
import { compareDecimal, decimalFromLiteral } from "./decimal";
import { FIELD_REGISTRY, isValidDate, isValidDateTime, isValidTime, MAX_RATING } from "./fields";
import { themeIssues } from "./theme";

/** Condition limits (docs/03 §3), checked before any condition is evaluated. */
export const MAX_CONDITION_DEPTH = 8;
export const MAX_CONDITION_NODES = 100;

export type DefinitionValidationResult =
  | { ok: true; definition: FormDefinition }
  | { ok: false; issues: DefinitionIssue[] };

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/i;

/**
 * Full definition validation: the JSON Schema contract, then the semantic
 * checks the schema cannot express. Publishing and AI proposals must pass this;
 * the evaluator assumes a definition that did.
 */
export function validateDefinition(input: unknown): DefinitionValidationResult {
  const structure = validateStructure(input);
  if (!structure.ok) return structure;
  const issues = semanticIssues(structure.definition);
  return issues.length === 0 ? { ok: true, definition: structure.definition } : { ok: false, issues };
}

export type DraftValidationResult =
  | { ok: true; definition: FormDefinition; issues: DefinitionIssue[] }
  | { ok: false; issues: DefinitionIssue[] };

/** The only structural gap a saved draft may have: no fields yet. */
function isMissingFieldsOnly(issue: DefinitionIssue): boolean {
  return issue.code === "SCHEMA_MINITEMS" && issue.path === "/fields";
}

/**
 * Validation for saving a draft. Drafts may be incomplete, so a draft is
 * accepted when it is structurally sound apart from having no fields yet;
 * every remaining problem (including semantic ones) is returned as an issue
 * for the builder to show, and publishing still requires validateDefinition.
 * Malformed drafts are rejected, so stored drafts are always safe to load.
 */
export function validateDraft(input: unknown): DraftValidationResult {
  const structure = validateStructure(input);
  if (!structure.ok && !structure.issues.every(isMissingFieldsOnly)) return structure;
  const definition = (structure.ok ? structure.definition : input) as FormDefinition;
  const structural = structure.ok ? [] : structure.issues;
  return { ok: true, definition, issues: [...structural, ...semanticIssues(definition)] };
}

function semanticIssues(def: FormDefinition): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });

  try {
    Intl.getCanonicalLocales(def.locale);
  } catch {
    add("/locale", "INVALID_LOCALE", `"${def.locale}" is not a valid locale identifier.`);
  }

  // Identifiers -----------------------------------------------------------
  const fields = new Map<string, Field>();
  def.fields.forEach((field, i) => {
    if (fields.has(field.id)) add(`/fields/${i}/id`, "DUPLICATE_ID", `Field ID "${field.id}" is used more than once.`);
    else fields.set(field.id, field);
  });
  const pageIndex = new Map<string, number>();
  def.pages.forEach((page, i) => {
    if (pageIndex.has(page.id)) add(`/pages/${i}/id`, "DUPLICATE_ID", `Page ID "${page.id}" is used more than once.`);
    else pageIndex.set(page.id, i);
  });
  const ruleIds = new Set<string>();
  def.rules.forEach((rule, i) => {
    if (ruleIds.has(rule.id)) add(`/rules/${i}/id`, "DUPLICATE_ID", `Rule ID "${rule.id}" is used more than once.`);
    ruleIds.add(rule.id);
  });

  // Page placement: every field on exactly one page ---------------------------
  /** Position of each field in traversal order, and the page it is on. */
  const position = new Map<string, { order: number; page: number }>();
  let order = 0;
  def.pages.forEach((page, p) => {
    page.fieldIds.forEach((fieldId, j) => {
      const path = `/pages/${p}/fieldIds/${j}`;
      if (!fields.has(fieldId)) add(path, "UNKNOWN_FIELD", `Page lists unknown field "${fieldId}".`);
      else if (position.has(fieldId)) add(path, "FIELD_ON_MULTIPLE_PAGES", `Field "${fieldId}" appears more than once.`);
      else position.set(fieldId, { order: order++, page: p });
    });
  });
  def.fields.forEach((field, i) => {
    if (!position.has(field.id)) add(`/fields/${i}`, "FIELD_NOT_ON_PAGE", `Field "${field.id}" is not on any page.`);
  });

  // Field settings ------------------------------------------------------------
  def.fields.forEach((field, i) => {
    checkSettings(field, `/fields/${i}/settings`, add);
    if (FIELD_REGISTRY[field.type].kind === "none" && field.required) {
      add(`/fields/${i}/required`, "NOT_AN_INPUT", "Headings and descriptions can't be required: they take no answer.");
    }
  });

  // Rules ---------------------------------------------------------------------
  const controlled = new Set<string>();
  const skipSources = new Set<string>();
  def.rules.forEach((rule, i) => {
    const path = `/rules/${i}`;
    const referenced = checkCondition(rule.when, `${path}/when`, fields, add);
    const action = rule.action;

    if (action.type === "skipToPage") {
      const source = pageIndex.get(action.sourcePageId);
      const target = pageIndex.get(action.targetPageId);
      if (source === undefined) add(`${path}/action/sourcePageId`, "UNKNOWN_PAGE", `Unknown page "${action.sourcePageId}".`);
      if (target === undefined) add(`${path}/action/targetPageId`, "UNKNOWN_PAGE", `Unknown page "${action.targetPageId}".`);
      if (source !== undefined && target !== undefined && target <= source) {
        add(`${path}/action/targetPageId`, "BACKWARD_SKIP", "Page skips can only move forward.");
      }
      if (skipSources.has(action.sourcePageId)) {
        add(path, "CONFLICTING_SKIPS", `Page "${action.sourcePageId}" already has a skip rule.`);
      }
      skipSources.add(action.sourcePageId);
      if (source !== undefined) {
        for (const fieldId of referenced) {
          const at = position.get(fieldId);
          if (at && at.page > source) {
            add(`${path}/when`, "RULE_REFERENCES_LATER_FIELD", `Skip rule uses "${fieldId}", which is on a later page.`);
          }
        }
      }
      return;
    }

    const target = action.targetFieldId;
    const targetAt = position.get(target);
    if (!fields.has(target)) {
      add(`${path}/action/targetFieldId`, "UNKNOWN_FIELD", `Unknown field "${target}".`);
      return;
    }
    if (action.type === "setRequired" && FIELD_REGISTRY[fields.get(target)!.type].kind === "none") {
      add(`${path}/action/targetFieldId`, "NOT_AN_INPUT", "Headings and descriptions take no answer, so they can't be made required.");
    }
    const property = action.type === "setVisibility" ? "visibility" : "required";
    const key = `${target}:${property}`;
    if (controlled.has(key)) add(path, "CONFLICTING_RULES", `Another rule already controls the ${property} of "${target}".`);
    controlled.add(key);
    for (const fieldId of referenced) {
      const at = position.get(fieldId);
      if (fieldId === target) {
        add(`${path}/when`, "SELF_REFERENCE", `A rule cannot depend on the field it controls ("${target}").`);
      } else if (at && targetAt && at.order >= targetAt.order) {
        // Earlier-only references keep client and server evaluation single-pass
        // and make dependency cycles impossible (docs/03 §3).
        add(`${path}/when`, "RULE_REFERENCES_LATER_FIELD", `"${target}" can only depend on fields before it; "${fieldId}" comes later.`);
      }
    }
  });

  // Theme -----------------------------------------------------------------------
  issues.push(...themeIssues(def.theme));

  return issues;
}

type Add = (path: string, code: string, message: string) => void;

/** Validates a condition tree and returns the field IDs it references. Depth and size are checked first. */
function checkCondition(root: Condition, rootPath: string, fields: Map<string, Field>, add: Add): Set<string> {
  const referenced = new Set<string>();
  // Iterative walk: measure size and depth without trusting the shape.
  const stack: Array<{ node: Condition; path: string; depth: number }> = [{ node: root, path: rootPath, depth: 1 }];
  const leaves: Array<{ node: Extract<Condition, { fieldId: string }>; path: string }> = [];
  let nodes = 0;
  let maxDepth = 0;
  while (stack.length > 0) {
    const { node, path, depth } = stack.pop()!;
    nodes++;
    maxDepth = Math.max(maxDepth, depth);
    if ("all" in node) node.all.forEach((child, i) => stack.push({ node: child, path: `${path}/all/${i}`, depth: depth + 1 }));
    else if ("any" in node) node.any.forEach((child, i) => stack.push({ node: child, path: `${path}/any/${i}`, depth: depth + 1 }));
    else if ("not" in node) stack.push({ node: node.not, path: `${path}/not`, depth: depth + 1 });
    else leaves.push({ node, path });
  }
  if (maxDepth > MAX_CONDITION_DEPTH) {
    add(rootPath, "CONDITION_TOO_DEEP", `Conditions can be nested at most ${MAX_CONDITION_DEPTH} levels.`);
    return referenced;
  }
  if (nodes > MAX_CONDITION_NODES) {
    add(rootPath, "CONDITION_TOO_LARGE", `A condition can have at most ${MAX_CONDITION_NODES} parts.`);
    return referenced;
  }

  for (const { node, path } of leaves.toReversed()) {
    const field = fields.get(node.fieldId);
    if (!field) {
      add(`${path}/fieldId`, "UNKNOWN_FIELD", `Unknown field "${node.fieldId}".`);
      continue;
    }
    referenced.add(field.id);
    const spec = FIELD_REGISTRY[field.type];
    if (!spec.operators.includes(node.op)) {
      add(`${path}/op`, "OPERATOR_NOT_SUPPORTED", `"${node.op}" cannot be used with a ${field.type} field.`);
      continue;
    }
    if ((PRESENCE_OPERATORS as readonly string[]).includes(node.op)) continue;
    const literal = (node as { value: Literal }).value;
    if (spec.literal(literal, field) === undefined) {
      const choice = spec.kind === "choice" || spec.kind === "multi_choice";
      add(
        `${path}/value`,
        choice && typeof literal === "string" ? "UNKNOWN_OPTION" : "INVALID_LITERAL",
        choice && typeof literal === "string"
          ? `"${literal}" is not an option of "${field.id}".`
          : `This value cannot be compared with a ${field.type} field.`,
      );
    }
  }
  return referenced;
}

function checkSettings(field: Field, path: string, add: Add): void {
  const spec = FIELD_REGISTRY[field.type];
  const settings = field.settings;
  for (const key of Object.keys(settings) as (keyof FieldSettings)[]) {
    if (!spec.settings.includes(key)) add(`${path}/${key}`, "SETTING_NOT_ALLOWED", `"${key}" does not apply to ${field.type} fields.`);
  }

  const { minLength, maxLength } = settings;
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    add(`${path}/minLength`, "INVERTED_RANGE", "minLength is greater than maxLength.");
  }

  if (settings.min !== undefined || settings.max !== undefined) checkBounds(field, path, add);
  if (field.type === "slider") checkSlider(field, path, add);

  const options = settings.options ?? [];
  const seen = new Set<string>();
  options.forEach((option, i) => {
    if (seen.has(option.id)) add(`${path}/options/${i}/id`, "DUPLICATE_OPTION_ID", `Option ID "${option.id}" is used more than once.`);
    seen.add(option.id);
  });

  const { minSelections, maxSelections } = settings;
  if (minSelections !== undefined && maxSelections !== undefined && minSelections > maxSelections) {
    add(`${path}/minSelections`, "INVERTED_RANGE", "minSelections is greater than maxSelections.");
  }
  if (minSelections !== undefined && minSelections > options.length) {
    add(`${path}/minSelections`, "INVALID_BOUND", "minSelections is more than the number of options.");
  }

  settings.allowedMimeTypes?.forEach((type, i) => {
    if (!MIME_PATTERN.test(type)) add(`${path}/allowedMimeTypes/${i}`, "INVALID_MIME_TYPE", `"${type}" is not a media type.`);
  });
}

function checkBounds(field: Field, path: string, add: Add): void {
  const { min, max } = field.settings;
  const kind = FIELD_REGISTRY[field.type].kind;
  let parse: (value: number | string) => string | number | undefined;
  let compare: (a: string | number, b: string | number) => number;
  if (kind === "integer") {
    parse = (v) => (typeof v === "number" && Number.isSafeInteger(v) ? v : undefined);
    compare = (a, b) => Number(a) - Number(b);
  } else if (kind === "decimal") {
    parse = (v) => decimalFromLiteral(v);
    compare = (a, b) => compareDecimal(String(a), String(b));
  } else {
    const valid = kind === "date" ? isValidDate : kind === "datetime" ? isValidDateTime : isValidTime;
    parse = (v) => (typeof v === "string" && valid(v) ? v : undefined);
    compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  }
  const parsedMin = min === undefined ? undefined : parse(min);
  const parsedMax = max === undefined ? undefined : parse(max);
  if (min !== undefined && parsedMin === undefined) add(`${path}/min`, "INVALID_BOUND", `min is not a valid ${field.type} value.`);
  if (max !== undefined && parsedMax === undefined) add(`${path}/max`, "INVALID_BOUND", `max is not a valid ${field.type} value.`);
  if (field.type === "rating") {
    if (parsedMin !== undefined && Number(parsedMin) < 0) add(`${path}/min`, "INVALID_BOUND", "Ratings start at 0 or more.");
    if (parsedMax !== undefined && Number(parsedMax) > MAX_RATING) add(`${path}/max`, "INVALID_BOUND", `Ratings go up to ${MAX_RATING} at most.`);
  }
  if (parsedMin !== undefined && parsedMax !== undefined) {
    const cmp = compare(parsedMin, parsedMax);
    if (cmp > 0 || (field.type === "rating" && cmp === 0)) add(`${path}/min`, "INVERTED_RANGE", "min must be less than max.");
  }
}

/** A slider needs a range of at least one step, and at most 1000 positions to choose from. */
function checkSlider(field: Field, path: string, add: Add): void {
  const { min, max, step = 1 } = field.settings;
  if (typeof min !== "number" || typeof max !== "number" || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min >= max) return;
  if (step > max - min) add(`${path}/step`, "INVALID_BOUND", "The step is larger than the slider's range.");
  else if ((max - min) / step > 1000) add(`${path}/step`, "INVALID_BOUND", "A slider can have at most 1000 positions; use a larger step.");
}
