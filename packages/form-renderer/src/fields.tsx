import type { Field, FieldType } from "@workeasy/form-schema";
import { DEFAULT_RATING_RANGE, type AnswerValue } from "@workeasy/form-engine";
import type { ComponentType, ReactNode } from "react";

/**
 * Accessible field components shared by the builder canvas, preview and the
 * respondent app (docs/01 §3). Labels stay visible, help and errors are tied
 * to the control with aria-describedby, required state uses native
 * `required`, and everything is reachable by keyboard. All text is rendered
 * as text: React escapes labels, so markup in a label is never interpreted.
 */

export interface FieldControlProps {
  field: Field;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue | undefined) => void;
  /** Effective required state (rules may change it). */
  required: boolean;
  /** Message for the current field error, if any. */
  error?: string | undefined;
  /** Builder canvas: shown but not answerable. */
  disabled?: boolean | undefined;
  /** Called with chosen files; uploading belongs to the respondent runtime (FIL-01). */
  onFilesSelected?: ((files: FileList) => void) | undefined;
  /** Prefix keeping element IDs unique when several renderers share a page. */
  idPrefix?: string | undefined;
}

interface Ids {
  control: string;
  help: string;
  error: string;
}

function idsFor(props: FieldControlProps): Ids {
  const base = `${props.idPrefix ?? "we"}-${props.field.id}`;
  return { control: `${base}-control`, help: `${base}-help`, error: `${base}-error` };
}

function describedBy(props: FieldControlProps, ids: Ids): string | undefined {
  const parts = [props.field.helpText ? ids.help : "", props.error ? ids.error : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function RequiredMark({ required }: { required: boolean }) {
  return required ? (
    <span className="we-required" aria-hidden="true">
      {" "}
      *
    </span>
  ) : null;
}

function HelpAndError({ props, ids }: { props: FieldControlProps; ids: Ids }) {
  return (
    <>
      {props.field.helpText && (
        <p id={ids.help} className="we-help">
          {props.field.helpText}
        </p>
      )}
      {props.error && (
        <p id={ids.error} className="we-error">
          {props.error}
        </p>
      )}
    </>
  );
}

/** Label above a single control, with help and error below. */
function Labelled({ props, ids, children }: { props: FieldControlProps; ids: Ids; children: ReactNode }) {
  return (
    <div className="we-field" data-field-type={props.field.type}>
      <label htmlFor={ids.control} className="we-label">
        {props.field.label}
        <RequiredMark required={props.required} />
      </label>
      {children}
      <HelpAndError props={props} ids={ids} />
    </div>
  );
}

function commonInputProps(props: FieldControlProps, ids: Ids) {
  const describedById = describedBy(props, ids);
  return {
    id: ids.control,
    name: props.field.id,
    required: props.required,
    disabled: props.disabled,
    "aria-invalid": props.error ? true : undefined,
    ...(describedById ? { "aria-describedby": describedById } : {}),
  } as const;
}

const asText = (value: AnswerValue | undefined) => (typeof value === "string" ? value : "");
const fromText = (text: string) => (text === "" ? undefined : text);

function textInput(type: "text" | "email" | "tel" | "url", autoComplete?: string): ComponentType<FieldControlProps> {
  return function TextInput(props) {
    const ids = idsFor(props);
    return (
      <Labelled props={props} ids={ids}>
        <input
          {...commonInputProps(props, ids)}
          className="we-input"
          type={type}
          value={asText(props.value)}
          placeholder={props.field.settings.placeholder}
          maxLength={props.field.settings.maxLength}
          autoComplete={autoComplete}
          onChange={(e) => props.onChange(fromText(e.target.value))}
        />
      </Labelled>
    );
  };
}

function TextArea(props: FieldControlProps) {
  const ids = idsFor(props);
  return (
    <Labelled props={props} ids={ids}>
      <textarea
        {...commonInputProps(props, ids)}
        className="we-input"
        rows={4}
        value={asText(props.value)}
        placeholder={props.field.settings.placeholder}
        maxLength={props.field.settings.maxLength}
        onChange={(e) => props.onChange(fromText(e.target.value))}
      />
    </Labelled>
  );
}

function IntegerInput(props: FieldControlProps) {
  const ids = idsFor(props);
  const { min, max } = props.field.settings;
  return (
    <Labelled props={props} ids={ids}>
      <input
        {...commonInputProps(props, ids)}
        className="we-input"
        type="number"
        inputMode="numeric"
        step={1}
        min={typeof min === "number" ? min : undefined}
        max={typeof max === "number" ? max : undefined}
        value={typeof props.value === "number" ? String(props.value) : ""}
        placeholder={props.field.settings.placeholder}
        onChange={(e) => {
          const parsed = e.target.value === "" ? Number.NaN : Number(e.target.value);
          props.onChange(Number.isNaN(parsed) ? undefined : parsed);
        }}
      />
    </Labelled>
  );
}

/** Decimals are entered as text so no precision is lost to binary floating point. */
function DecimalInput(props: FieldControlProps) {
  const ids = idsFor(props);
  return (
    <Labelled props={props} ids={ids}>
      <input
        {...commonInputProps(props, ids)}
        className="we-input"
        type="text"
        inputMode="decimal"
        value={asText(props.value)}
        placeholder={props.field.settings.placeholder}
        onChange={(e) => props.onChange(fromText(e.target.value))}
      />
    </Labelled>
  );
}

function calendarInput(type: "date" | "time"): ComponentType<FieldControlProps> {
  return function CalendarInput(props) {
    const ids = idsFor(props);
    const { min, max } = props.field.settings;
    return (
      <Labelled props={props} ids={ids}>
        <input
          {...commonInputProps(props, ids)}
          className="we-input"
          type={type}
          min={typeof min === "string" ? min : undefined}
          max={typeof max === "string" ? max : undefined}
          value={asText(props.value)}
          onChange={(e) => props.onChange(fromText(e.target.value))}
        />
      </Labelled>
    );
  };
}

function Dropdown(props: FieldControlProps) {
  const ids = idsFor(props);
  return (
    <Labelled props={props} ids={ids}>
      <select
        {...commonInputProps(props, ids)}
        className="we-input"
        value={asText(props.value)}
        onChange={(e) => props.onChange(fromText(e.target.value))}
      >
        <option value="">Choose…</option>
        {(props.field.settings.options ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </Labelled>
  );
}

/** A labelled group (fieldset/legend) of radios or checkboxes. */
function Group({ props, ids, children }: { props: FieldControlProps; ids: Ids; children: ReactNode }) {
  const describedById = describedBy(props, ids);
  return (
    <fieldset
      id={ids.control}
      className="we-field we-group"
      data-field-type={props.field.type}
      disabled={props.disabled}
      aria-invalid={props.error ? true : undefined}
      {...(describedById ? { "aria-describedby": describedById } : {})}
    >
      <legend className="we-label">
        {props.field.label}
        <RequiredMark required={props.required} />
      </legend>
      <div className="we-choices">{children}</div>
      <HelpAndError props={props} ids={ids} />
    </fieldset>
  );
}

function RadioGroup(props: FieldControlProps) {
  const ids = idsFor(props);
  return (
    <Group props={props} ids={ids}>
      {(props.field.settings.options ?? []).map((o) => (
        <label key={o.id} className="we-choice">
          <input
            type="radio"
            name={`${ids.control}-choice`}
            value={o.id}
            checked={props.value === o.id}
            required={props.required}
            onChange={() => props.onChange(o.id)}
          />{" "}
          {o.label}
        </label>
      ))}
    </Group>
  );
}

function MultiSelect(props: FieldControlProps) {
  const ids = idsFor(props);
  const options = props.field.settings.options ?? [];
  const selected = Array.isArray(props.value) ? props.value : [];
  return (
    <Group props={props} ids={ids}>
      {options.map((o) => (
        <label key={o.id} className="we-choice">
          <input
            type="checkbox"
            value={o.id}
            checked={selected.includes(o.id)}
            onChange={(e) => {
              const next = e.target.checked ? [...selected, o.id] : selected.filter((id) => id !== o.id);
              // Keep the canonical order: the order options are listed in.
              const ordered = options.map((x) => x.id).filter((id) => next.includes(id));
              props.onChange(ordered.length > 0 ? ordered : undefined);
            }}
          />{" "}
          {o.label}
        </label>
      ))}
    </Group>
  );
}

function Rating(props: FieldControlProps) {
  const ids = idsFor(props);
  const min = Number(props.field.settings.min ?? DEFAULT_RATING_RANGE.min);
  const max = Number(props.field.settings.max ?? DEFAULT_RATING_RANGE.max);
  const values = Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i);
  return (
    <Group props={props} ids={ids}>
      {values.map((n) => (
        <label key={n} className="we-choice we-rating">
          <input
            type="radio"
            name={`${ids.control}-rating`}
            value={n}
            checked={props.value === n}
            required={props.required}
            onChange={() => props.onChange(n)}
          />{" "}
          {n}
        </label>
      ))}
    </Group>
  );
}

/** A single tick box whose label is the field label. Consent uses the same control. */
function SingleCheckbox(props: FieldControlProps) {
  const ids = idsFor(props);
  return (
    <div className="we-field we-single-checkbox" data-field-type={props.field.type}>
      <label className="we-choice">
        <input
          {...commonInputProps(props, ids)}
          type="checkbox"
          checked={props.value === true}
          onChange={(e) => props.onChange(e.target.checked)}
        />{" "}
        {props.field.label}
        <RequiredMark required={props.required} />
      </label>
      <HelpAndError props={props} ids={ids} />
    </div>
  );
}

function FileInput(props: FieldControlProps) {
  const ids = idsFor(props);
  const { allowedMimeTypes, maxFiles } = props.field.settings;
  const attached = Array.isArray(props.value) ? props.value.length : 0;
  return (
    <Labelled props={props} ids={ids}>
      <input
        {...commonInputProps(props, ids)}
        className="we-input"
        type="file"
        accept={allowedMimeTypes?.join(",")}
        multiple={(maxFiles ?? 1) > 1}
        onChange={(e) => {
          if (e.target.files && props.onFilesSelected) props.onFilesSelected(e.target.files);
        }}
      />
      {attached > 0 && <p className="we-help">{attached === 1 ? "1 file attached" : `${attached} files attached`}</p>}
    </Labelled>
  );
}

/** The renderer for every P1 field type. */
export const FIELD_COMPONENTS: Readonly<Record<FieldType, ComponentType<FieldControlProps>>> = {
  text: textInput("text"),
  textarea: TextArea,
  email: textInput("email", "email"),
  phone: textInput("tel", "tel"),
  url: textInput("url", "url"),
  integer: IntegerInput,
  decimal: DecimalInput,
  date: calendarInput("date"),
  time: calendarInput("time"),
  dropdown: Dropdown,
  radio: RadioGroup,
  multi_select: MultiSelect,
  checkbox: SingleCheckbox,
  consent: SingleCheckbox,
  rating: Rating,
  file: FileInput,
};

/** Renders one field with the control registered for its type. */
export function FormField(props: FieldControlProps) {
  const Control = FIELD_COMPONENTS[props.field.type];
  return <Control {...props} />;
}
