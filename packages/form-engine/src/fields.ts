import type { Field, FieldSettings, FieldType, Literal, Operator, PrivacyClass } from "@workeasy/form-schema";
import { canonicalDecimal, compareDecimal, decimalFromLiteral } from "./decimal";

/**
 * Field registry (docs/03 §1): one entry per P1 field type with its answer
 * codec, allowed settings, rule operators, literal parsing, privacy default
 * and export serializer. The React component lives in @workeasy/form-renderer.
 */

/** Canonical answer values. Absent answers are never represented. */
export type AnswerValue = string | number | boolean | string[];

export type DecodeResult =
  | { ok: true; value: AnswerValue }
  | { ok: true; empty: true }
  | { ok: false; code: string; message: string };

export type ValueKind = "string" | "integer" | "decimal" | "date" | "time" | "choice" | "multi_choice" | "boolean" | "files";
export type { PrivacyClass };

/** A field's classification: its own setting, or its type's default. */
export function privacyOf(field: Field): PrivacyClass {
  return field.privacy ?? FIELD_REGISTRY[field.type].privacy;
}

export interface FieldTypeSpec {
  kind: ValueKind;
  operators: readonly Operator[];
  settings: readonly (keyof FieldSettings)[];
  privacy: PrivacyClass;
  /** Validates and canonicalizes one raw answer. Empty input ("", whitespace, []) decodes as empty. */
  decode(raw: unknown, field: Field): DecodeResult;
  /** Canonical comparison literal for a rule condition, or undefined if the literal does not fit the type. */
  literal(value: Literal, field: Field): AnswerValue | undefined;
  /** Plain-text export value (CSV escaping is the exporter's job). */
  exportValue(value: AnswerValue, field: Field): string;
}

const ORDERED = ["eq", "neq", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"] as const;
const EQUALITY = ["eq", "neq", "isEmpty", "isNotEmpty"] as const;
const TEXT_OPS = ["eq", "neq", "contains", "isEmpty", "isNotEmpty"] as const;
const PRESENCE = ["isEmpty", "isNotEmpty"] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const PHONE_PATTERN = /^\+?[0-9 ().-]+$/;

/** Default length caps (code points) when a field sets no maxLength. */
export const DEFAULT_MAX_LENGTH: Partial<Record<FieldType, number>> = {
  text: 1000,
  textarea: 20000,
  email: 254,
  phone: 32,
  url: 2048,
};
export const DEFAULT_RATING_RANGE = { min: 1, max: 5 } as const;
export const MAX_RATING = 10;

const fail = (code: string, message: string): DecodeResult => ({ ok: false, code, message });
const empty: DecodeResult = { ok: true, empty: true };

export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length++;
  return length;
}

export function isValidDate(text: string): boolean {
  const match = DATE_PATTERN.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

export function isValidTime(text: string): boolean {
  return TIME_PATTERN.test(text);
}

function decodeString(raw: unknown, field: Field, singleLine: boolean): DecodeResult | { ok: true; text: string } {
  if (raw === null || raw === undefined) return empty;
  if (typeof raw !== "string") return fail("INVALID_TYPE", "Enter text.");
  if (raw.includes("\u0000")) return fail("INVALID_VALUE", "Remove unsupported characters.");
  const text = raw.trim();
  if (text === "") return empty;
  if (singleLine && /[\r\n]/.test(text)) return fail("INVALID_VALUE", "Enter a single line.");
  const length = codePointLength(text);
  const max = field.settings.maxLength ?? DEFAULT_MAX_LENGTH[field.type] ?? 20000;
  if (length > max) return fail("TOO_LONG", `Use at most ${max} characters.`);
  const min = field.settings.minLength;
  if (min !== undefined && length < min) return fail("TOO_SHORT", `Use at least ${min} characters.`);
  return { ok: true, text };
}

function stringType(singleLine: boolean, check?: (text: string) => DecodeResult | undefined, privacy: PrivacyClass = "ordinary"): FieldTypeSpec {
  return {
    kind: "string",
    operators: TEXT_OPS,
    settings: ["placeholder", "minLength", "maxLength"],
    privacy,
    decode(raw, field) {
      const result = decodeString(raw, field, singleLine);
      if (!("text" in result)) return result;
      return check?.(result.text) ?? { ok: true, value: result.text };
    },
    literal: (value) => (typeof value === "string" ? value : undefined),
    exportValue: (value) => String(value),
  };
}

function boundsCheck(value: AnswerValue, field: Field, compare: (a: string | number, b: string | number) => number): DecodeResult {
  const { min, max } = field.settings;
  if (min !== undefined && compare(value as string | number, min) < 0) return fail("TOO_SMALL", `Enter ${min} or more.`);
  if (max !== undefined && compare(value as string | number, max) > 0) return fail("TOO_LARGE", `Enter ${max} or less.`);
  return { ok: true, value };
}

const numberCompare = (a: string | number, b: string | number) => Number(a) - Number(b);
const textCompare = (a: string | number, b: string | number) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

function integerType(rating: boolean): FieldTypeSpec {
  return {
    kind: "integer",
    operators: ORDERED,
    settings: rating ? ["min", "max"] : ["placeholder", "min", "max"],
    privacy: "ordinary",
    decode(raw, field) {
      if (raw === null || raw === undefined) return empty;
      if (typeof raw !== "number") return fail("INVALID_TYPE", "Enter a whole number.");
      if (!Number.isSafeInteger(raw)) return fail("INVALID_INTEGER", "Enter a whole number.");
      if (rating) {
        const min = Number(field.settings.min ?? DEFAULT_RATING_RANGE.min);
        const max = Number(field.settings.max ?? DEFAULT_RATING_RANGE.max);
        if (raw < min || raw > max) return fail("OUT_OF_RANGE", `Choose a rating from ${min} to ${max}.`);
        return { ok: true, value: raw };
      }
      return boundsCheck(raw, field, numberCompare);
    },
    literal: (value) => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined),
    exportValue: (value) => String(value),
  };
}

const decimalType: FieldTypeSpec = {
  kind: "decimal",
  operators: ORDERED,
  settings: ["placeholder", "min", "max"],
  privacy: "ordinary",
  decode(raw, field) {
    if (raw === null || raw === undefined) return empty;
    if (typeof raw !== "string") return fail("INVALID_TYPE", "Enter a number as text, for example 12.50.");
    const text = raw.trim();
    if (text === "") return empty;
    const value = canonicalDecimal(text);
    if (value === undefined) return fail("INVALID_DECIMAL", "Enter a number, for example 12.50.");
    return boundsCheck(value, field, (a, b) => compareDecimal(String(a), decimalFromLiteral(b)!));
  },
  literal: (value) => decimalFromLiteral(value),
  exportValue: (value) => String(value),
};

function calendarType(kind: "date" | "time"): FieldTypeSpec {
  const valid = kind === "date" ? isValidDate : isValidTime;
  return {
    kind,
    operators: ORDERED,
    settings: ["min", "max"],
    privacy: "ordinary",
    decode(raw, field) {
      if (raw === null || raw === undefined || raw === "") return empty;
      if (typeof raw !== "string" || !valid(raw)) {
        return kind === "date" ? fail("INVALID_DATE", "Enter a date as YYYY-MM-DD.") : fail("INVALID_TIME", "Enter a time as HH:mm.");
      }
      // Canonical date/time strings compare correctly as text; no timezone conversion.
      return boundsCheck(raw, field, textCompare);
    },
    literal: (value) => (typeof value === "string" && valid(value) ? value : undefined),
    exportValue: (value) => String(value),
  };
}

function optionIds(field: Field): string[] {
  return (field.settings.options ?? []).map((o) => o.id);
}

function optionLabel(field: Field, id: string): string {
  return field.settings.options?.find((o) => o.id === id)?.label ?? id;
}

const singleChoiceType: FieldTypeSpec = {
  kind: "choice",
  operators: EQUALITY,
  settings: ["options"],
  privacy: "ordinary",
  decode(raw, field) {
    if (raw === null || raw === undefined || raw === "") return empty;
    if (typeof raw !== "string") return fail("INVALID_TYPE", "Choose an option.");
    if (!optionIds(field).includes(raw)) return fail("INVALID_OPTION", "Choose one of the listed options.");
    return { ok: true, value: raw };
  },
  literal: (value, field) => (typeof value === "string" && optionIds(field).includes(value) ? value : undefined),
  exportValue: (value, field) => optionLabel(field, String(value)),
};

const multiChoiceType: FieldTypeSpec = {
  kind: "multi_choice",
  operators: ["contains", "isEmpty", "isNotEmpty"],
  settings: ["options", "minSelections", "maxSelections"],
  privacy: "ordinary",
  decode(raw, field) {
    if (raw === null || raw === undefined) return empty;
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) return fail("INVALID_TYPE", "Choose options from the list.");
    if (raw.length === 0) return empty;
    const ids = optionIds(field);
    if (new Set(raw).size !== raw.length) return fail("DUPLICATE_OPTION", "Each option can be chosen once.");
    if (raw.some((v) => !ids.includes(v as string))) return fail("INVALID_OPTION", "Choose options from the list.");
    const { minSelections, maxSelections } = field.settings;
    if (minSelections !== undefined && raw.length < minSelections) return fail("TOO_FEW_SELECTIONS", `Choose at least ${minSelections}.`);
    if (maxSelections !== undefined && raw.length > maxSelections) return fail("TOO_MANY_SELECTIONS", `Choose at most ${maxSelections}.`);
    // Canonical order is the order options are listed in the definition.
    return { ok: true, value: ids.filter((id) => raw.includes(id)) };
  },
  literal: (value, field) => (typeof value === "string" && optionIds(field).includes(value) ? value : undefined),
  exportValue: (value, field) => (value as string[]).map((id) => optionLabel(field, id)).join("; "),
};

function booleanType(settings: readonly (keyof FieldSettings)[], privacy: PrivacyClass): FieldTypeSpec {
  return {
    kind: "boolean",
    operators: EQUALITY,
    settings,
    privacy,
    decode(raw) {
      if (raw === null || raw === undefined) return empty;
      if (typeof raw !== "boolean") return fail("INVALID_TYPE", "Answer yes or no.");
      return { ok: true, value: raw };
    },
    literal: (value) => (typeof value === "boolean" ? value : undefined),
    exportValue: (value) => (value ? "true" : "false"),
  };
}

/**
 * File answers are upload IDs. The engine checks shape and count only;
 * ownership, size, type and scan state are verified when the submission
 * claims the uploads (FIL-01).
 */
const fileType: FieldTypeSpec = {
  kind: "files",
  operators: PRESENCE,
  settings: ["allowedMimeTypes", "maxFileBytes", "maxFiles"],
  privacy: "personal",
  decode(raw, field) {
    if (raw === null || raw === undefined) return empty;
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !UUID_PATTERN.test(v))) {
      return fail("INVALID_TYPE", "Upload files with the file picker.");
    }
    if (raw.length === 0) return empty;
    if (new Set(raw).size !== raw.length) return fail("DUPLICATE_FILE", "Each file can be attached once.");
    if (raw.length > (field.settings.maxFiles ?? 1)) return fail("TOO_MANY_FILES", `Attach at most ${field.settings.maxFiles ?? 1} files.`);
    return { ok: true, value: [...(raw as string[])] };
  },
  literal: () => undefined,
  exportValue: (value) => (value as string[]).join("; "),
};

function validUrl(text: string): DecodeResult | undefined {
  try {
    const url = new URL(text);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname) return undefined;
  } catch {
    // fall through
  }
  return fail("INVALID_URL", "Enter a web address starting with https://.");
}

function validPhone(text: string): DecodeResult | undefined {
  const digits = text.replace(/\D/g, "").length;
  if (!PHONE_PATTERN.test(text) || digits < 4 || digits > 20) return fail("INVALID_PHONE", "Enter a phone number.");
  return undefined;
}

export const FIELD_REGISTRY: Readonly<Record<FieldType, FieldTypeSpec>> = {
  text: stringType(true),
  textarea: stringType(false),
  email: stringType(true, (t) => (EMAIL_PATTERN.test(t) ? undefined : fail("INVALID_EMAIL", "Enter a valid email address.")), "personal"),
  phone: stringType(true, validPhone, "personal"),
  url: stringType(true, validUrl),
  integer: integerType(false),
  decimal: decimalType,
  date: calendarType("date"),
  time: calendarType("time"),
  dropdown: singleChoiceType,
  radio: singleChoiceType,
  multi_select: multiChoiceType,
  checkbox: booleanType([], "ordinary"),
  consent: booleanType(["consentTextVersion"], "personal"),
  rating: integerType(true),
  file: fileType,
};

/** Empty per docs/03 §3: absent, null, blank string or empty array. `false` and `0` are not empty. */
export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}
