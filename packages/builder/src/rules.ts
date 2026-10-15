import { decimalFromLiteral, FIELD_REGISTRY, validateDraft } from "@workeasy/form-engine";
import {
  PRESENCE_OPERATORS,
  type ComparisonOperator,
  type Condition,
  type DefinitionIssue,
  type Field,
  type FormDefinition,
  type Literal,
  type Operator,
  type PresenceOperator,
  type Rule,
} from "@workeasy/form-schema";
import { newId } from "./field-types";
import { BuilderError } from "./operations";

/**
 * Rule editing for the builder (docs/03 Â§3): show/hide and required/optional
 * rules on questions, and forward skip rules on pages. Helpers offer only
 * valid choices (earlier questions, operators that suit the type, later
 * pages); `ruleProblems` reports what the engine would reject.
 */

export type FieldRuleProperty = "visibility" | "required";

/** A single comparison, as edited in the builder. */
export type SimpleLeaf =
  | { fieldId: string; op: ComparisonOperator; value: Literal }
  | { fieldId: string; op: PresenceOperator };

/** "All"/"any" of a list of comparisons: the condition shape the builder UI edits. */
export interface SimpleCondition {
  match: "all" | "any";
  items: SimpleLeaf[];
}

const ACTION_TYPE: Record<FieldRuleProperty, "setVisibility" | "setRequired"> = {
  visibility: "setVisibility",
  required: "setRequired",
};

function clone(def: FormDefinition): FormDefinition {
  return structuredClone(def);
}

function isLeaf(condition: Condition): condition is SimpleLeaf {
  return "fieldId" in condition;
}

/** The simple form of a condition, or undefined when it nests groups the builder cannot edit. */
export function toSimpleCondition(condition: Condition): SimpleCondition | undefined {
  if (isLeaf(condition)) return { match: "all", items: [condition] };
  if ("all" in condition && condition.all.every(isLeaf)) return { match: "all", items: condition.all as SimpleLeaf[] };
  if ("any" in condition && condition.any.every(isLeaf)) return { match: "any", items: condition.any as SimpleLeaf[] };
  return undefined;
}

export function fromSimpleCondition(simple: SimpleCondition): Condition {
  if (simple.items.length === 0) throw new BuilderError("A condition needs at least one comparison.");
  if (simple.items.length === 1) return simple.items[0]!;
  return simple.match === "all" ? { all: simple.items } : { any: simple.items };
}

/** Questions in respondent order, with the page each is on. */
function traversal(def: FormDefinition): Array<{ field: Field; pageIndex: number }> {
  const byId = new Map(def.fields.map((f) => [f.id, f]));
  return def.pages.flatMap((page, pageIndex) =>
    page.fieldIds.flatMap((id) => {
      const field = byId.get(id);
      return field ? [{ field, pageIndex }] : [];
    }),
  );
}

/**
 * Questions a rule may depend on: for a question rule, every question before
 * it; for a page skip, every question on that page or earlier. This
 * earlier-only constraint keeps rules acyclic (docs/03 Â§3).
 */
export function conditionFieldsFor(def: FormDefinition, target: { kind: "field" | "page"; id: string }): Field[] {
  const order = traversal(def);
  if (target.kind === "field") {
    const index = order.findIndex((e) => e.field.id === target.id);
    return index < 0 ? [] : order.slice(0, index).map((e) => e.field);
  }
  const pageIndex = def.pages.findIndex((p) => p.id === target.id);
  return order.filter((e) => e.pageIndex <= pageIndex).map((e) => e.field);
}

export function operatorsFor(field: Field): readonly Operator[] {
  return FIELD_REGISTRY[field.type].operators;
}

export function needsValue(op: Operator): op is ComparisonOperator {
  return !(PRESENCE_OPERATORS as readonly string[]).includes(op);
}

/** A first comparison that is always valid: "is answered". */
export function defaultLeaf(field: Field): SimpleLeaf {
  return { fieldId: field.id, op: "isNotEmpty" };
}

/** A sensible starting value when switching to an operator that needs one. */
export function defaultLiteral(field: Field): Literal {
  switch (FIELD_REGISTRY[field.type].kind) {
    case "choice":
    case "multi_choice":
      return field.settings.options?.[0]?.id ?? "";
    case "boolean":
      return true;
    case "integer":
      return typeof field.settings.min === "number" ? field.settings.min : 0;
    case "decimal":
      return decimalFromLiteral(field.settings.min ?? "0") ?? "0";
    case "date":
      return typeof field.settings.min === "string" ? field.settings.min : "2026-01-01";
    case "time":
      return typeof field.settings.min === "string" ? field.settings.min : "09:00";
    default:
      return "";
  }
}

// Question rules ---------------------------------------------------------------

export function fieldRuleOf(def: FormDefinition, fieldId: string, property: FieldRuleProperty): Rule | undefined {
  return def.rules.find(
    (r) => r.action.type === ACTION_TYPE[property] && "targetFieldId" in r.action && r.action.targetFieldId === fieldId,
  );
}

/**
 * Creates or replaces the single rule controlling one property of a question.
 * `whenTrue` is the property's value while the condition holds: for
 * visibility, true = "show only when", false = "hide when"; for required,
 * true = "required only when", false = "optional when".
 */
export function setFieldRule(
  def: FormDefinition,
  fieldId: string,
  property: FieldRuleProperty,
  when: Condition,
  whenTrue: boolean,
): { definition: FormDefinition; ruleId: string } {
  if (!def.fields.some((f) => f.id === fieldId)) throw new BuilderError(`Unknown field "${fieldId}".`);
  const next = clone(def);
  const existing = fieldRuleOf(next, fieldId, property);
  const action = { type: ACTION_TYPE[property], targetFieldId: fieldId, onTrue: whenTrue, onFalse: !whenTrue };
  if (existing) {
    existing.when = when;
    existing.action = action;
    return { definition: next, ruleId: existing.id };
  }
  const ruleId = newId("rule", new Set(next.rules.map((r) => r.id)));
  next.rules.push({ id: ruleId, when, action });
  return { definition: next, ruleId };
}

// Page skips -------------------------------------------------------------------

export function skipRuleOf(def: FormDefinition, pageId: string): Rule | undefined {
  return def.rules.find((r) => r.action.type === "skipToPage" && r.action.sourcePageId === pageId);
}

/** Pages a skip from `pageId` may jump to: only later pages, never back. */
export function skipTargetsFor(def: FormDefinition, pageId: string) {
  const index = def.pages.findIndex((p) => p.id === pageId);
  return index < 0 ? [] : def.pages.slice(index + 2);
}

/** Creates or replaces the page's single skip rule. */
export function setSkipRule(
  def: FormDefinition,
  sourcePageId: string,
  targetPageId: string,
  when: Condition,
): { definition: FormDefinition; ruleId: string } {
  if (!def.pages.some((p) => p.id === sourcePageId)) throw new BuilderError(`Unknown page "${sourcePageId}".`);
  const next = clone(def);
  const existing = skipRuleOf(next, sourcePageId);
  const action = { type: "skipToPage" as const, sourcePageId, targetPageId };
  if (existing) {
    existing.when = when;
    existing.action = action;
    return { definition: next, ruleId: existing.id };
  }
  const ruleId = newId("rule", new Set(next.rules.map((r) => r.id)));
  next.rules.push({ id: ruleId, when, action });
  return { definition: next, ruleId };
}

export function removeRule(def: FormDefinition, ruleId: string): FormDefinition {
  if (!def.rules.some((r) => r.id === ruleId)) throw new BuilderError(`Unknown rule "${ruleId}".`);
  const next = clone(def);
  next.rules = next.rules.filter((r) => r.id !== ruleId);
  return next;
}

// Problems ---------------------------------------------------------------------

/** Engine issues for one rule (cycles, conflicts, backward skips, bad operators or values). */
export function ruleProblems(def: FormDefinition, ruleId: string): DefinitionIssue[] {
  const index = def.rules.findIndex((r) => r.id === ruleId);
  if (index < 0) return [];
  const prefix = `/rules/${index}`;
  return validateDraft(def).issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}/`));
}

/**
 * Applies a rule edit only if the edited rule has no problems, so the builder
 * never creates a cycle, conflict or backward skip. Returns the new
 * definition, or the first problem's message.
 */
export function guardRuleEdit(
  result: { definition: FormDefinition; ruleId: string },
): { ok: true; definition: FormDefinition } | { ok: false; message: string } {
  const problems = ruleProblems(result.definition, result.ruleId);
  return problems.length === 0 ? { ok: true, definition: result.definition } : { ok: false, message: problems[0]!.message };
}
