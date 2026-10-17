import { newField } from "@workeasy/builder";
import { FIELD_REGISTRY, isLayoutType, type AnswerValue } from "@workeasy/form-engine";
import { FIELD_TYPES, type Field, type FieldType } from "@workeasy/form-schema";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { FIELD_COMPONENTS, FormField } from "./fields";

/** Runs in headless Chromium (`pnpm test:browser`): real DOM, real input events. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

function mount(node: React.ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function fieldOf(type: FieldType, overrides: Partial<Field> = {}): Field {
  return { ...newField(type, new Set()), ...overrides };
}

/** A controlled field that reports every value it receives. */
function Harness({ field, values, required = false }: { field: Field; values: Array<AnswerValue | undefined>; required?: boolean }) {
  const [value, setValue] = useState<AnswerValue | undefined>();
  return (
    <FormField
      field={field}
      value={value}
      required={required}
      onChange={(next) => {
        values.push(next);
        setValue(next);
      }}
    />
  );
}

function control(container: HTMLElement, field: Field): HTMLElement {
  const element = container.querySelector<HTMLElement>(`#we-${field.id}-control`);
  if (!element) throw new Error(`no control for ${field.type}`);
  return element;
}

/** The accessible name source for each kind of control. */
function visibleName(element: HTMLElement): string {
  if (element instanceof HTMLFieldSetElement) return element.querySelector("legend")?.textContent ?? "";
  const labels = (element as HTMLInputElement).labels;
  return labels?.[0]?.textContent ?? "";
}

const SAMPLE_UUID = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function sampleAnswer(field: Field): unknown {
  const option = field.settings.options?.[0]?.id;
  const samples: Record<FieldType, unknown> = {
    text: "Asha",
    textarea: "Hello",
    email: "asha@example.com",
    phone: "+1 555 0100",
    url: "https://workeasy.example",
    integer: 5,
    decimal: "12.50",
    date: "2026-10-14",
    time: "09:30",
    dropdown: option,
    radio: option,
    multi_select: [option],
    checkbox: true,
    consent: true,
    rating: 3,
    file: [SAMPLE_UUID],
    name: { first: "Asha", last: "Rao" },
    address: { line1: "1 Main Street", city: "Pune", country: "India" },
    date_time: "2026-10-14T09:30",
    slider: 4,
    section: undefined,
    description: undefined,
  };
  return samples[field.type];
}

describe("field registry (BLD-02 acceptance)", () => {
  it("gives every P1 field type a renderer, codec, validator and export serializer", () => {
    for (const type of FIELD_TYPES.filter((t) => !isLayoutType(t))) {
      expect(typeof FIELD_COMPONENTS[type], type).toBe("function");
      const spec = FIELD_REGISTRY[type];
      expect(spec.operators.length, type).toBeGreaterThan(0);
      const field = fieldOf(type);
      // Codec and validator: a typical answer decodes to a canonical value…
      const decoded = spec.decode(sampleAnswer(field), field);
      expect(decoded.ok && "value" in decoded, type).toBe(true);
      // …a malformed one is rejected with a code…
      expect(spec.decode({ not: "an answer" }, field).ok, type).toBe(false);
      // …and the export serializer turns the canonical value into text.
      const canonical = decoded.ok && "value" in decoded ? decoded.value : undefined;
      expect(canonical, type).toBeDefined();
      expect(spec.exportValue(canonical!, field).length, type).toBeGreaterThan(0);
    }
  });

  it("gives layout items a renderer that shows their text and takes no answer", () => {
    for (const type of FIELD_TYPES.filter(isLayoutType)) {
      const spec = FIELD_REGISTRY[type];
      expect(spec.operators, type).toEqual([]);
      expect(spec.decode(undefined, fieldOf(type)), type).toEqual({ ok: true, empty: true });
      expect(spec.decode("an answer", fieldOf(type)).ok, type).toBe(false);
      const container = mount(<FormField field={fieldOf(type, { label: `Text of ${type}`, helpText: "More" })} value={undefined} required={false} onChange={() => undefined} />);
      expect(container.textContent, type).toContain(`Text of ${type}`);
      expect(container.querySelector("input, textarea, select"), type).toBeNull();
    }
  });

  it("renders every field type with its label as the control's accessible name", () => {
    for (const type of FIELD_TYPES.filter((t) => !isLayoutType(t))) {
      const field = fieldOf(type, { label: `Label for ${type}` });
      const container = mount(<FormField field={field} value={undefined} required={false} onChange={() => undefined} />);
      expect(visibleName(control(container, field)), type).toContain(`Label for ${type}`);
    }
  });
});

describe("field interactions in a real browser", () => {
  it("returns typed text, and clears to absent", async () => {
    const field = fieldOf("text");
    const values: Array<AnswerValue | undefined> = [];
    const container = mount(<Harness field={field} values={values} />);
    const input = control(container, field);
    await userEvent.type(input, "Asha");
    expect(values.at(-1)).toBe("Asha");
    await userEvent.clear(input);
    expect(values.at(-1)).toBeUndefined();
  });

  it("returns whole numbers as numbers and decimals as exact strings", async () => {
    const integer = fieldOf("integer");
    const decimal = fieldOf("decimal");
    const intValues: Array<AnswerValue | undefined> = [];
    const decValues: Array<AnswerValue | undefined> = [];
    const container = mount(
      <>
        <Harness field={integer} values={intValues} />
        <Harness field={decimal} values={decValues} />
      </>,
    );
    await userEvent.type(control(container, integer), "42");
    expect(intValues.at(-1)).toBe(42);
    await userEvent.type(control(container, decimal), "0.10");
    expect(decValues.at(-1)).toBe("0.10");
  });

  it("returns option IDs for dropdowns and radios, never labels", async () => {
    const dropdown = fieldOf("dropdown");
    const radio = fieldOf("radio");
    const dValues: Array<AnswerValue | undefined> = [];
    const rValues: Array<AnswerValue | undefined> = [];
    const container = mount(
      <>
        <Harness field={dropdown} values={dValues} />
        <Harness field={radio} values={rValues} />
      </>,
    );
    const second = dropdown.settings.options![1]!;
    await userEvent.selectOptions(control(container, dropdown), second.id);
    expect(dValues.at(-1)).toBe(second.id);
    const radioOption = radio.settings.options![0]!;
    await userEvent.click(container.querySelector<HTMLInputElement>(`input[type=radio][value="${radioOption.id}"]`)!);
    expect(rValues.at(-1)).toBe(radioOption.id);
  });

  it("keeps multiple choices in the order the options are listed", async () => {
    const field = fieldOf("multi_select");
    const [first, second] = field.settings.options!;
    const values: Array<AnswerValue | undefined> = [];
    const container = mount(<Harness field={field} values={values} />);
    const box = (id: string) => container.querySelector<HTMLInputElement>(`input[type=checkbox][value="${id}"]`)!;
    await userEvent.click(box(second!.id));
    await userEvent.click(box(first!.id));
    expect(values.at(-1)).toEqual([first!.id, second!.id]);
    await userEvent.click(box(first!.id));
    await userEvent.click(box(second!.id));
    expect(values.at(-1)).toBeUndefined();
  });

  it("returns booleans for checkboxes and consent, and numbers for ratings", async () => {
    const checkbox = fieldOf("checkbox");
    const rating = fieldOf("rating");
    const cValues: Array<AnswerValue | undefined> = [];
    const rValues: Array<AnswerValue | undefined> = [];
    const container = mount(
      <>
        <Harness field={checkbox} values={cValues} />
        <Harness field={rating} values={rValues} />
      </>,
    );
    await userEvent.click(control(container, checkbox));
    expect(cValues.at(-1)).toBe(true);
    await userEvent.click(control(container, checkbox));
    expect(cValues.at(-1)).toBe(false);
    await userEvent.click(container.querySelector<HTMLInputElement>('input[type=radio][value="4"]')!);
    expect(rValues.at(-1)).toBe(4);
  });

  it("returns dates in YYYY-MM-DD without timezone conversion", async () => {
    const field = fieldOf("date");
    const values: Array<AnswerValue | undefined> = [];
    const container = mount(<Harness field={field} values={values} />);
    await userEvent.fill(control(container, field), "2028-02-29");
    expect(values.at(-1)).toBe("2028-02-29");
  });
});

describe("accessibility wiring", () => {
  it("ties help text and errors to the control and marks it invalid", () => {
    const field = fieldOf("email", { helpText: "We reply here." });
    const container = mount(<FormField field={field} value="bad" required onChange={() => undefined} error="Enter a valid email address." />);
    const input = control(container, field) as HTMLInputElement;
    expect(input.required).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["We reply here.", "Enter a valid email address."]);
    // The visual required marker is hidden from screen readers; `required` carries the meaning.
    expect(container.querySelector(".we-required")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("does the same for grouped choices", () => {
    const field = fieldOf("radio", { helpText: "Pick one." });
    const container = mount(<FormField field={field} value={undefined} required onChange={() => undefined} error="This question is required." />);
    const group = control(container, field);
    expect(group.tagName).toBe("FIELDSET");
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(group.getAttribute("aria-describedby")).toBe(`we-${field.id}-help we-${field.id}-error`);
    for (const radio of group.querySelectorAll<HTMLInputElement>("input[type=radio]")) expect(radio.required).toBe(true);
  });

  it("disables controls on the builder canvas", () => {
    const text = fieldOf("text");
    const radio = fieldOf("radio");
    const container = mount(
      <>
        <FormField field={text} value={undefined} required={false} disabled onChange={() => undefined} />
        <FormField field={radio} value={undefined} required={false} disabled onChange={() => undefined} />
      </>,
    );
    expect((control(container, text) as HTMLInputElement).disabled).toBe(true);
    expect((control(container, radio) as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("shows markup in labels and options as text instead of running it", () => {
    const field = fieldOf("radio", { label: '<img src=x onerror="window.pwnedByLabel=1">' });
    field.settings.options![0]!.label = "<script>window.pwnedByLabel=1</script>";
    const container = mount(<FormField field={field} value={undefined} required={false} onChange={() => undefined} />);
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="window.pwnedByLabel=1">');
    expect((window as { pwnedByLabel?: number }).pwnedByLabel).toBeUndefined();
  });
});

describe("name, address, date and time, and slider", () => {
  it("returns name parts as an object, labels each part, and clears to absent", async () => {
    const field = fieldOf("name", { label: "Your name" });
    const values: Array<AnswerValue | undefined> = [];
    const container = mount(<Harness field={field} values={values} />);
    const first = container.querySelector<HTMLInputElement>(`#we-${field.id}-control-first`)!;
    const last = container.querySelector<HTMLInputElement>(`#we-${field.id}-control-last`)!;
    expect(first.labels?.[0]?.textContent).toBe("First name");
    expect(first.autocomplete).toBe("given-name");
    await userEvent.type(first, "Asha");
    await userEvent.type(last, "Rao");
    expect(values.at(-1)).toEqual({ first: "Asha", last: "Rao" });
    await userEvent.clear(first);
    await userEvent.clear(last);
    expect(values.at(-1)).toBeUndefined();
  });

  it("marks optional address parts and decodes a partial address only when the needed parts are there", async () => {
    const field = fieldOf("address");
    const container = mount(<FormField field={field} value={undefined} required onChange={() => undefined} />);
    const line2 = container.querySelector<HTMLInputElement>(`#we-${field.id}-control-line2`)!;
    expect(line2.required).toBe(false);
    expect(container.querySelector<HTMLInputElement>(`#we-${field.id}-control-city`)!.required).toBe(true);
    const spec = FIELD_REGISTRY.address;
    expect(spec.decode({ line1: "1 Main Street", city: "Pune" }, field)).toMatchObject({ ok: false, code: "INCOMPLETE" });
    expect(spec.decode({ line1: " 1 Main Street ", city: "Pune", country: "India", line2: "" }, field)).toEqual({
      ok: true,
      value: { line1: "1 Main Street", city: "Pune", country: "India" },
    });
    expect(spec.decode({ city: "Pune", planet: "Earth" }, field)).toMatchObject({ ok: false, code: "UNKNOWN_PART" });
    expect(spec.exportValue({ line1: "1 Main Street", city: "Pune", country: "India" }, field)).toBe("1 Main Street, Pune, India");
  });

  it("returns a local date and time, and refuses impossible ones", async () => {
    const field = fieldOf("date_time");
    expect(FIELD_REGISTRY.date_time.decode("2026-02-30T10:00", field)).toMatchObject({ ok: false, code: "INVALID_DATE_TIME" });
    expect(FIELD_REGISTRY.date_time.decode("2026-02-28T24:00", field).ok).toBe(false);
    const container = mount(<FormField field={field} value="2026-10-14T09:30" required={false} onChange={() => undefined} />);
    expect((control(container, field) as HTMLInputElement).type).toBe("datetime-local");
  });

  it("keeps a slider unanswered until moved, then returns numbers on its steps", async () => {
    const field = fieldOf("slider", { settings: { min: 0, max: 10, step: 2 } });
    const values: Array<AnswerValue | undefined> = [];
    const container = mount(<Harness field={field} values={values} />);
    const range = control(container, field) as HTMLInputElement;
    expect(range.getAttribute("aria-valuetext")).toBe("No answer yet");
    range.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(values.at(-1)).toBe(2);
    expect(FIELD_REGISTRY.slider.decode(3, field)).toMatchObject({ ok: false, code: "OFF_STEP" });
    expect(FIELD_REGISTRY.slider.decode(12, field)).toMatchObject({ ok: false, code: "OUT_OF_RANGE" });
  });
});
