import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Autosave, type AutosaveState, type SaveOutcome } from "./autosave";

const runtime = typeof window === "undefined" ? "node" : "browser";

interface Call {
  value: string;
  revision: number;
  resolve: (outcome: SaveOutcome) => void;
}

/** An autosave over string values with a save function the test controls. */
function setup(revision = 1) {
  const calls: Call[] = [];
  const states: AutosaveState[] = [];
  const autosave = new Autosave<string>({
    initial: "v0",
    revision,
    save: (value, rev) => new Promise<SaveOutcome>((resolve) => calls.push({ value, revision: rev, resolve })),
    onState: (s) => states.push(s),
  });
  return { autosave, calls, states, last: () => states.at(-1) };
}

describe(`autosave (${runtime})`, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves 800 ms after the last change, sending the latest value with the current revision", async () => {
    const { autosave, calls, last } = setup(1);
    autosave.update("v1");
    await vi.advanceTimersByTimeAsync(500);
    autosave.update("v2");
    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toHaveLength(0);
    expect(last()).toEqual({ kind: "pending", revision: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((c) => [c.value, c.revision])).toEqual([["v2", 1]]);
    expect(last()).toEqual({ kind: "saving", revision: 1 });
    calls[0]!.resolve({ kind: "saved", revision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ kind: "saved", revision: 2 });
    expect(autosave.dirty).toBe(false);
  });

  it("runs one save at a time and sends edits made during a save afterwards", async () => {
    const { autosave, calls, last } = setup(1);
    autosave.update("v1");
    await vi.advanceTimersByTimeAsync(800);
    autosave.update("v2");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
    calls[0]!.resolve({ kind: "saved", revision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ kind: "pending", revision: 2 });
    await vi.advanceTimersByTimeAsync(800);
    expect(calls.map((c) => [c.value, c.revision])).toEqual([
      ["v1", 1],
      ["v2", 2],
    ]);
  });

  it("treats undoing back to the saved value as clean", async () => {
    const { autosave, calls, last } = setup(1);
    autosave.update("v1");
    autosave.update("v0");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(0);
    expect(last()).toEqual({ kind: "saved", revision: 1 });
  });

  it("pauses on a conflict and keeps the local value until the user decides", async () => {
    const { autosave, calls, last } = setup(1);
    autosave.update("mine");
    await vi.advanceTimersByTimeAsync(800);
    calls[0]!.resolve({ kind: "conflict" });
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ kind: "conflict", revision: 1 });

    // Further edits are kept but not sent while the conflict is open.
    autosave.update("mine, edited");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    expect(autosave.dirty).toBe(true);

    // "Keep mine": save the local value over the server's current revision.
    const done = autosave.keepLocal(5);
    expect(calls.at(-1)).toMatchObject({ value: "mine, edited", revision: 5 });
    calls.at(-1)!.resolve({ kind: "saved", revision: 6 });
    await done;
    expect(last()).toEqual({ kind: "saved", revision: 6 });
  });

  it("can adopt the other version instead", async () => {
    const { autosave, calls, last } = setup(1);
    autosave.update("mine");
    await vi.advanceTimersByTimeAsync(800);
    calls[0]!.resolve({ kind: "conflict" });
    await vi.advanceTimersByTimeAsync(0);
    autosave.replace("theirs", 4);
    expect(last()).toEqual({ kind: "saved", revision: 4 });
    autosave.update("theirs, edited");
    await vi.advanceTimersByTimeAsync(800);
    expect(calls.at(-1)).toMatchObject({ value: "theirs, edited", revision: 4 });
  });

  it("retries failures with backoff and keeps the latest value", async () => {
    const { autosave, calls, last } = setup(1);
    autosave.update("v1");
    await vi.advanceTimersByTimeAsync(800);
    calls[0]!.resolve({ kind: "failed", message: "offline" });
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ kind: "retrying", revision: 1, message: "offline", retryInMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ kind: "failed", message: "offline" });
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ kind: "retrying", retryInMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    calls[2]!.resolve({ kind: "saved", revision: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ kind: "saved", revision: 2 });
  });

  it("treats a throwing save as a retryable failure", async () => {
    const states: AutosaveState[] = [];
    const autosave = new Autosave<string>({
      initial: "a",
      revision: 1,
      save: () => Promise.reject(new Error("network down")),
      onState: (s) => states.push(s),
    });
    autosave.update("b");
    await vi.advanceTimersByTimeAsync(800);
    expect(states.at(-1)).toMatchObject({ kind: "retrying", message: "network down" });
  });

  it("does not retry a rejected value until the next change", async () => {
    const { autosave, calls, last } = setup(1);
    autosave.update("bad");
    await vi.advanceTimersByTimeAsync(800);
    calls[0]!.resolve({ kind: "rejected", message: "Malformed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(last()).toEqual({ kind: "rejected", revision: 1, message: "Malformed" });
    autosave.update("good");
    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toHaveLength(2);
  });

  it("flushes immediately and stops after dispose", async () => {
    const { autosave, calls } = setup(1);
    autosave.update("now");
    const flushing = autosave.flush();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve({ kind: "saved", revision: 2 });
    await flushing;
    autosave.dispose();
    autosave.update("after dispose");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
  });
});
