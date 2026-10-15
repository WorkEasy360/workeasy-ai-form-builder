import { blankDefinition } from "@workeasy/form-engine";
import { describe, expect, it } from "vitest";
import {
  applyStep,
  canRedo,
  canUndo,
  COALESCE_WINDOW_MS,
  createHistory,
  MAX_HISTORY_STEPS,
  redo,
  redoLabel,
  undo,
  undoLabel,
} from "./history";
import { addField, updateFormDetails } from "./operations";

const runtime = typeof window === "undefined" ? "node" : "browser";

describe(`editor history (${runtime})`, () => {
  const base = blankDefinition("Form");
  const pageId = base.pages[0]!.id;

  it("undoes and redoes labelled steps", () => {
    let h = createHistory(base);
    const one = addField(base, "text", pageId).definition;
    h = applyStep(h, one, "Add Short text", { now: 0 });
    const two = addField(one, "email", pageId).definition;
    h = applyStep(h, two, "Add Email", { now: 10_000 });

    expect(undoLabel(h)).toBe("Add Email");
    h = undo(h);
    expect(h.present).toBe(one);
    expect(redoLabel(h)).toBe("Add Email");
    h = undo(h);
    expect(h.present).toBe(base);
    expect(canUndo(h)).toBe(false);
    h = redo(redo(h));
    expect(h.present).toBe(two);
    expect(canRedo(h)).toBe(false);
  });

  it("drops the redo stack when a new step is applied after undoing", () => {
    let h = applyStep(createHistory(base), addField(base, "text", pageId).definition, "Add Short text", { now: 0 });
    h = undo(h);
    h = applyStep(h, updateFormDetails(base, { title: "Other" }), "Change title", { now: 10_000 });
    expect(canRedo(h)).toBe(false);
    expect(undoLabel(h)).toBe("Change title");
  });

  it("merges typing in the same input into one step, but not across inputs or pauses", () => {
    let h = createHistory(base);
    let def = base;
    for (const [i, title] of ["F", "Fo", "For", "Form A"].entries()) {
      def = updateFormDetails(def, { title });
      h = applyStep(h, def, "Change title", { key: "form:title", now: i * 200 });
    }
    expect(h.past).toHaveLength(1);
    expect(undo(h).present).toBe(base);

    h = applyStep(h, updateFormDetails(def, { description: "x" }), "Change description", { key: "form:description", now: 900 });
    expect(h.past).toHaveLength(2);
    h = applyStep(h, updateFormDetails(h.present, { description: "xy" }), "Change description", {
      key: "form:description",
      now: 900 + COALESCE_WINDOW_MS + 1,
    });
    expect(h.past).toHaveLength(3);
  });

  it("does not merge into a step that was undone", () => {
    let h = applyStep(createHistory(base), updateFormDetails(base, { title: "A" }), "Change title", { key: "t", now: 0 });
    h = applyStep(h, updateFormDetails(h.present, { title: "AB" }), "Change title", { key: "t", now: 100 });
    h = undo(h);
    h = applyStep(h, updateFormDetails(h.present, { title: "Z" }), "Change title", { key: "t", now: 200 });
    expect(h.past).toHaveLength(1);
    expect(undo(h).present).toBe(base);
  });

  it("ignores no-op steps and keeps at most the configured number of steps", () => {
    let h = createHistory(base);
    expect(applyStep(h, base, "Nothing")).toBe(h);
    let def = base;
    for (let i = 0; i < MAX_HISTORY_STEPS + 20; i++) {
      def = updateFormDetails(def, { title: `T${i}` });
      h = applyStep(h, def, "Change title", { now: i * 10_000 });
    }
    expect(h.past).toHaveLength(MAX_HISTORY_STEPS);
  });
});
