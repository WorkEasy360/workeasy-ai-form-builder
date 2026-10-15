import { FIELD_TYPES, type Field, type FieldSettings, type FieldType } from "@workeasy/form-schema";

/** Palette metadata for each field type. */
export interface FieldTypeInfo {
  label: string;
  description: string;
  group: "Text" | "Numbers" | "Date and time" | "Choices" | "Agreement and files";
}

export const FIELD_TYPE_INFO: Readonly<Record<FieldType, FieldTypeInfo>> = {
  text: { label: "Short text", description: "A single line of text", group: "Text" },
  textarea: { label: "Long text", description: "Several lines of text", group: "Text" },
  email: { label: "Email", description: "An email address", group: "Text" },
  phone: { label: "Phone", description: "A phone number", group: "Text" },
  url: { label: "Website", description: "A web address", group: "Text" },
  integer: { label: "Whole number", description: "A number without decimals", group: "Numbers" },
  decimal: { label: "Decimal number", description: "A number with decimals, such as an amount", group: "Numbers" },
  rating: { label: "Rating", description: "A score on a short scale", group: "Numbers" },
  date: { label: "Date", description: "A calendar date", group: "Date and time" },
  time: { label: "Time", description: "A time of day", group: "Date and time" },
  dropdown: { label: "Dropdown", description: "One choice from a list", group: "Choices" },
  radio: { label: "Single choice", description: "One choice, all options visible", group: "Choices" },
  multi_select: { label: "Multiple choice", description: "Several choices from a list", group: "Choices" },
  checkbox: { label: "Checkbox", description: "A yes/no tick box", group: "Agreement and files" },
  consent: { label: "Consent", description: "Agreement that must be given to submit", group: "Agreement and files" },
  file: { label: "File upload", description: "Attach documents or images", group: "Agreement and files" },
};

export const PALETTE_GROUPS: ReadonlyArray<{ group: FieldTypeInfo["group"]; types: FieldType[] }> = (
  ["Text", "Numbers", "Date and time", "Choices", "Agreement and files"] as const
).map((group) => ({ group, types: FIELD_TYPES.filter((t) => FIELD_TYPE_INFO[t].group === group) }));

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Opaque random identifier with a readable prefix, e.g. "f_k3j9x2m1q0zt".
 * IDs are never derived from labels, so renaming never changes identity.
 */
export function newId(prefix: "f" | "opt" | "page", taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    let suffix = "";
    for (const byte of bytes) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
    const id = `${prefix}_${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/** Default settings for a newly added field, chosen so the field is publishable as is. */
export function defaultSettings(type: FieldType, taken: Set<string>): FieldSettings {
  const option = (label: string) => {
    const id = newId("opt", taken);
    taken.add(id);
    return { id, label };
  };
  switch (type) {
    case "dropdown":
    case "radio":
    case "multi_select":
      return { options: [option("Option 1"), option("Option 2")] };
    case "rating":
      return { min: 1, max: 5 };
    case "consent":
      return { consentTextVersion: "v1" };
    case "file":
      return { allowedMimeTypes: ["application/pdf", "image/png", "image/jpeg"], maxFileBytes: 10 * 1024 * 1024, maxFiles: 1 };
    default:
      return {};
  }
}

/** A new field of `type` with a unique ID, default label and publishable defaults. */
export function newField(type: FieldType, taken: Set<string>): Field {
  const id = newId("f", taken);
  taken.add(id);
  const label = type === "consent" ? "I agree to the terms" : FIELD_TYPE_INFO[type].label;
  return { id, type, label, required: false, settings: defaultSettings(type, taken) };
}
