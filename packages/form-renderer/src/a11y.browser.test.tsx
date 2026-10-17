import { addField, updateField } from "@workeasy/builder";
import { blankDefinition } from "@workeasy/form-engine";
import { FIELD_TYPES, type FormDefinition } from "@workeasy/form-schema";
import axe from "axe-core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { FormRenderer } from "./form";
import { RENDERER_CSS } from "./styles";

/**
 * UX-01: automated WCAG checks on the public form with every field type, in
 * headless Chromium (`pnpm test:browser`). The full-page audit of the
 * console and respondent apps is `node scripts/a11y-audit.mjs`.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function mount(node: React.ReactNode): HTMLElement {
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<>{node}<style>{RENDERER_CSS}</style></>));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

/** One page with every field type, all required so errors can be shown on each. */
function everyField(): FormDefinition {
  let def: FormDefinition = { ...blankDefinition("Everything"), pages: [{ id: "page_1", title: "All questions", fieldIds: [] }] };
  for (const type of FIELD_TYPES) {
    const added = addField(def, type, "page_1");
    def = updateField(added.definition, added.fieldId, { label: `A ${type} question`, required: true, helpText: `Help for the ${type} question` });
  }
  return def;
}

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    // Colors come from the respondent app's theme; the page audit checks contrast.
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

describe("public form accessibility (UX-01)", () => {
  it("has no WCAG A/AA violations with every field type", async () => {
    const c = mount(<FormRenderer definition={everyField()} onSubmit={() => undefined} />);
    expect(c.querySelectorAll(".we-field").length).toBeGreaterThan(10);
    expect(await violations(c)).toEqual([]);
  });

  it("stays free of violations while showing an error on every question", async () => {
    const c = mount(<FormRenderer definition={everyField()} onSubmit={() => undefined} />);
    const submit = [...c.querySelectorAll("button")].find((b) => b.getAttribute("type") === "submit")!;
    await act(async () => {
      await userEvent.click(submit);
    });
    expect(c.querySelector(".we-error-summary")).not.toBeNull();
    expect(await violations(c)).toEqual([]);
  });
});
