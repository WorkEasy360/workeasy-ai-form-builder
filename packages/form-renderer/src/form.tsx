import { evaluate, type AnswerError, type AnswerValue } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { FormField } from "./fields";
import { themeStyle } from "./theme";

/**
 * The complete respondent runtime (docs/01 §3, docs/03 §3), shared by the
 * builder preview and the public form. It evaluates the definition with the
 * same engine the server uses, so visibility, required state and page
 * routing match what the server will accept.
 *
 * Accessibility: errors appear after the respondent tries to continue, in a
 * summary that takes focus and links to each question; moving between pages
 * focuses the new page's heading; the success message takes focus.
 */

export type Answers = Record<string, AnswerValue>;

export interface FormRendererProps {
  definition: FormDefinition;
  /**
   * Receives the canonical answers once every reachable page is valid.
   * Resolve with an error message to show it, or with nothing on success.
   */
  onSubmit: (answers: Answers) => Promise<string | undefined> | string | undefined;
  /** Keeps element IDs unique when several renderers share a page. */
  idPrefix?: string | undefined;
  /** 1 on the public form; 2 when embedded under another page heading (preview). */
  titleLevel?: 1 | 2 | undefined;
  /** Shown on the success screen, e.g. "Start again" in a preview. */
  restartLabel?: string | undefined;
}

type Phase = { kind: "filling" } | { kind: "submitting" } | { kind: "failed"; message: string } | { kind: "done" };

/** Only answers to questions that still exist, so a changing preview never reports unknown fields. */
function knownAnswers(definition: FormDefinition, answers: Answers): Answers {
  const ids = new Set(definition.fields.map((f) => f.id));
  return Object.fromEntries(Object.entries(answers).filter(([id]) => ids.has(id)));
}

function focusControl(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  // Groups (fieldsets) are not focusable themselves; focus their first choice.
  const focusable = target.matches("input, select, textarea") ? target : target.querySelector<HTMLElement>("input, select, textarea");
  (focusable ?? target).focus();
  target.scrollIntoView?.({ block: "center" });
}

export function FormRenderer({ definition, onSubmit, idPrefix = "we", titleLevel = 1, restartLabel }: FormRendererProps) {
  const [answers, setAnswers] = useState<Answers>({});
  const [pageId, setPageId] = useState<string | undefined>();
  const [attempted, setAttempted] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<Phase>({ kind: "filling" });
  const focusRef = useRef<"page" | "summary" | "done" | undefined>(undefined);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);

  const evaluation = useMemo(() => evaluate(definition, knownAnswers(definition, answers)), [definition, answers]);
  const reachable = evaluation.reachablePageIds;
  // The page shown: the chosen one while it is still on the respondent's path, otherwise the first.
  const currentId = pageId !== undefined && reachable.includes(pageId) ? pageId : reachable[0];
  const page = definition.pages.find((p) => p.id === currentId) ?? definition.pages[0]!;
  const position = reachable.indexOf(page.id);
  const isLast = position === reachable.length - 1;
  const visible = new Set(evaluation.visibleFieldIds);
  const required = new Set(evaluation.requiredFieldIds);
  const fieldsOnPage = page.fieldIds.flatMap((id) => {
    const field = definition.fields.find((f) => f.id === id);
    return field && visible.has(id) ? [field] : [];
  });
  const errorsOnPage = (errors: AnswerError[]) => errors.filter((e) => fieldsOnPage.some((f) => f.id === e.fieldId));
  const shownErrors = attempted.has(page.id) ? errorsOnPage(evaluation.errors) : [];
  const errorFor = new Map(shownErrors.map((e) => [e.fieldId, e.message]));

  useEffect(() => {
    const target = focusRef.current;
    focusRef.current = undefined;
    if (target === "page") pageHeading.current?.focus();
    else if (target === "summary") summary.current?.focus();
    else if (target === "done") doneHeading.current?.focus();
  });

  const Title = titleLevel === 1 ? "h1" : "h2";
  const PageHeading = titleLevel === 1 ? "h2" : "h3";
  const multiPage = reachable.length > 1 || definition.pages.length > 1;
  const controlId = (fieldId: string) => `${idPrefix}-${fieldId}-control`;

  function goTo(id: string | undefined) {
    if (id === undefined) return;
    setPageId(id);
    focusRef.current = "page";
  }

  async function next() {
    const problems = errorsOnPage(evaluation.errors);
    if (problems.length > 0) {
      setAttempted((prev) => new Set(prev).add(page.id));
      focusRef.current = "summary";
      return;
    }
    if (!isLast) {
      goTo(reachable[position + 1]);
      return;
    }
    // Last page: anything still wrong elsewhere sends the respondent back there.
    const firstBad = evaluation.errors.find((e) => e.fieldId !== "");
    const badPage = firstBad && definition.pages.find((p) => p.fieldIds.includes(firstBad.fieldId));
    if (badPage) {
      setAttempted((prev) => new Set(prev).add(badPage.id));
      setPageId(badPage.id);
      focusRef.current = "summary";
      return;
    }
    setPhase({ kind: "submitting" });
    try {
      const message = await onSubmit(evaluation.answers);
      if (message) {
        setPhase({ kind: "failed", message });
        focusRef.current = "summary";
      } else {
        setPhase({ kind: "done" });
        focusRef.current = "done";
      }
    } catch {
      setPhase({ kind: "failed", message: "Your answers couldn't be sent. Check your connection and try again." });
      focusRef.current = "summary";
    }
  }

  function restart() {
    setAnswers({});
    setPageId(undefined);
    setAttempted(new Set());
    setPhase({ kind: "filling" });
    focusRef.current = "page";
  }

  if (phase.kind === "done") {
    return (
      <div className="we-surface" style={themeStyle(definition.theme)}>
        <div className="we-form">
          <Title ref={doneHeading} tabIndex={-1} className="we-title">
            {definition.title}
          </Title>
          <p className="we-success">{definition.success.message}</p>
          {restartLabel && (
            <button type="button" className="we-button" onClick={restart}>
              {restartLabel}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="we-surface" style={themeStyle(definition.theme)}>
      <div className="we-form">
        <Title className="we-title" ref={multiPage ? undefined : pageHeading} tabIndex={multiPage ? undefined : -1}>
          {definition.title}
        </Title>
        {definition.description && <p className="we-description">{definition.description}</p>}
        <form
          noValidate
          aria-label={definition.title}
          onSubmit={(e) => {
            e.preventDefault();
            void next();
          }}
        >
          {multiPage && (
            <div className="we-page-header">
              <PageHeading ref={pageHeading} tabIndex={-1} className="we-page-title">
                {page.title || `Page ${position + 1}`}
              </PageHeading>
              <p className="we-progress">
                Page {position + 1} of {reachable.length}
              </p>
            </div>
          )}

          {(shownErrors.length > 0 || phase.kind === "failed") && (
            <div ref={summary} tabIndex={-1} role="alert" className="we-error-summary" aria-labelledby={`${idPrefix}-summary-title`}>
              <p id={`${idPrefix}-summary-title`} className="we-error-summary-title">
                {phase.kind === "failed"
                  ? phase.message
                  : shownErrors.length === 1
                    ? "There is 1 problem to fix"
                    : `There are ${shownErrors.length} problems to fix`}
              </p>
              {shownErrors.length > 0 && (
                <ul>
                  {shownErrors.map((e) => {
                    const label = definition.fields.find((f) => f.id === e.fieldId)?.label ?? "";
                    return (
                      <li key={e.fieldId}>
                        <a href={`#${controlId(e.fieldId)}`} onClick={(event) => focusControl(event, controlId(e.fieldId))}>
                          {/[?:.!]$/.test(label) ? label : `${label}:`} {e.message}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {fieldsOnPage.length === 0 && <p className="we-help">There are no questions on this page.</p>}
          {fieldsOnPage.map((field) => (
            <FormField
              key={field.id}
              field={field}
              idPrefix={idPrefix}
              value={answers[field.id]}
              required={required.has(field.id)}
              error={errorFor.get(field.id)}
              onChange={(value) =>
                setAnswers((prev) => {
                  const nextAnswers = { ...prev };
                  if (value === undefined) delete nextAnswers[field.id];
                  else nextAnswers[field.id] = value;
                  return nextAnswers;
                })
              }
            />
          ))}

          <div className="we-actions">
            {position > 0 && (
              <button type="button" className="we-button" onClick={() => goTo(reachable[position - 1])}>
                Back
              </button>
            )}
            <button type="submit" className="we-button we-button-primary" disabled={phase.kind === "submitting"}>
              {isLast ? (phase.kind === "submitting" ? "Submitting…" : "Submit") : "Next"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
