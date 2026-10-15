import type { FormDefinition } from "@workeasy/form-schema";

/**
 * Local undo/redo history for one editing session (docs/03 §2). Each edit is
 * a labelled step; the stored snapshots make every step reversible. History
 * is never persisted: reloading starts a fresh history, and published
 * versions provide long-term recovery.
 */

export interface HistoryStep {
  /** The definition before (in `past`) or after (in `future`) the step. */
  definition: FormDefinition;
  /** What the step did, e.g. "Add Short text", for "Undo Add Short text". */
  label: string;
}

export interface EditorHistory {
  readonly past: readonly HistoryStep[];
  readonly present: FormDefinition;
  readonly future: readonly HistoryStep[];
  /** Coalescing state for the most recent step. */
  readonly lastKey?: string | undefined;
  readonly lastAt?: number | undefined;
}

/** Most steps kept; older ones are dropped. */
export const MAX_HISTORY_STEPS = 100;
/** Approximate cap on stored snapshot size (UTF-16 characters of JSON). */
export const MAX_HISTORY_CHARS = 20_000_000;
/** Edits with the same key within this window merge into one step (typing in one input). */
export const COALESCE_WINDOW_MS = 1500;

export function createHistory(definition: FormDefinition): EditorHistory {
  return { past: [], present: definition, future: [] };
}

function trim(past: HistoryStep[]): HistoryStep[] {
  let kept = past.slice(-MAX_HISTORY_STEPS);
  let size = kept.reduce((sum, step) => sum + JSON.stringify(step.definition).length, 0);
  while (kept.length > 1 && size > MAX_HISTORY_CHARS) {
    size -= JSON.stringify(kept[0]!.definition).length;
    kept = kept.slice(1);
  }
  return kept;
}

export interface ApplyOptions {
  /** Steps sharing a key within COALESCE_WINDOW_MS become one undo step. */
  key?: string | undefined;
  /** Current time in ms (injectable for tests). */
  now?: number | undefined;
}

/** Records `next` as a new step. Applying always clears the redo stack. */
export function applyStep(history: EditorHistory, next: FormDefinition, label: string, options: ApplyOptions = {}): EditorHistory {
  if (next === history.present) return history;
  const now = options.now ?? Date.now();
  const coalesce =
    options.key !== undefined &&
    options.key === history.lastKey &&
    history.lastAt !== undefined &&
    now - history.lastAt <= COALESCE_WINDOW_MS &&
    history.past.length > 0 &&
    history.future.length === 0;
  if (coalesce) {
    return { ...history, present: next, lastAt: now };
  }
  return {
    past: trim([...history.past, { definition: history.present, label }]),
    present: next,
    future: [],
    lastKey: options.key,
    lastAt: now,
  };
}

export function canUndo(history: EditorHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: EditorHistory): boolean {
  return history.future.length > 0;
}

export function undoLabel(history: EditorHistory): string | undefined {
  return history.past.at(-1)?.label;
}

export function redoLabel(history: EditorHistory): string | undefined {
  return history.future[0]?.label;
}

export function undo(history: EditorHistory): EditorHistory {
  const step = history.past.at(-1);
  if (!step) return history;
  return {
    past: history.past.slice(0, -1),
    present: step.definition,
    future: [{ definition: history.present, label: step.label }, ...history.future],
  };
}

export function redo(history: EditorHistory): EditorHistory {
  const [step, ...rest] = history.future;
  if (!step) return history;
  return {
    past: [...history.past, { definition: history.present, label: step.label }],
    present: step.definition,
    future: rest,
  };
}
