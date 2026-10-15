"use client";

import {
  addField,
  addPage,
  BuilderError,
  duplicateField,
  FIELD_TYPE_INFO,
  moveField,
  movePage,
  PALETTE_GROUPS,
  removeField,
  removePage,
} from "@workeasy/builder";
import { validateDraft } from "@workeasy/form-engine";
import { FormField, RENDERER_CSS } from "@workeasy/form-renderer";
import type { FieldType, FormDefinition } from "@workeasy/form-schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type FormResponse } from "../../../../../../lib/api";
import { FieldInspector, FormInspector, PageInspector, type TryApply } from "./inspector";
import { BUILDER_CSS } from "./styles";

interface DraftBody {
  revision: number;
  definition: FormDefinition;
}

type Load =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "not-found" }
  | { kind: "read-only" }
  | { kind: "error"; message: string }
  | { kind: "ready"; formName: string; archived: boolean };

type Selection = { kind: "form" } | { kind: "page"; id: string } | { kind: "field"; id: string };
type SaveState = { kind: "saved" } | { kind: "saving" } | { kind: "conflict" } | { kind: "error"; message: string };

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.problem.title : "Something went wrong.";
}

/** Remounting with a new key reloads the form from the server, discarding local state. */
export function BuilderApp({ orgId, formId }: { orgId: string; formId: string }) {
  const [reloadKey, setReloadKey] = useState(0);
  return <Builder key={reloadKey} orgId={orgId} formId={formId} onReload={() => setReloadKey((k) => k + 1)} />;
}

function Builder({ orgId, formId, onReload }: { orgId: string; formId: string; onReload: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [definition, setDefinition] = useState<FormDefinition | null>(null);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const [selection, setSelection] = useState<Selection>({ kind: "form" });
  const [currentPageId, setCurrentPageId] = useState<string | undefined>();
  const [notice, setNotice] = useState("");

  const formPath = `/api/v1/organizations/${orgId}/forms/${formId}`;
  const listHref = `/o/${orgId}/forms`;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<FormResponse>(formPath), api<DraftBody>(`${formPath}/draft`)])
      .then(([form, draft]) => {
        if (cancelled) return;
        setDefinition(draft.definition);
        setRevision(draft.revision);
        setDirty(false);
        setSave({ kind: "saved" });
        setLoad({ kind: "ready", formName: form.form.name, archived: form.form.state === "archived" });
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

  const issues = useMemo(() => (definition ? validateDraft(definition).issues : []), [definition]);
  const page = definition?.pages.find((p) => p.id === currentPageId) ?? definition?.pages[0];

  /** Applies an edit when the result is still a saveable draft; otherwise explains why not. */
  const tryApply: TryApply = useCallback((next) => {
    const checked = validateDraft(next);
    if (!checked.ok) return checked.issues[0]?.message ?? "That change isn't possible.";
    setDefinition(next);
    setDirty(true);
    return undefined;
  }, []);

  function run(action: () => FormDefinition | { definition: FormDefinition }, message?: string) {
    try {
      const result = action();
      const error = tryApply("definition" in result && !("schemaVersion" in result) ? result.definition : (result as FormDefinition));
      if (error) setNotice(error);
      else if (message) setNotice(message);
    } catch (err) {
      setNotice(err instanceof BuilderError ? err.message : "That change isn't possible.");
    }
  }

  const saveDraft = useCallback(async () => {
    if (!definition || !dirty || save.kind === "saving") return;
    setSave({ kind: "saving" });
    try {
      const saved = await api<{ revision: number }>(`${formPath}/draft`, {
        method: "PUT",
        body: definition,
        headers: { "If-Match": `"draft-${revision}"` },
      });
      setRevision(saved.revision);
      setDirty(false);
      setSave({ kind: "saved" });
      setNotice("All changes saved.");
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 412) setSave({ kind: "conflict" });
      else setSave({ kind: "error", message: errorText(err) });
    }
  }, [definition, dirty, formPath, revision, save.kind]);

  // Ctrl/Cmd+S saves; leaving with unsaved changes asks first.
  const saveRef = useRef(saveDraft);
  useEffect(() => {
    saveRef.current = saveDraft;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  if (load.kind === "loading") return <p role="status" style={{ padding: 16 }}>Loading the form…</p>;
  if (load.kind === "signed-out") {
    return (
      <p style={{ padding: 16 }}>
        Your session has ended. <a href="/auth/login">Sign in</a> to continue.
      </p>
    );
  }
  if (load.kind === "not-found" || load.kind === "read-only" || load.kind === "error") {
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
  if (!definition || !page) return null;

  const pageIndex = definition.pages.indexOf(page);
  const readOnly = load.archived;
  const status =
    save.kind === "saving"
      ? "Saving…"
      : save.kind === "conflict"
        ? "Not saved: changed elsewhere"
        : save.kind === "error"
          ? `Not saved: ${save.message}`
          : dirty
            ? "Unsaved changes"
            : "All changes saved";

  function selectPage(id: string) {
    setCurrentPageId(id);
    setSelection({ kind: "page", id });
  }

  return (
    <div className="b-shell">
      <style>{BUILDER_CSS + RENDERER_CSS}</style>
      <header className="b-topbar">
        <div style={{ display: "grid", gap: 2 }}>
          <a href={listHref}>← Forms</a>
          <h1>{load.formName}</h1>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <span role="status" className="b-muted">
            {status}
          </span>
          <span className="b-muted">
            {issues.length === 0 ? "Ready to publish" : `${issues.length} to fix before publishing`}
          </span>
          <button type="button" className="b-btn b-primary" disabled={readOnly || !dirty || save.kind === "saving"} onClick={() => void saveDraft()}>
            Save
          </button>
        </div>
      </header>

      {readOnly && (
        <p className="b-banner">This form is archived. Restore it from the forms list to edit it.</p>
      )}
      {save.kind === "conflict" && (
        <div className="b-banner" data-kind="error" role="alert">
          Someone else saved this form after you opened it, so your changes were not saved.{" "}
          <button
            type="button"
            className="b-btn"
            onClick={onReload}
          >
            Load their version (discards your changes)
          </button>
        </div>
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
                    setSelection({ kind: "form" });
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
                if (!tryApply(added.definition)) selectPage(added.pageId);
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
                      const error = tryApply(added.definition);
                      if (error) setNotice(error);
                      else {
                        setSelection({ kind: "field", id: added.fieldId });
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
          {page.fieldIds.map((fieldId, i) => {
            const field = definition.fields.find((f) => f.id === fieldId);
            if (!field) return null;
            const selected = selection.kind === "field" && selection.id === field.id;
            const name = field.label || FIELD_TYPE_INFO[field.type].label;
            const first = pageIndex === 0 && i === 0;
            const last = pageIndex === definition.pages.length - 1 && i === page.fieldIds.length - 1;
            return (
              <div key={field.id} className="b-card" data-selected={selected ? "true" : undefined} onClick={() => setSelection({ kind: "field", id: field.id })}>
                <div className="b-card-tools" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="b-btn" aria-pressed={selected} aria-label={`Edit ${name}`} onClick={() => setSelection({ kind: "field", id: field.id })}>
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
                      if (!tryApply(copy.definition)) setSelection({ kind: "field", id: copy.fieldId });
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
                      if (!window.confirm(`Delete "${name}"${extra}?`)) return;
                      const error = tryApply(next);
                      if (error) setNotice(error);
                      else {
                        setSelection({ kind: "form" });
                        setNotice(`Deleted ${name}${extra}.`);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
                <FormField field={field} value={undefined} required={field.required} disabled onChange={() => undefined} idPrefix="canvas" />
              </div>
            );
          })}
        </main>

        <aside className="b-panel" aria-label="Properties">
          <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {selection.kind === "field" ? (
              <FieldInspector definition={definition} fieldId={selection.id} issues={issues} tryApply={tryApply} />
            ) : selection.kind === "page" ? (
              <PageInspector definition={definition} pageId={selection.id} tryApply={tryApply} />
            ) : (
              <FormInspector definition={definition} tryApply={tryApply} />
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
