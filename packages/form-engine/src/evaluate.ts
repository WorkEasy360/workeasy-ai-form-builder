import type { Condition, Field, FormDefinition, Literal, Rule } from "@workeasy/form-schema";
import { compareDecimal } from "./decimal";
import { FIELD_REGISTRY, type AnswerValue } from "./fields";

export interface AnswerError {
  /** Field the error belongs to; "" for errors about the whole answer set. */
  fieldId: string;
  code: string;
  message: string;
}

export interface EvaluationResult {
  /** Canonical answers: visible, reachable, valid and non-empty only. */
  answers: Record<string, AnswerValue>;
  errors: AnswerError[];
  /** Visible fields on reachable pages, in traversal order. */
  visibleFieldIds: string[];
  /** Visible fields that are currently required, in traversal order. */
  requiredFieldIds: string[];
  /** Pages on the respondent's path, in order. */
  reachablePageIds: string[];
}

/**
 * Deterministic evaluation shared by browser and server (docs/03 §3):
 *
 * 1. Decode submitted values with bounded type parsers; reject unknown fields.
 * 2. Traverse pages and fields in order using the pinned definition.
 * 3. Evaluate visibility and page routing. Hidden or unreachable fields
 *    contribute an absent value to later rules.
 * 4. Drop hidden/unreachable answers even if the client sent them; their
 *    required rules do not apply.
 * 5. Apply conditional required state and report errors for visible fields.
 *
 * The definition must already have passed validateDefinition.
 */
export function evaluate(definition: FormDefinition, rawAnswers: unknown): EvaluationResult {
  const result: EvaluationResult = { answers: {}, errors: [], visibleFieldIds: [], requiredFieldIds: [], reachablePageIds: [] };

  if (rawAnswers === null || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    result.errors.push({ fieldId: "", code: "ANSWERS_NOT_OBJECT", message: "Answers must be an object keyed by field ID." });
    return result;
  }
  const raw = rawAnswers as Record<string, unknown>;

  const fields = new Map<string, Field>(definition.fields.map((f) => [f.id, f]));
  for (const key of Object.keys(raw).toSorted()) {
    if (!fields.has(key)) result.errors.push({ fieldId: key, code: "UNKNOWN_FIELD", message: "This question is not part of the form." });
  }

  const visibilityRules = new Map<string, Rule>();
  const requiredRules = new Map<string, Rule>();
  const skipRules = new Map<string, Rule>();
  for (const rule of definition.rules) {
    const action = rule.action;
    if (action.type === "skipToPage") skipRules.set(action.sourcePageId, rule);
    else (action.type === "setVisibility" ? visibilityRules : requiredRules).set(action.targetFieldId, rule);
  }
  const pageIndex = new Map(definition.pages.map((p, i) => [p.id, i]));

  /** Effective values used by conditions: only visible, reachable, valid, non-empty answers. */
  const values = new Map<string, AnswerValue>();
  const holds = (condition: Condition) => test(condition, values, fields);
  const outcome = (rule: Rule | undefined, fallback: boolean) => {
    if (!rule || rule.action.type === "skipToPage") return fallback;
    return holds(rule.when) ? rule.action.onTrue : rule.action.onFalse;
  };

  let index = 0;
  while (index < definition.pages.length) {
    const page = definition.pages[index]!;
    result.reachablePageIds.push(page.id);

    for (const fieldId of page.fieldIds) {
      const field = fields.get(fieldId)!;
      if (!outcome(visibilityRules.get(fieldId), true)) continue;
      result.visibleFieldIds.push(fieldId);

      // Layout items are shown but never answered, so they are never required.
      const required = FIELD_REGISTRY[field.type].kind !== "none" && outcome(requiredRules.get(fieldId), field.required);
      if (required) result.requiredFieldIds.push(fieldId);

      let value: AnswerValue | undefined;
      if (Object.prototype.hasOwnProperty.call(raw, fieldId)) {
        const decoded = FIELD_REGISTRY[field.type].decode(raw[fieldId], field);
        if (!decoded.ok) {
          result.errors.push({ fieldId, code: decoded.code, message: decoded.message });
          continue;
        }
        if ("value" in decoded) value = decoded.value;
      }

      if (value !== undefined) {
        values.set(fieldId, value);
        result.answers[fieldId] = value;
      }
      // Required consent means literally true; for every other type, not empty.
      const missing = field.type === "consent" ? value !== true : value === undefined;
      if (required && missing) {
        result.errors.push({
          fieldId,
          code: "REQUIRED",
          message: field.type === "consent" ? "Please agree to continue." : "This question is required.",
        });
      }
    }

    const skip = skipRules.get(page.id);
    index = skip && skip.action.type === "skipToPage" && holds(skip.when) ? pageIndex.get(skip.action.targetPageId)! : index + 1;
  }

  return result;
}

function test(condition: Condition, values: Map<string, AnswerValue>, fields: Map<string, Field>): boolean {
  if ("all" in condition) return condition.all.every((c) => test(c, values, fields));
  if ("any" in condition) return condition.any.some((c) => test(c, values, fields));
  if ("not" in condition) return !test(condition.not, values, fields);

  const value = values.get(condition.fieldId);
  if (condition.op === "isEmpty") return value === undefined;
  if (condition.op === "isNotEmpty") return value !== undefined;
  // Comparisons on absent values are false, including neq (docs/03 §3).
  if (value === undefined) return false;

  const field = fields.get(condition.fieldId)!;
  const spec = FIELD_REGISTRY[field.type];
  const literal = spec.literal((condition as { value: Literal }).value, field);
  if (literal === undefined) return false;

  if (spec.kind === "multi_choice") {
    return condition.op === "contains" && (value as string[]).includes(literal as string);
  }
  if (condition.op === "contains") {
    // Text containment ignores case (Unicode default case mapping, the same in every engine).
    return typeof value === "string" && value.toLowerCase().includes(String(literal).toLowerCase());
  }

  let order: number;
  if (spec.kind === "decimal") order = compareDecimal(value as string, literal as string);
  else if (spec.kind === "integer") order = (value as number) - (literal as number);
  else if (typeof value === "string") order = value < (literal as string) ? -1 : value > (literal as string) ? 1 : 0;
  else order = value === literal ? 0 : NaN;

  switch (condition.op) {
    case "eq":
      return order === 0;
    case "neq":
      return order !== 0;
    case "gt":
      return order > 0;
    case "gte":
      return order >= 0;
    case "lt":
      return order < 0;
    case "lte":
      return order <= 0;
  }
}
