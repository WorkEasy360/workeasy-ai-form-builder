import { addField, addPage, setFieldRule, setSkipRule, updateField } from "@workeasy/builder";
import { blankDefinition, contrastRatio } from "@workeasy/form-engine";
import type { FormDefinition, Theme } from "@workeasy/form-schema";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { FormRenderer, type Answers } from "./form";
import { RENDERER_CSS } from "./styles";
import { themePalette } from "./theme";

/** Runs in headless Chromium (`pnpm test:browser`): real DOM, focus and input events. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function mount(node: React.ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<>{node}<style>{RENDERER_CSS}</style></>));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

/**
 * Page 1: "Do you have an order?" (radio, required) and "Name" (text, required).
 * Page 2: "Order number" (text, required). Page 3: "Comments" (text).
 * Answering "No" skips page 2.
 */
function survey(): { def: FormDefinition; ids: Record<"order" | "name" | "number" | "comments", string> } {
  let def: FormDefinition = { ...blankDefinition("Support"), pages: [{ id: "page_1", title: "About you", fieldIds: [] }] };
  const order = addField(def, "radio", "page_1");
  def = updateField(order.definition, order.fieldId, { label: "Do you have an order?", required: true });
  const name = addField(def, "text", "page_1");
  def = updateField(name.definition, name.fieldId, { label: "Name", required: true });
  const p2 = addPage(def);
  const number = addField(p2.definition, "text", p2.pageId);
  def = updateField(number.definition, number.fieldId, { label: "Order number", required: true });
  const p3 = addPage(def);
  const comments = addField(p3.definition, "text", p3.pageId);
  def = updateField(comments.definition, comments.fieldId, { label: "Comments" });
  const no = def.fields[0]!.settings.options![1]!.id;
  def = setSkipRule(def, "page_1", p3.pageId, { fieldId: order.fieldId, op: "eq", value: no }).definition;
  return { def, ids: { order: order.fieldId, name: name.fieldId, number: number.fieldId, comments: comments.fieldId } };
}

const button = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent === name) ?? (() => { throw new Error(`no "${name}" button`); })();

async function click(element: Element) {
  await act(async () => {
    await userEvent.click(element);
  });
}

describe("FormRenderer (browser)", () => {
  it("shows errors only after trying to continue, focuses the summary and links to each question", async () => {
    const { def, ids } = survey();
    const c = mount(<FormRenderer definition={def} onSubmit={() => undefined} />);
    expect(c.querySelector(".we-error-summary")).toBeNull();
    expect(c.querySelector(".we-progress")?.textContent).toBe("Page 1 of 3");

    await click(button(c, "Next"));
    const summary = c.querySelector<HTMLElement>(".we-error-summary")!;
    expect(document.activeElement).toBe(summary);
    expect(summary.getAttribute("role")).toBe("alert");
    expect(summary.textContent).toContain("There are 2 problems to fix");
    const name = c.querySelector<HTMLInputElement>(`#we-${ids.name}-control`)!;
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toContain(`we-${ids.name}-error`);

    // The link to the radio group focuses its first choice.
    await click(summary.querySelector(`a[href="#we-${ids.order}-control"]`)!);
    expect((document.activeElement as HTMLInputElement).type).toBe("radio");

    // Fixing a problem updates the summary straight away.
    await act(async () => {
      await userEvent.fill(name, "Ada");
    });
    expect(c.querySelector(".we-error-summary")?.textContent).toContain("There is 1 problem to fix");
  });

  it("follows skip rules, moves focus to each new page and submits only reachable answers", async () => {
    const { def, ids } = survey();
    const submitted: Answers[] = [];
    const c = mount(<FormRenderer definition={def} onSubmit={(a) => void submitted.push(a)} restartLabel="Start again" />);

    // "Yes" goes through page 2.
    await click(c.querySelectorAll<HTMLInputElement>(`#we-${ids.order}-control input`)[0]!);
    await act(async () => {
      await userEvent.fill(c.querySelector(`#we-${ids.name}-control`)!, "Ada");
    });
    await click(button(c, "Next"));
    expect(document.activeElement?.textContent).toBe("Page 2");
    expect(c.querySelector(".we-progress")?.textContent).toBe("Page 2 of 3");
    await act(async () => {
      await userEvent.fill(c.querySelector(`#we-${ids.number}-control`)!, "A-100");
    });

    // Back to page 1 and switch to "No": page 2 drops out of the path and its answer is not sent.
    await click(button(c, "Back"));
    expect(document.activeElement?.textContent).toBe("About you");
    await click(c.querySelectorAll<HTMLInputElement>(`#we-${ids.order}-control input`)[1]!);
    expect(c.querySelector(".we-progress")?.textContent).toBe("Page 1 of 2");
    await click(button(c, "Next"));
    expect(c.querySelector(".we-progress")?.textContent).toBe("Page 2 of 2");
    expect(c.querySelector(`#we-${ids.comments}-control`)).not.toBeNull();

    await click(button(c, "Submit"));
    expect(submitted).toEqual([{ [ids.order]: def.fields[0]!.settings.options![1]!.id, [ids.name]: "Ada" }]);
    expect(document.activeElement?.textContent).toBe("Support");
    expect(c.textContent).toContain(def.success.message);

    await click(button(c, "Start again"));
    expect(c.querySelector(".we-progress")?.textContent).toBe("Page 1 of 3");
    expect(c.querySelector<HTMLInputElement>(`#we-${ids.name}-control`)!.value).toBe("");
  });

  it("hides questions by rule and never blocks on a hidden required question", async () => {
    const { def: base, ids } = survey();
    const yes = base.fields[0]!.settings.options![0]!.id;
    // Show "Name" only when the answer is "Yes".
    const def = setFieldRule(base, ids.name, "visibility", { fieldId: ids.order, op: "eq", value: yes }, true).definition;
    const c = mount(<FormRenderer definition={def} onSubmit={() => undefined} />);
    expect(c.querySelector(`#we-${ids.name}-control`)).toBeNull();
    await click(c.querySelectorAll<HTMLInputElement>(`#we-${ids.order}-control input`)[1]!);
    await click(button(c, "Next"));
    expect(c.querySelector(".we-error-summary")).toBeNull();
    expect(c.querySelector(".we-progress")?.textContent).toBe("Page 2 of 2");
  });

  it("shows a submission failure without losing answers", async () => {
    const { def, ids } = survey();
    const single: FormDefinition = { ...def, pages: [def.pages[2]!], fields: [def.fields.find((f) => f.id === ids.comments)!], rules: [] };
    const c = mount(<FormRenderer definition={single} onSubmit={() => "The form is closed."} />);
    await act(async () => {
      await userEvent.fill(c.querySelector(`#we-${ids.comments}-control`)!, "Thanks");
    });
    await click(button(c, "Submit"));
    expect(document.activeElement?.textContent).toContain("The form is closed.");
    expect(c.querySelector<HTMLInputElement>(`#we-${ids.comments}-control`)!.value).toBe("Thanks");
  });

  it("applies the theme to the form", () => {
    const { def } = survey();
    const theme: Theme = { accent: "#A5B4FC", background: "#111827", text: "#F9FAFB", radius: 0 };
    const c = mount(<FormRenderer definition={{ ...def, theme }} onSubmit={() => undefined} />);
    const form = c.querySelector<HTMLElement>(".we-surface")!;
    expect(getComputedStyle(form).backgroundColor).toBe("rgb(17, 24, 39)");
    expect(getComputedStyle(button(c, "Next")).backgroundColor).toBe("rgb(165, 180, 252)");
    expect(getComputedStyle(button(c, "Next")).color).toBe("rgb(0, 0, 0)");
    expect(getComputedStyle(c.querySelector(".we-input")!).borderRadius).toBe("0px");
  });
});

describe("themePalette (browser)", () => {
  const themes: Theme[] = [
    { accent: "#4F46E5", background: "#FFFFFF", text: "#111827", radius: 8 },
    { accent: "#A5B4FC", background: "#111827", text: "#F9FAFB", radius: 8 },
    { accent: "#15803D", background: "#FEF3C7", text: "#422006", radius: 8 },
    { accent: "#000000", background: "#767676", text: "#000000", radius: 8 },
  ];

  it("derives muted text, borders and errors that keep their contrast on every theme", () => {
    for (const theme of themes) {
      const p = themePalette(theme);
      expect(contrastRatio(p.textMuted, p.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(p.border, p.background)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(p.danger, p.background)).toBeGreaterThanOrEqual(Math.min(4.5, contrastRatio(p.text, p.background)));
      expect(contrastRatio(p.accentText, p.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
