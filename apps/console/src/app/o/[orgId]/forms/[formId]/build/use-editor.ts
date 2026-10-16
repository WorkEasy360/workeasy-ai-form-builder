"use client";

import {
  applyStep,
  Autosave,
  canRedo,
  canUndo,
  createHistory,
  diffDefinitions,
  redo,
  redoLabel,
  summarizeChanges,
  undo,
  undoLabel,
  type AutosaveState,
  type EditorHistory,
  type SaveOutcome,
} from "@workeasy/builder";
import { validateDraft } from "@workeasy/form-engine";
import type { FormDefinition } from "@workeasy/form-schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../../../../lib/api";

export interface DraftBody {
  revision: number;
  definition: FormDefinition;
  updatedAt: string;
  updatedBy: { id: string; displayName: string | null };
}

/** Maps a failed PUT to an autosave outcome: retry transient failures, stop on refusals. */
function outcomeFor(err: unknown): SaveOutcome {
  if (!(err instanceof ApiError)) return { kind: "failed", message: "Save failed" };
  const { status, title } = err.problem;
  if (status === 412) return { kind: "conflict" };
  if (status === 0 || status === 429 || status >= 500) return { kind: "failed", message: title };
  return { kind: "rejected", message: title };
}

/**
 * Editing session for one draft: undo/redo history, autosave 800 ms after
 * the last edit, and conflict handling that keeps local changes until the
 * user chooses what to do with them.
 */
export function useEditor(draftPath: string, initial: DraftBody) {
  const [history, setHistory] = useState<EditorHistory>(() => createHistory(initial.definition));
  const [saveState, setSaveState] = useState<AutosaveState>({ kind: "saved", revision: initial.revision });
  const [theirs, setTheirs] = useState<DraftBody | null>(null);
  const autosave = useRef<Autosave<FormDefinition> | null>(null);

  useEffect(() => {
    const instance = new Autosave<FormDefinition>({
      initial: initial.definition,
      revision: initial.revision,
      onState: setSaveState,
      save: async (definition, revision) => {
        try {
          const saved = await api<{ revision: number }>(draftPath, {
            method: "PUT",
            body: definition,
            headers: { "If-Match": `"draft-${revision}"` },
          });
          return { kind: "saved", revision: saved.revision };
        } catch (err) {
          return outcomeFor(err);
        }
      },
    });
    autosave.current = instance;
    return () => instance.dispose();
  }, [draftPath, initial]);

  // Every new present value (edit, undo, redo) goes to autosave.
  useEffect(() => {
    autosave.current?.update(history.present);
  }, [history.present]);

  // When a conflict starts, fetch the version that won so the user can compare,
  // and remember the last version this tab saved: the common base that tells
  // "your changes" apart from "their changes".
  const conflicted = saveState.kind === "conflict";
  const [base, setBase] = useState<FormDefinition | null>(null);
  useEffect(() => {
    if (!conflicted) return;
    let cancelled = false;
    api<DraftBody>(draftPath).then(
      (draft) => {
        if (cancelled) return;
        setBase(autosave.current?.savedValue ?? null);
        setTheirs(draft);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [conflicted, draftPath]);

  /** Records an edit as an undoable step if it keeps the draft saveable; otherwise returns why not. */
  const apply = useCallback((next: FormDefinition): string | undefined => {
    const checked = validateDraft(next);
    if (!checked.ok) return checked.issues[0]?.message ?? "That change isn't possible.";
    setHistory((h) => {
      const { label, key } = summarizeChanges(diffDefinitions(h.present, next));
      return applyStep(h, next, label, { key });
    });
    return undefined;
  }, []);

  /** Saves anything pending and returns the saved revision, or undefined if the draft could not be saved. */
  const saveForPublish = useCallback(async (): Promise<number | undefined> => {
    const current = autosave.current;
    if (!current) return undefined;
    await current.flush();
    return current.dirty ? undefined : current.currentRevision;
  }, []);

  const keepMine = useCallback(async () => {
    if (!theirs) return;
    await autosave.current?.keepLocal(theirs.revision);
    setTheirs(null);
  }, [theirs]);

  /** Loads the other version as an undoable step, so Undo brings the local version back. */
  const acceptTheirs = useCallback(() => {
    if (!theirs) return;
    autosave.current?.replace(theirs.definition, theirs.revision);
    setHistory((h) => applyStep(h, theirs.definition, "Load their version"));
    setTheirs(null);
  }, [theirs]);

  /** Adopts a revision the server saved (an applied AI proposal) as one undoable step. */
  const adoptSaved = useCallback((definition: FormDefinition, revision: number, label: string) => {
    autosave.current?.replace(definition, revision);
    setHistory((h) => applyStep(h, definition, label));
  }, []);

  return {
    history,
    definition: history.present,
    saveState,
    apply,
    undo: () => setHistory(undo),
    redo: () => setHistory(redo),
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    undoLabel: undoLabel(history),
    redoLabel: redoLabel(history),
    saveNow: () => autosave.current?.flush(),
    saveForPublish,
    unsaved: saveState.kind !== "saved",
    theirs: conflicted ? theirs : null,
    base: conflicted ? base : null,
    keepMine,
    acceptTheirs,
    adoptSaved,
  };
}
