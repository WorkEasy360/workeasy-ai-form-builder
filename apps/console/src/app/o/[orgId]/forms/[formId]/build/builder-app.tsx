"use client";

import {
  addField,
  addPage,
  BuilderError,
  diffDefinitions,
  duplicateField,
  FIELD_TYPE_INFO,
  fieldRuleOf,
  moveField,
  movePage,
  removeField,
  removePage,
  skipRuleOf,
  type AutosaveState,
  placeField,
  splitPage,
} from "@workeasy/builder";
import { validateDraft } from "@workeasy/form-engine";
import { FormField, RENDERER_CSS, themeStyle } from "@workeasy/form-renderer";
import type { FieldType, FormDefinition } from "@workeasy/form-schema";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { api, ApiError, type FormResponse, type FormSummary } from "../../../../../../lib/api";
import { AiPanel } from "./ai-panel";
import { DRAG_FIELD, Palette } from "./palette";
import { ConflictPanel } from "./conflict-panel";
import { DesignInspector } from "./design";
import { FieldInspector, FormInspector, PageInspector } from "./inspector";
import { PreviewPane } from "./preview";
import { PublishPanel } from "./publish-panel";
import { SharePanel } from "./share-panel";
import { BUILDER_CSS } from "./styles";
import { useEditor, type DraftBody } from "./use-editor";

type Load =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "not-found" }
  | { kind: "read-only" }
  | { kind: "error"; message: string }
  | { kind: "ready"; form: FormSummary; draft: DraftBody };

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
export function BuilderApp({ orgId, formId, aiJob }: { orgId: string; formId: string; aiJob?: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const formPath = `/api/v1/organizations/${orgId}/forms/${formId}`;
  const listHref = `/o/${orgId}/forms`;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<FormResponse>(formPath), api<DraftBody>(`${formPath}/draft`)])
      .then(([form, draft]) => {
        if (!cancelled) setLoad({ kind: "ready", form: form.form, draft });
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
      <div style={{ padding: 16 }}>
        <p role={load.kind === "error" ? "alert" : undefined}>{text}</p>
        <p>
          <a href={listHref}>Back to forms</a>
        </p>
      </div>
    );
  }
  return (
    <Editor
      {...(aiJob ? { aiJob } : {})}
      formPath={formPath}
      previewHref={`/o/${orgId}/forms/${formId}/preview`}
      initialForm={load.form}
      initial={load.draft}
    />
  );
}

/** Where the form stands for respondents, for the top bar. */
function publicationText(form: FormSummary, unpublishedChanges: number | undefined): string {
  if (!form.activeVersionId) return "Not published yet";
  const where = form.state === "closed" ? "Published, closed" : form.state === "archived" ? "Archived" : "Published";
  if (unpublishedChanges === undefined) return where;
  if (unpublishedChanges === 0) return `${where} · no unpublished changes`;
  return `${where} · ${unpublishedChanges === 1 ? "1 unpublished change" : `${unpublishedChanges} unpublished changes`}`;
}

/** Something being dragged in the builder. */
type DragItem = { kind: "new"; type: FieldType } | { kind: "page-break" } | { kind: "field"; id: string };

function Editor({
  aiJob,
  formPath,
  previewHref,
  initialForm,
  initial,
}: {
  aiJob?: string;
  formPath: string;
  previewHref: string;
  initialForm: FormSummary;
  initial: DraftBody;
}) {
  const editor = useEditor(`${formPath}/draft`, initial);
  const [form, setForm] = useState(initialForm);
  const formName = form.name;
  const archived = form.state === "archived";
  const definition = editor.definition;
  const [selected, setSelected] = useState<Selection>({ kind: "form" });
  const [currentPageId, setCurrentPageId] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"edit" | "preview" | "publish" | "share" | "ai">(aiJob ? "ai" : "edit");
  const [live, setLive] = useState<{ id: string; definition: FormDefinition } | undefined>();
  // After a move, focus returns to the moved item's controls (docs/01 §3: keyboard reordering).
  const pendingFocus = useRef<{ kind: "field" | "page"; id: string; direction: -1 | 1 } | undefined>(undefined);

  const issues = useMemo(() => validateDraft(definition).issues, [definition]);
  const unpublishedChanges = useMemo(
    () => (live && live.id === form.activeVersionId ? diffDefinitions(live.definition, definition).length : undefined),
    [live, form.activeVersionId, definition],
  );

  // The live version's definition: what respondents get, compared with the draft.
  useEffect(() => {
    const activeId = form.activeVersionId;
    if (!activeId) return;
    let cancelled = false;
    api<{ definition: FormDefinition }>(`${formPath}/versions/${activeId}`)
      .then((v) => {
        if (!cancelled) setLive({ id: activeId, definition: v.definition });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [form.activeVersionId, formPath]);
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

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = undefined;
    const item = document.querySelector(`[data-${target.kind}-item="${target.id}"]`);
    // The same direction again if possible, otherwise the other way, otherwise the item's main button.
    const candidates = [`[data-move="${target.direction}"]`, `[data-move="${-target.direction}"]`, "[data-primary]"];
    const button = candidates.map((sel) => item?.querySelector<HTMLButtonElement>(sel)).find((b) => b && !b.disabled);
    button?.focus();
  });

  function moveQuestion(fieldId: string, name: string, direction: -1 | 1) {
    let next: FormDefinition;
    try {
      next = moveField(definition, fieldId, direction);
    } catch (err) {
      setNotice(err instanceof BuilderError ? err.message : "That change isn't possible.");
      return;
    }
    const error = editor.apply(next);
    if (error) {
      setNotice(error);
      return;
    }
    const toPage = next.pages.find((p) => p.fieldIds.includes(fieldId))!;
    const toPageIndex = next.pages.indexOf(toPage);
    const position = toPage.fieldIds.indexOf(fieldId) + 1;
    if (toPage.id !== page.id) setCurrentPageId(toPage.id);
    pendingFocus.current = { kind: "field", id: fieldId, direction };
    setNotice(`Moved ${name} to position ${position} of ${toPage.fieldIds.length} on ${toPage.title || `page ${toPageIndex + 1}`}.`);
  }

  function movePageBy(pageId: string, name: string, direction: -1 | 1) {
    const from = definition.pages.findIndex((p) => p.id === pageId);
    run(() => movePage(definition, pageId, direction), `Moved ${name} to position ${from + direction + 1} of ${definition.pages.length}.`);
    pendingFocus.current = { kind: "page", id: pageId, direction };
  }

  function selectPage(id: string) {
    setCurrentPageId(id);
    setSelected({ kind: "page", id });
  }

  // Drag and drop (like other form builders): palette tiles and field cards are dragged onto the
  // canvas or a page tab. The keyboard and button controls stay for everyone who can't drag.
  const [dragging, setDragging] = useState<DragItem | undefined>();
  const [drop, setDrop] = useState<{ pageId: string; index: number } | undefined>();
  function endDrag() {
    setDragging(undefined);
    setDrop(undefined);
  }
  function aim(e: DragEvent, target: { pageId: string; index: number }) {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragging.kind === "field" ? "move" : "copy";
    if (drop?.pageId !== target.pageId || drop.index !== target.index) setDrop(target);
  }
  const pageName = (id: string) => {
    const at = definition.pages.findIndex((p) => p.id === id);
    return definition.pages[at]?.title || `page ${at + 1}`;
  };

  /** Adds, splits or moves at a drop position; `index` counts the page's questions as shown. */
  function performDrop(item: DragItem, target: { pageId: string; index: number }) {
    if (readOnly) return;
    if (item.kind === "new") {
      if (definition.fields.length >= 100) {
        setNotice("A form can have at most 100 questions.");
        return;
      }
      const added = addField(definition, item.type, target.pageId, target.index);
      const error = editor.apply(added.definition);
      if (error) setNotice(error);
      else {
        setCurrentPageId(target.pageId);
        setSelected({ kind: "field", id: added.fieldId });
        setNotice(`Added ${FIELD_TYPE_INFO[item.type].label} at position ${target.index + 1} on ${pageName(target.pageId)}.`);
      }
    } else if (item.kind === "page-break") {
      if (definition.pages.length >= 20) {
        setNotice("A form can have at most 20 pages.");
        return;
      }
      const split = splitPage(definition, target.pageId, target.index);
      const error = editor.apply(split.definition);
      if (error) setNotice(error);
      else {
        setCurrentPageId(split.pageId);
        setSelected({ kind: "page", id: split.pageId });
        setNotice("Added a page break: the questions after it are on a new page.");
      }
    } else {
      const field = definition.fields.find((f) => f.id === item.id);
      const from = definition.pages.find((p) => p.fieldIds.includes(item.id));
      if (!field || !from) return;
      // Positions on the canvas include the dragged question; placeField counts without it.
      const fromIndex = from.fieldIds.indexOf(item.id);
      const index = from.id === target.pageId && fromIndex < target.index ? target.index - 1 : target.index;
      const name = field.label || FIELD_TYPE_INFO[field.type].label;
      try {
        const next = placeField(definition, item.id, target.pageId, index);
        if (next === definition) return;
        const error = editor.apply(next);
        if (error) {
          setNotice(error);
          return;
        }
        setCurrentPageId(target.pageId);
        setNotice(`Moved ${name} to position ${index + 1} on ${pageName(target.pageId)}.`);
      } catch (err) {
        setNotice(err instanceof BuilderError ? err.message : "That change isn't possible.");
      }
    }
  }

  function onCanvasDrop(e: DragEvent) {
    e.preventDefault();
    const item = dragging;
    const target = drop;
    endDrag();
    if (item && target) performDrop(item, target);
  }

  /** Where a click in the palette adds: after the selected question on this page, else at the end. */
  const selectedIndex = selection.kind === "field" ? page.fieldIds.indexOf(selection.id) : -1;
  const clickIndex = selectedIndex >= 0 ? selectedIndex + 1 : page.fieldIds.length;
  const selectedField = selectedIndex >= 0 ? definition.fields.find((f) => f.id === page.fieldIds[selectedIndex]) : undefined;
  const addTargetText = selectedField
    ? `after “${selectedField.label || FIELD_TYPE_INFO[selectedField.type].label}”`
    : `to the end of ${page.title || `page ${pageIndex + 1}`}`;

  return (
    <div className="b-shell">
      <style>{BUILDER_CSS + RENDERER_CSS}</style>
      <header className="b-topbar">
        {/* The form's name and tabs are in the shared form header above. */}
        <h2 className="b-visually-hidden">Editor for {formName}</h2>
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
          <span className="b-muted">{publicationText(form, unpublishedChanges)}</span>
          <span className="b-muted">{issues.length === 0 ? "Ready to publish" : `${issues.length} to fix before publishing`}</span>
          <button type="button" className="b-btn" aria-pressed={mode === "ai"} onClick={() => setMode(mode === "ai" ? "edit" : "ai")}>
            Ask AI…
          </button>
          <button type="button" className="b-btn" aria-pressed={mode === "preview"} onClick={() => setMode(mode === "preview" ? "edit" : "preview")}>
            Preview
          </button>
          <button type="button" className="b-btn" aria-pressed={mode === "publish"} onClick={() => setMode(mode === "publish" ? "edit" : "publish")}>
            Publish…
          </button>
          <button type="button" className="b-btn" aria-pressed={mode === "share"} onClick={() => setMode(mode === "share" ? "edit" : "share")}>
            Share…
          </button>
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

      {mode === "preview" ? (
        <PreviewPane definition={definition} openHref={previewHref} />
      ) : mode === "ai" ? (
        <AiPanel
          {...(aiJob ? { initialJobId: aiJob } : {})}
          formPath={formPath}
          definition={definition}
          readOnly={readOnly}
          saveForPublish={editor.saveForPublish}
          onApplied={(next, revision) => {
            editor.adoptSaved(next, revision, "Apply AI suggestion");
            setNotice("Applied the AI suggestion to your draft. Undo brings your previous version back.");
            setMode("edit");
          }}
        />
      ) : mode === "share" ? (
        <SharePanel formPath={formPath} form={form} announce={setNotice} />
      ) : mode === "publish" ? (
        <PublishPanel
          formPath={formPath}
          form={form}
          definition={definition}
          live={live}
          readOnly={readOnly}
          saveForPublish={editor.saveForPublish}
          onFormChange={setForm}
          announce={setNotice}
        />
      ) : (
        <div className="b-columns">
          <nav className="b-panel" aria-label="Pages and questions">
            <p style={{ marginTop: 0 }}>
              <button type="button" className="b-btn" aria-pressed={selection.kind === "form"} onClick={() => setSelected({ kind: "form" })}>
                Form details and design
              </button>
            </p>
            <Palette
              disabled={readOnly}
              full={definition.fields.length >= 100}
              addTargetText={addTargetText}
              onAdd={(type) => performDrop({ kind: "new", type }, { pageId: page.id, index: clickIndex })}
              onAddPage={() => {
                const added = addPage(definition, page.id);
                if (!editor.apply(added.definition)) selectPage(added.pageId);
              }}
              onDragStart={setDragging}
              onDragEnd={endDrag}
            />
            <h2>Pages</h2>
            <ol className="b-list">
              {definition.pages.map((p, i) => (
                <li key={p.id} className="b-row" data-page-item={p.id}>
                  <button type="button" className="b-btn b-grow" data-primary aria-current={p.id === page.id ? "true" : undefined} onClick={() => selectPage(p.id)}>
                    {p.title || `Page ${i + 1}`}
                    {skipRuleOf(definition, p.id) && <span className="b-badge"> · skips ahead</span>}
                  </button>
                  <button
                    type="button"
                    className="b-btn"
                    data-move="-1"
                    disabled={readOnly || i === 0}
                    aria-label={`Move ${p.title || `page ${i + 1}`} up`}
                    onClick={() => movePageBy(p.id, p.title || `page ${i + 1}`, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="b-btn"
                    data-move="1"
                    disabled={readOnly || i === definition.pages.length - 1}
                    aria-label={`Move ${p.title || `page ${i + 1}`} down`}
                    onClick={() => movePageBy(p.id, p.title || `page ${i + 1}`, 1)}
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

          </nav>

          <div
            className="b-canvas"
            aria-label="Form canvas"
            style={themeStyle(definition.theme)}
            data-dragging={dragging ? "true" : undefined}
            onDragOver={(e) => {
              // Empty space below the questions: drop at the end of this page.
              if (e.target === e.currentTarget) aim(e, { pageId: page.id, index: page.fieldIds.length });
            }}
            onDrop={onCanvasDrop}
          >
            {definition.pages.length > 1 && (
              <div className="b-pagetabs" role="group" aria-label="Pages">
                {definition.pages.map((p, i) => (
                  <button
                    key={p.id}
                    type="button"
                    className="b-pagetab"
                    aria-current={p.id === page.id ? "page" : undefined}
                    data-drop={drop && dragging?.kind !== "page-break" && drop.pageId === p.id && p.id !== page.id ? "true" : undefined}
                    onClick={() => selectPage(p.id)}
                    onDragOver={(e) => {
                      if (dragging?.kind === "page-break") return;
                      aim(e, { pageId: p.id, index: p.fieldIds.length });
                    }}
                    onDrop={onCanvasDrop}
                  >
                    {p.title || `Page ${i + 1}`}
                    <span className="b-muted"> · {p.fieldIds.length}</span>
                  </button>
                ))}
              </div>
            )}
            <h2 style={{ marginTop: 0 }}>{definition.title}</h2>
            {page.title && <h3>{page.title}</h3>}
            {page.fieldIds.length === 0 && (
              <div
                className="b-dropzone"
                data-active={drop?.pageId === page.id ? "true" : undefined}
                onDragOver={(e) => aim(e, { pageId: page.id, index: 0 })}
                onDrop={onCanvasDrop}
              >
                This page has no questions yet. Drag a field here, or click one in the list on the left.
              </div>
            )}
            <SkipNote definition={definition} pageId={page.id} />
            {page.fieldIds.map((fieldId, i) => {
              const field = definition.fields.find((f) => f.id === fieldId);
              if (!field) return null;
              const isSelected = selection.kind === "field" && selection.id === field.id;
              const name = field.label || FIELD_TYPE_INFO[field.type].label;
              const first = pageIndex === 0 && i === 0;
              const last = pageIndex === definition.pages.length - 1 && i === page.fieldIds.length - 1;
              return (
                <Fragment key={field.id}>
                {drop?.pageId === page.id && drop.index === i && <div className="b-drop-line" aria-hidden="true" />}
                <div
                  className="b-card"
                  data-field-item={field.id}
                  draggable={!readOnly}
                  data-dragged={dragging?.kind === "field" && dragging.id === field.id ? "true" : undefined}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_FIELD, field.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging({ kind: "field", id: field.id });
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    aim(e, { pageId: page.id, index: e.clientY > rect.top + rect.height / 2 ? i + 1 : i });
                  }}
                  onDrop={onCanvasDrop}
                  onKeyDown={(e) => {
                    // Alt+Arrow moves the question from any of its buttons.
                    if (!e.altKey || readOnly || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || inTextControl(e.target)) return;
                    const direction = e.key === "ArrowUp" ? -1 : 1;
                    if ((direction === -1 && first) || (direction === 1 && last)) return;
                    e.preventDefault();
                    moveQuestion(field.id, name, direction);
                  }}
                  data-selected={isSelected ? "true" : undefined} onClick={() => setSelected({ kind: "field", id: field.id })}>
                  <div className="b-card-tools" onClick={(e) => e.stopPropagation()}>
                    {!readOnly && (
                      <span className="b-handle" title="Drag to move" aria-hidden="true">
                        ⠿
                      </span>
                    )}
                    <button type="button" className="b-btn" data-primary aria-pressed={isSelected} aria-label={`Edit ${name}`} onClick={() => setSelected({ kind: "field", id: field.id })}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="b-btn"
                      data-move="-1"
                      disabled={readOnly || first}
                      aria-label={`Move ${name} up`}
                      aria-keyshortcuts="Alt+ArrowUp"
                      onClick={() => moveQuestion(field.id, name, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="b-btn"
                      data-move="1"
                      disabled={readOnly || last}
                      aria-label={`Move ${name} down`}
                      aria-keyshortcuts="Alt+ArrowDown"
                      onClick={() => moveQuestion(field.id, name, 1)}
                    >
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
                </Fragment>
              );
            })}
            {drop?.pageId === page.id && page.fieldIds.length > 0 && drop.index === page.fieldIds.length && <div className="b-drop-line" aria-hidden="true" />}
          </div>

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
            {selection.kind === "form" && (
              <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: "16px 0 0", minWidth: 0 }}>
                <DesignInspector definition={definition} issues={issues} tryApply={editor.apply} />
              </fieldset>
            )}
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
      )}
    </div>
  );
}
