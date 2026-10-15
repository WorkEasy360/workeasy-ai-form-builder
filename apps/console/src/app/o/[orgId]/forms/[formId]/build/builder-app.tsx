"use client";

import {
  addField,
  addPage,
  BuilderError,
  duplicateField,
  FIELD_TYPE_INFO,
  fieldRuleOf,
  moveField,
  movePage,
  PALETTE_GROUPS,
  removeField,
  removePage,
  skipRuleOf,
  type AutosaveState,
} from "@workeasy/builder";
import { validateDraft } from "@workeasy/form-engine";
import { FormField, RENDERER_CSS } from "@workeasy/form-renderer";
import type { FieldType, FormDefinition } from "@workeasy/form-schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type FormResponse } from "../../../../../../lib/api";
import { ConflictPanel } from "./conflict-panel";
import { FieldInspector, FormInspector, PageInspector } from "./inspector";
import { BUILDER_CSS } from "./styles";
import { useEditor, type DraftBody } from "./use-editor";

type Load =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "not-found" }
  | { kind: "read-only" }
  | { kind: "error"; message: string }
  | { kind: "ready"; formName: string; archived: boolean; draft: DraftBody };

type Selection = { kind: "form" } | { kind: "page"; id: string } | { kind: "field"; id: string };

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.problem.title : "Something went wrong.";
}

/** Marks questions whose visibility or requirement a rule decides. */
function RuleBadges({ definition, fieldId }: { definition: FormDefinition; fieldId: string }) {
  const badges = [
    fieldRuleOf(definition, fieldId, "visibility") && "Conditional",
    fieldRuleOf(definition, fieldId, "required") && "Required by rule",
  ].filter(Boolean);
  if (badges.length === 0) return null;
  return <p className="b-badge">{badges.join(" · ")}</p>;
}

/** Tells the author where a page's skip rule leads. */
function SkipNote({ definition, pageId }: { definition: FormDefinition; pageId: string }) {
  const rule = skipRuleOf(definition, pageId);
  if (rule?.action.type !== "skipToPage") return null;
  const { targetPageId } = rule.action;
  const index = definition.pages.findIndex((p) => p.id === targetPageId);
  const target = definition.pages[index];
  return (
    <p className="b-badge">
      After this page, respondents may skip to {target?.title || `page ${index + 1}`}. Edit the page to change when.
    </p>
  );
}

function statusText(state: AutosaveState): string {
  switch (state.kind) {
    case "saved":
      return "All changes saved";
    case "pending":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "retrying":
      return `Couldn't save (${state.message}). Retrying in ${Math.round(state.retryInMs / 1000)}s…`;
    case "rejected":
      return `Not saved: ${state.message}`;
    case "conflict":
      return "Not saved: changed elsewhere";
  }
}

/** True when a keyboard shortcut should be left to the focused text control (its own undo). */
function inTextControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/** Loads the form and its draft, then hands over to the editor. */
export function BuilderApp({ orgId, formId }: { orgId: string; formId: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const formPath = `/api/v1/organizations/${orgId}/forms/${formId}`;
  const listHref = `/o/${orgId}/forms`;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<FormResponse>(formPath), api<DraftBody>(`${formPath}/draft`)])
      .then(([form, draft]) => {
        if (!cancelled) setLoad({ kind: "ready", formName: form.form.name, archived: form.form.state === "archived", draft });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.problem.status : 0;
        if (status === 401) setLoad({ kind: "signed-out" });
        else if (status === 404) setLoad({ kind: "not-found" });
        else if (status === 403) setLoad({ kind: "read-only" });
        else setLoad({ kind: "error", message: errorText(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [formPath]);

  if (load.kind === "loading") return <p role="status" style={{ padding: 16 }}>Loading the form…</p>;
  if (load.kind === "signed-out") {
    return (
      <p style={{ padding: 16 }}>
        Your session has ended. <a href="/auth/login">Sign in</a> to continue.
      </p>
    );
  }
  if (load.kind !== "ready") {
    const text =
      load.kind === "not-found"
        ? "This form doesn't exist or you don't have access to it."
        : load.kind === "read-only"
          ? "You can see this form but you don't have permission to edit it."
          : load.message;
    return (
      <main style={{ padding: 16 }}>
        <p role={load.kind === "error" ? "alert" : undefined}>{text}</p>
        <p>
          <a href={listHref}>Back to forms</a>
        </p>
      </main>
    );
  }
  return <Editor draftPath={`${formPath}/draft`} listHref={listHref} formName={load.formName} archived={load.archived} initial={load.draft} />;
}

function Editor({
  draftPath,
  listHref,
  formName,
  archived,
  initial,
}: {
  draftPath: string;
  listHref: string;
  formName: string;
  archived: boolean;
  initial: DraftBody;
}) {
  const editor = useEditor(draftPath, initial);
  const definition = editor.definition;
  const [selected, setSelected] = useState<Selection>({ kind: "form" });
  const [currentPageId, setCurrentPageId] = useState<string | undefined>();
  const [notice, setNotice] = useState("");

  const issues = useMemo(() => validateDraft(definition).issues, [definition]);
  const page = definition.pages.find((p) => p.id === currentPageId) ?? definition.pages[0]!;
  const pageIndex = definition.pages.indexOf(page);
  // Undo can remove what was selected; fall back to the form details.
  const selection: Selection =
    (selected.kind === "field" && !definition.fields.some((f) => f.id === selected.id)) ||
    (selected.kind === "page" && !definition.pages.some((p) => p.id === selected.id))
      ? { kind: "form" }
      : selected;
  const readOnly = archived;

  // Keyboard: Ctrl/Cmd+S saves now; Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z or Ctrl+Y redoes,
  // except inside text controls, which keep their own native undo.
  const editorRef = useRef(editor);
  useEffect(() => {
    editorRef.current = editor;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const current = editorRef.current;
      if (key === "s") {
        e.preventDefault();
        void current.saveNow();
      } else if (!readOnly && !inTextControl(e.target) && (key === "z" || key === "y")) {
        e.preventDefault();
        const redo = key === "y" || e.shiftKey;
        if (redo && current.canRedo) {
          current.redo();
          setNotice(`Redid: ${current.redoLabel}`);
        } else if (!redo && current.canUndo) {
          current.undo();
          setNotice(`Undid: ${current.undoLabel}`);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly]);

  // Warn before leaving while anything is unsaved (including during a conflict).
  useEffect(() => {
    if (!editor.unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editor.unsaved]);

  function run(action: () => FormDefinition | { definition: FormDefinition }, message?: string) {
    try {
      const result = action();
      const error = editor.apply("schemaVersion" in result ? result : result.definition);
      if (error) setNotice(error);
      else if (message) setNotice(message);
    } catch (err) {
      setNotice(err instanceof BuilderError ? err.message : "That change isn't possible.");
    }
  }

  function selectPage(id: string) {
    setCurrentPageId(id);
    setSelected({ kind: "page", id });
  }

  return (
    <div className="b-shell">
      <style>{BUILDER_CSS + RENDERER_CSS}</style>
      <header className="b-topbar">
        <div style={{ display: "grid", gap: 2 }}>
          <a href={listHref}>← Forms</a>
          <h1>{formName}</h1>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            className="b-btn"
            disabled={readOnly || !editor.canUndo}
            aria-label={editor.undoLabel ? `Undo ${editor.undoLabel}` : "Undo"}
            title={editor.undoLabel ? `Undo ${editor.undoLabel} (Ctrl+Z)` : undefined}
            onClick={editor.undo}
          >
            Undo
          </button>
          <button
            type="button"
            className="b-btn"
            disabled={readOnly || !editor.canRedo}
            aria-label={editor.redoLabel ? `Redo ${editor.redoLabel}` : "Redo"}
            title={editor.redoLabel ? `Redo ${editor.redoLabel} (Ctrl+Shift+Z)` : undefined}
            onClick={editor.redo}
          >
            Redo
          </button>
          <span role="status" className="b-muted">
            {statusText(editor.saveState)}
          </span>
          <span className="b-muted">{issues.length === 0 ? "Ready to publish" : `${issues.length} to fix before publishing`}</span>
          <button
            type="button"
            className="b-btn b-primary"
            disabled={readOnly || !editor.unsaved || editor.saveState.kind === "saving" || editor.saveState.kind === "conflict"}
            onClick={() => void editor.saveNow()}
          >
            Save now
          </button>
        </div>
      </header>

      {readOnly && <p className="b-banner">This form is archived. Restore it from the forms list to edit it.</p>}
      {editor.saveState.kind === "conflict" && (
        <ConflictPanel
          formName={formName}
          base={editor.base}
          mine={definition}
          theirs={editor.theirs}
          onKeepMine={() => {
            void editor.keepMine().then(() => setNotice("Saved your version."));
          }}
          onUseTheirs={() => {
            editor.acceptTheirs();
            setNotice("Loaded their version. Undo brings yours back.");
          }}
        />
      )}
      <p role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {notice}
      </p>

      <div className="b-columns">
        <nav className="b-panel" aria-label="Pages and questions">
          <h2>Pages</h2>
          <ol className="b-list">
            {definition.pages.map((p, i) => (
              <li key={p.id} className="b-row">
                <button type="button" className="b-btn b-grow" aria-current={p.id === page.id ? "true" : undefined} onClick={() => selectPage(p.id)}>
                  {p.title || `Page ${i + 1}`}
                  {skipRuleOf(definition, p.id) && <span className="b-badge"> · skips ahead</span>}
                </button>
                <button type="button" className="b-btn" disabled={readOnly || i === 0} aria-label={`Move ${p.title || `page ${i + 1}`} up`} onClick={() => run(() => movePage(definition, p.id, -1))}>
                  ↑
                </button>
                <button
                  type="button"
                  className="b-btn"
                  disabled={readOnly || i === definition.pages.length - 1}
                  aria-label={`Move ${p.title || `page ${i + 1}`} down`}
                  onClick={() => run(() => movePage(definition, p.id, 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="b-btn"
                  disabled={readOnly || definition.pages.length <= 1 || p.fieldIds.length > 0}
                  title={p.fieldIds.length > 0 ? "Move or delete this page's questions first" : undefined}
                  aria-label={`Delete ${p.title || `page ${i + 1}`}`}
                  onClick={() => {
                    run(() => removePage(definition, p.id), "Page deleted.");
                    if (p.id === page.id) setCurrentPageId(undefined);
                    setSelected({ kind: "form" });
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ol>
          <p>
            <button
              type="button"
              className="b-btn"
              disabled={readOnly || definition.pages.length >= 20}
              onClick={() => {
                const added = addPage(definition, page.id);
                if (!editor.apply(added.definition)) selectPage(added.pageId);
              }}
            >
              Add page
            </button>
          </p>

          <h2>Add a question</h2>
          <p className="b-muted" style={{ marginTop: 0 }}>
            Adds to {page.title || `page ${pageIndex + 1}`}.
          </p>
          {PALETTE_GROUPS.map(({ group, types }) => (
            <div key={group} role="group" aria-label={group} style={{ marginBottom: 12 }}>
              <h3 style={{ fontSize: 13, margin: "0 0 4px" }} className="b-muted">
                {group}
              </h3>
              <div className="b-palette">
                {types.map((type: FieldType) => (
                  <button
                    key={type}
                    type="button"
                    className="b-btn"
                    style={{ textAlign: "left" }}
                    disabled={readOnly || definition.fields.length >= 100}
                    onClick={() => {
                      const added = addField(definition, type, page.id);
                      const error = editor.apply(added.definition);
                      if (error) setNotice(error);
                      else {
                        setSelected({ kind: "field", id: added.fieldId });
                        setNotice(`Added ${FIELD_TYPE_INFO[type].label}.`);
                      }
                    }}
                  >
                    {FIELD_TYPE_INFO[type].label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <main className="b-canvas" aria-label="Form preview">
          <h2 style={{ marginTop: 0 }}>{definition.title}</h2>
          {page.title && <h3>{page.title}</h3>}
          {page.fieldIds.length === 0 && <p className="b-muted">This page has no questions yet. Add one from the list on the left.</p>}
          <SkipNote definition={definition} pageId={page.id} />
          {page.fieldIds.map((fieldId, i) => {
            const field = definition.fields.find((f) => f.id === fieldId);
            if (!field) return null;
            const isSelected = selection.kind === "field" && selection.id === field.id;
            const name = field.label || FIELD_TYPE_INFO[field.type].label;
            const first = pageIndex === 0 && i === 0;
            const last = pageIndex === definition.pages.length - 1 && i === page.fieldIds.length - 1;
            return (
              <div key={field.id} className="b-card" data-selected={isSelected ? "true" : undefined} onClick={() => setSelected({ kind: "field", id: field.id })}>
                <div className="b-card-tools" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="b-btn" aria-pressed={isSelected} aria-label={`Edit ${name}`} onClick={() => setSelected({ kind: "field", id: field.id })}>
                    Edit
                  </button>
                  <button type="button" className="b-btn" disabled={readOnly || first} aria-label={`Move ${name} up`} onClick={() => run(() => moveField(definition, field.id, -1))}>
                    ↑
                  </button>
                  <button type="button" className="b-btn" disabled={readOnly || last} aria-label={`Move ${name} down`} onClick={() => run(() => moveField(definition, field.id, 1))}>
                    ↓
                  </button>
                  <button
                    type="button"
                    className="b-btn"
                    disabled={readOnly || definition.fields.length >= 100}
                    aria-label={`Duplicate ${name}`}
                    onClick={() => {
                      const copy = duplicateField(definition, field.id);
                      if (!editor.apply(copy.definition)) setSelected({ kind: "field", id: copy.fieldId });
                    }}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="b-btn"
                    disabled={readOnly}
                    aria-label={`Delete ${name}`}
                    onClick={() => {
                      const { definition: next, removedRules } = removeField(definition, field.id);
                      const extra = removedRules.length > 0 ? ` and ${removedRules.length} rule${removedRules.length === 1 ? "" : "s"} that depend on it` : "";
                      // Deleting can be undone, so only ask when rules go with it.
                      if (removedRules.length > 0 && !window.confirm(`Delete "${name}"${extra}?`)) return;
                      const error = editor.apply(next);
                      if (error) setNotice(error);
                      else {
                        setSelected({ kind: "form" });
                        setNotice(`Deleted ${name}${extra}. Undo brings it back.`);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
                <RuleBadges definition={definition} fieldId={field.id} />
                <FormField field={field} value={undefined} required={field.required} disabled onChange={() => undefined} idPrefix="canvas" />
              </div>
            );
          })}
        </main>

        <aside className="b-panel" aria-label="Properties">
          <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {selection.kind === "field" ? (
              <FieldInspector definition={definition} fieldId={selection.id} issues={issues} tryApply={editor.apply} />
            ) : selection.kind === "page" ? (
              <PageInspector definition={definition} pageId={selection.id} tryApply={editor.apply} />
            ) : (
              <FormInspector definition={definition} tryApply={editor.apply} />
            )}
          </fieldset>
          {selection.kind !== "field" && issues.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h2>To fix before publishing</h2>
              <ul className="b-issues">
                {issues.map((issue) => (
                  <li key={`${issue.path}:${issue.code}`}>{issue.code === "SCHEMA_MINITEMS" && issue.path === "/fields" ? "Add at least one question." : issue.message}</li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
