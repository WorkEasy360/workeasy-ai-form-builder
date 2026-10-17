"use client";

import {
  conditionFieldsFor,
  defaultLeaf,
  defaultLiteral,
  FIELD_TYPE_INFO,
  fieldRuleOf,
  fromSimpleCondition,
  guardRuleEdit,
  needsValue,
  operatorsFor,
  removeRule,
  ruleProblems,
  setFieldRule,
  setSkipRule,
  skipRuleOf,
  skipTargetsFor,
  toSimpleCondition,
  type FieldRuleProperty,
  type SimpleCondition,
  type SimpleLeaf,
} from "@workeasy/builder";
import { canonicalDecimal, FIELD_REGISTRY, isLayoutType } from "@workeasy/form-engine";
import type { Condition, Field, FormDefinition, Literal, Operator } from "@workeasy/form-schema";
import { useId, useState } from "react";
import { CommitInput, type TryApply } from "./controls";

/**
 * Rule editing (docs/03 §3) inside the question and page inspectors. Every
 * edit goes through guardRuleEdit, so the builder never creates a cycle,
 * conflict, backward skip or a value that doesn't suit the question.
 */

function operatorLabel(field: Field, op: Operator): string {
  const kind = FIELD_REGISTRY[field.type].kind;
  const temporal = kind === "date" || kind === "time";
  switch (op) {
    case "eq":
      return "is";
    case "neq":
      return "is not";
    case "gt":
      return temporal ? "is after" : "is more than";
    case "gte":
      return temporal ? "is on or after" : "is at least";
    case "lt":
      return temporal ? "is before" : "is less than";
    case "lte":
      return temporal ? "is on or before" : "is at most";
    case "contains":
      return kind === "multi_choice" ? "includes" : "contains";
    case "isEmpty":
      return "is not answered";
    case "isNotEmpty":
      return "is answered";
  }
}

const fieldName = (f: Field) => f.label || FIELD_TYPE_INFO[f.type].label;

/** Value control for one comparison, typed by the question it compares. */
function ValueInput({ field, value, onChange }: { field: Field; value: Literal; onChange: (v: Literal) => string | undefined }) {
  const id = useId();
  const kind = FIELD_REGISTRY[field.type].kind;
  if (kind === "choice" || kind === "multi_choice") {
    return (
      <div className="b-field">
        <label htmlFor={id}>Value</label>
        <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {(field.settings.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (kind === "boolean") {
    return (
      <div className="b-field">
        <label htmlFor={id}>Value</label>
        <select id={id} value={value === true ? "true" : "false"} onChange={(e) => onChange(e.target.value === "true")}>
          <option value="true">{field.type === "consent" ? "agreed" : "ticked"}</option>
          <option value="false">{field.type === "consent" ? "not agreed" : "not ticked"}</option>
        </select>
      </div>
    );
  }
  if (kind === "date" || kind === "time") {
    return (
      <div className="b-field">
        <label htmlFor={id}>Value</label>
        <input id={id} type={kind} value={String(value)} onChange={(e) => e.target.value && onChange(e.target.value)} />
      </div>
    );
  }
  if (kind === "integer") {
    return (
      <CommitInput
        label="Value"
        type="number"
        value={String(value)}
        onCommit={(t) => {
          const n = Number(t);
          return t.trim() === "" || !Number.isSafeInteger(n) ? "Enter a whole number." : onChange(n);
        }}
      />
    );
  }
  if (kind === "decimal") {
    return (
      <CommitInput
        label="Value"
        value={String(value)}
        onCommit={(t) => {
          const canonical = canonicalDecimal(t.trim());
          return canonical === undefined ? "Enter a number, for example 12.50." : onChange(canonical);
        }}
      />
    );
  }
  return <CommitInput label="Value" value={String(value)} onCommit={(t) => onChange(t)} />;
}

function ConditionEditor({
  candidates,
  condition,
  onChange,
  verb,
}: {
  candidates: Field[];
  condition: SimpleCondition;
  onChange: (next: SimpleCondition) => string | undefined;
  verb: string;
}) {
  const matchId = useId();
  const [error, setError] = useState<string | undefined>();
  const change = (next: SimpleCondition) => {
    const result = onChange(next);
    setError(result);
    return result;
  };
  const replaceItem = (index: number, item: SimpleLeaf) =>
    change({ ...condition, items: condition.items.map((it, i) => (i === index ? item : it)) });

  return (
    <div>
      {condition.items.length > 1 && (
        <div className="b-field">
          <label htmlFor={matchId}>{verb}</label>
          <select id={matchId} value={condition.match} onChange={(e) => change({ ...condition, match: e.target.value as "all" | "any" })}>
            <option value="all">all of these are true</option>
            <option value="any">any of these is true</option>
          </select>
        </div>
      )}
      <ol className="b-list" style={{ listStyle: "decimal", paddingLeft: 20, gap: 8 }}>
        {condition.items.map((item, index) => {
          const field = candidates.find((f) => f.id === item.fieldId);
          return (
            <li key={index} style={{ borderLeft: "2px solid var(--we-color-border)", paddingLeft: 8 }}>
              <ConditionRow
                candidates={candidates}
                item={item}
                field={field}
                onChange={(next) => replaceItem(index, next)}
              />
              <button
                type="button"
                className="b-btn"
                disabled={condition.items.length <= 1}
                aria-label={`Remove condition ${index + 1}`}
                onClick={() => change({ ...condition, items: condition.items.filter((_, i) => i !== index) })}
              >
                Remove condition
              </button>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="b-btn"
        style={{ marginTop: 8 }}
        disabled={condition.items.length >= 20}
        onClick={() => change({ ...condition, items: [...condition.items, defaultLeaf(candidates[0]!)] })}
      >
        Add condition
      </button>
      {error && (
        <p role="alert" className="b-inline-error">
          {error}
        </p>
      )}
    </div>
  );
}

function ConditionRow({
  candidates,
  item,
  field,
  onChange,
}: {
  candidates: Field[];
  item: SimpleLeaf;
  field: Field | undefined;
  onChange: (next: SimpleLeaf) => string | undefined;
}) {
  const questionId = useId();
  const operatorId = useId();
  return (
    <>
      <div className="b-field">
        <label htmlFor={questionId}>Question</label>
        <select
          id={questionId}
          value={field ? item.fieldId : ""}
          onChange={(e) => {
            const next = candidates.find((f) => f.id === e.target.value);
            if (next) onChange(defaultLeaf(next));
          }}
        >
          {!field && <option value="">(question no longer available)</option>}
          {candidates.map((f) => (
            <option key={f.id} value={f.id}>
              {fieldName(f)}
            </option>
          ))}
        </select>
      </div>
      {field && (
        <>
          <div className="b-field">
            <label htmlFor={operatorId}>Condition</label>
            <select
              id={operatorId}
              value={item.op}
              onChange={(e) => {
                const op = e.target.value as Operator;
                if (!needsValue(op)) onChange({ fieldId: field.id, op } as SimpleLeaf);
                else onChange({ fieldId: field.id, op, value: "value" in item ? item.value : defaultLiteral(field) });
              }}
            >
              {operatorsFor(field).map((op) => (
                <option key={op} value={op}>
                  {operatorLabel(field, op)}
                </option>
              ))}
            </select>
          </div>
          {"value" in item && (
            <ValueInput field={field} value={item.value} onChange={(value) => onChange({ fieldId: field.id, op: item.op, value })} />
          )}
        </>
      )}
    </>
  );
}

function ProblemList({ definition, ruleId }: { definition: FormDefinition; ruleId: string }) {
  const problems = ruleProblems(definition, ruleId);
  if (problems.length === 0) return null;
  return (
    <ul className="b-issues" role="alert" style={{ color: "var(--we-color-danger)" }}>
      {problems.map((p) => (
        <li key={`${p.path}:${p.code}`}>{p.message}</li>
      ))}
    </ul>
  );
}

const FIELD_RULE_TEXT: Record<FieldRuleProperty, { heading: string; add: string; modes: [string, string] }> = {
  visibility: {
    heading: "When to show",
    add: "Show this question only when…",
    modes: ["Show only when", "Hide when"],
  },
  required: {
    heading: "When to require an answer",
    add: "Require an answer only when…",
    modes: ["Required only when", "Optional when"],
  },
};

/** Show/hide and required/optional rules for one question. */
export function FieldLogic({ definition, field, tryApply }: { definition: FormDefinition; field: Field; tryApply: TryApply }) {
  const candidates = conditionFieldsFor(definition, { kind: "field", id: field.id });
  return (
    <section aria-labelledby={`${field.id}-logic`} style={{ marginTop: 16 }}>
      <h3 id={`${field.id}-logic`} style={{ fontSize: 15, margin: "0 0 8px" }}>
        Logic
      </h3>
      {candidates.length === 0 && !fieldRuleOf(definition, field.id, "visibility") && !fieldRuleOf(definition, field.id, "required") ? (
        <p className="b-muted">Only questions before this one can control it. Add a question above it to use conditions.</p>
      ) : (
        (isLayoutType(field.type) ? (["visibility"] as const) : (["visibility", "required"] as const)).map((property) => (
          <FieldRuleEditor key={property} definition={definition} field={field} property={property} candidates={candidates} tryApply={tryApply} />
        ))
      )}
    </section>
  );
}

function FieldRuleEditor({
  definition,
  field,
  property,
  candidates,
  tryApply,
}: {
  definition: FormDefinition;
  field: Field;
  property: FieldRuleProperty;
  candidates: Field[];
  tryApply: TryApply;
}) {
  const modeId = useId();
  const [error, setError] = useState<string | undefined>();
  const text = FIELD_RULE_TEXT[property];
  const rule = fieldRuleOf(definition, field.id, property);

  const save = (when: Condition, whenTrue: boolean): string | undefined => {
    const guarded = guardRuleEdit(setFieldRule(definition, field.id, property, when, whenTrue));
    return guarded.ok ? tryApply(guarded.definition) : guarded.message;
  };

  if (!rule) {
    return (
      <div className="b-field">
        <button
          type="button"
          className="b-btn"
          disabled={candidates.length === 0}
          onClick={() => setError(save(defaultLeaf(candidates[0]!), true))}
        >
          {text.add}
        </button>
        {error && (
          <p role="alert" className="b-inline-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  const whenTrue = rule.action.type !== "skipToPage" && rule.action.onTrue;
  const simple = toSimpleCondition(rule.when);
  return (
    <fieldset className="b-field" style={{ border: "1px solid var(--we-color-border)", borderRadius: "var(--we-radius-md)", padding: 8 }}>
      <legend>{text.heading}</legend>
      <div className="b-field">
        <label htmlFor={modeId}>Rule</label>
        <select
          id={modeId}
          value={whenTrue ? "true" : "false"}
          onChange={(e) => setError(save(rule.when, e.target.value === "true"))}
        >
          <option value="true">{text.modes[0]}</option>
          <option value="false">{text.modes[1]}</option>
        </select>
      </div>
      {simple ? (
        <ConditionEditor
          candidates={candidates}
          condition={simple}
          verb={whenTrue ? text.modes[0] : text.modes[1]}
          onChange={(next) => save(fromSimpleCondition(next), whenTrue)}
        />
      ) : (
        <p className="b-muted">This rule uses a nested condition that can't be edited here. You can remove it and add a simpler one.</p>
      )}
      <ProblemList definition={definition} ruleId={rule.id} />
      {error && (
        <p role="alert" className="b-inline-error">
          {error}
        </p>
      )}
      <button type="button" className="b-btn" style={{ marginTop: 8 }} onClick={() => tryApply(removeRule(definition, rule.id))}>
        Remove rule
      </button>
    </fieldset>
  );
}

/** The forward skip rule for one page. */
export function PageLogic({ definition, pageId, tryApply }: { definition: FormDefinition; pageId: string; tryApply: TryApply }) {
  const targetId = useId();
  const [error, setError] = useState<string | undefined>();
  const rule = skipRuleOf(definition, pageId);
  const targets = skipTargetsFor(definition, pageId);
  const candidates = conditionFieldsFor(definition, { kind: "page", id: pageId });
  const pageTitle = (id: string) => {
    const index = definition.pages.findIndex((p) => p.id === id);
    return definition.pages[index]?.title || `Page ${index + 1}`;
  };
  const save = (target: string, when: Condition): string | undefined => {
    const guarded = guardRuleEdit(setSkipRule(definition, pageId, target, when));
    return guarded.ok ? tryApply(guarded.definition) : guarded.message;
  };

  return (
    <section aria-labelledby={`${pageId}-logic`} style={{ marginTop: 16 }}>
      <h3 id={`${pageId}-logic`} style={{ fontSize: 15, margin: "0 0 8px" }}>
        Skip ahead
      </h3>
      {!rule ? (
        targets.length === 0 ? (
          <p className="b-muted">Skipping needs at least two pages after this one.</p>
        ) : candidates.length === 0 ? (
          <p className="b-muted">Add a question on this page or an earlier one to decide when to skip.</p>
        ) : (
          <button type="button" className="b-btn" onClick={() => setError(save(targets[0]!.id, defaultLeaf(candidates[0]!)))}>
            After this page, skip ahead when…
          </button>
        )
      ) : (
        <fieldset className="b-field" style={{ border: "1px solid var(--we-color-border)", borderRadius: "var(--we-radius-md)", padding: 8 }}>
          <legend>After this page</legend>
          <div className="b-field">
            <label htmlFor={targetId}>Skip to</label>
            <select
              id={targetId}
              value={rule.action.type === "skipToPage" ? rule.action.targetPageId : ""}
              onChange={(e) => setError(save(e.target.value, rule.when))}
            >
              {targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {pageTitle(p.id)}
                </option>
              ))}
            </select>
          </div>
          {toSimpleCondition(rule.when) ? (
            <ConditionEditor
              candidates={candidates}
              condition={toSimpleCondition(rule.when)!}
              verb="Skip when"
              onChange={(next) => save(rule.action.type === "skipToPage" ? rule.action.targetPageId : targets[0]!.id, fromSimpleCondition(next))}
            />
          ) : (
            <p className="b-muted">This rule uses a nested condition that can't be edited here. You can remove it and add a simpler one.</p>
          )}
          <ProblemList definition={definition} ruleId={rule.id} />
          {error && (
            <p role="alert" className="b-inline-error">
              {error}
            </p>
          )}
          <button type="button" className="b-btn" style={{ marginTop: 8 }} onClick={() => tryApply(removeRule(definition, rule.id))}>
            Remove skip
          </button>
        </fieldset>
      )}
      {error && !rule && (
        <p role="alert" className="b-inline-error">
          {error}
        </p>
      )}
    </section>
  );
}
