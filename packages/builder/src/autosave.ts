/**
 * Autosave with optimistic concurrency (docs/03 §2): saves the latest value
 * `delayMs` after the last change, one save at a time, retrying transient
 * failures. A conflict pauses saving and never discards the local value; the
 * caller decides how to resolve it.
 */

export type SaveOutcome =
  | { kind: "saved"; revision: number }
  /** Someone else saved first (HTTP 412). */
  | { kind: "conflict" }
  /** The server refused this value (e.g. 422); retried only after the next change. */
  | { kind: "rejected"; message: string }
  /** Network or server failure; retried with backoff. */
  | { kind: "failed"; message: string };

export type AutosaveState =
  | { kind: "saved"; revision: number }
  | { kind: "pending"; revision: number }
  | { kind: "saving"; revision: number }
  | { kind: "retrying"; revision: number; message: string; retryInMs: number }
  | { kind: "conflict"; revision: number }
  | { kind: "rejected"; revision: number; message: string };

export interface AutosaveOptions<T> {
  /** The value as loaded from the server. */
  initial: T;
  revision: number;
  save: (value: T, revision: number) => Promise<SaveOutcome>;
  onState: (state: AutosaveState) => void;
  delayMs?: number;
  retryDelaysMs?: readonly number[];
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const AUTOSAVE_DELAY_MS = 800;
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000];

export class Autosave<T> {
  private latest: T;
  private saved: T;
  private revision: number;
  private timer: unknown;
  private inFlight: Promise<void> | undefined;
  private conflicted = false;
  private disposed = false;
  private failures = 0;
  private readonly delayMs: number;
  private readonly retryDelays: readonly number[];
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: AutosaveOptions<T>) {
    this.latest = options.initial;
    this.saved = options.initial;
    this.revision = options.revision;
    this.delayMs = options.delayMs ?? AUTOSAVE_DELAY_MS;
    this.retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** True while the latest value differs from the last saved one. Undoing back to the saved value makes it clean. */
  get dirty(): boolean {
    return this.latest !== this.saved;
  }

  get currentRevision(): number {
    return this.revision;
  }

  /** The value last confirmed saved: the common base when comparing local and remote changes. */
  get savedValue(): T {
    return this.saved;
  }

  /** Records a new local value and schedules a save. */
  update(value: T): void {
    if (this.disposed) return;
    this.latest = value;
    if (this.conflicted) {
      this.emit({ kind: "conflict", revision: this.revision });
      return;
    }
    if (!this.dirty) {
      this.cancelTimer();
      if (!this.inFlight) this.emit({ kind: "saved", revision: this.revision });
      return;
    }
    this.failures = 0;
    this.schedule(this.delayMs);
    if (!this.inFlight) this.emit({ kind: "pending", revision: this.revision });
  }

  /** Saves now (e.g. Ctrl+S or before navigating away) and resolves when that save settles. */
  async flush(): Promise<void> {
    this.cancelTimer();
    if (this.inFlight) await this.inFlight;
    await this.run();
  }

  /** Conflict resolution "keep mine": save the local value over `revision`, the server's current one. */
  async keepLocal(revision: number): Promise<void> {
    this.revision = revision;
    this.conflicted = false;
    await this.flush();
  }

  /** Conflict resolution "use theirs", or any reload: adopt a server value as saved. */
  replace(value: T, revision: number): void {
    this.cancelTimer();
    this.latest = value;
    this.saved = value;
    this.revision = revision;
    this.conflicted = false;
    this.failures = 0;
    this.emit({ kind: "saved", revision });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.run();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private emit(state: AutosaveState): void {
    if (!this.disposed) this.options.onState(state);
  }

  private run(): Promise<void> {
    if (this.inFlight || this.conflicted || this.disposed || !this.dirty) {
      if (!this.inFlight && !this.conflicted && !this.dirty) this.emit({ kind: "saved", revision: this.revision });
      return this.inFlight ?? Promise.resolve();
    }
    const sending = this.latest;
    this.emit({ kind: "saving", revision: this.revision });
    this.inFlight = this.options
      .save(sending, this.revision)
      .catch((err: unknown): SaveOutcome => ({ kind: "failed", message: err instanceof Error ? err.message : "Save failed" }))
      .then((outcome) => {
        this.inFlight = undefined;
        this.settle(sending, outcome);
      });
    return this.inFlight;
  }

  private settle(sent: T, outcome: SaveOutcome): void {
    if (this.disposed) return;
    switch (outcome.kind) {
      case "saved":
        this.revision = outcome.revision;
        this.saved = sent;
        this.failures = 0;
        if (this.dirty) {
          // Edits made while saving go out in the next save.
          this.schedule(this.delayMs);
          this.emit({ kind: "pending", revision: this.revision });
        } else {
          this.emit({ kind: "saved", revision: this.revision });
        }
        return;
      case "conflict":
        this.conflicted = true;
        this.cancelTimer();
        this.emit({ kind: "conflict", revision: this.revision });
        return;
      case "rejected":
        this.emit({ kind: "rejected", revision: this.revision, message: outcome.message });
        return;
      case "failed": {
        const retryInMs = this.retryDelays[Math.min(this.failures, this.retryDelays.length - 1)]!;
        this.failures++;
        this.schedule(retryInMs);
        this.emit({ kind: "retrying", revision: this.revision, message: outcome.message, retryInMs });
      }
    }
  }
}
