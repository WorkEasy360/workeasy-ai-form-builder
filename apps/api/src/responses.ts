import type { FormPermission } from "@workeasy/auth";
import type { AttachedFile, VersionDefinition } from "@workeasy/database";
import { privacyOf } from "@workeasy/form-engine";
import type { Field, FormDefinition, PrivacyClass } from "@workeasy/form-schema";

/**
 * Turning stored responses into what a reviewer may see (docs/06 §3):
 * answers are shown with the labels of the version they were given in, and
 * every field the reviewer is not cleared for is masked. Masked values never
 * leave the API, in lists, detail, filters or downloads.
 */

const NEEDS: Record<PrivacyClass, FormPermission> = {
  ordinary: "responses.read",
  personal: "responses.read_personal",
  sensitive: "responses.read_sensitive",
};

export function readableClasses(permissions: ReadonlySet<FormPermission>): Set<PrivacyClass> {
  return new Set((Object.keys(NEEDS) as PrivacyClass[]).filter((c) => permissions.has(NEEDS[c])));
}

export function canRead(field: Field, readable: ReadonlySet<PrivacyClass>): boolean {
  return readable.has(privacyOf(field));
}

export interface VersionIndex {
  byId: Map<string, { versionNumber: number; definition: FormDefinition; active: boolean }>;
  /** Each field ID with the field as last defined (newest version first). */
  latestField: Map<string, Field>;
  /** Field IDs in display order: the active version's order, then fields only older versions have. */
  order: string[];
}

export function indexVersions(versions: readonly VersionDefinition[]): VersionIndex {
  const byId = new Map(versions.map((v) => [v.id, { versionNumber: v.versionNumber, definition: v.definition as unknown as FormDefinition, active: v.active }]));
  const latestField = new Map<string, Field>();
  const order: string[] = [];
  const active = versions.find((v) => v.active);
  const ordered = active ? [active, ...versions.filter((v) => v !== active)] : versions;
  for (const version of ordered) {
    const def = version.definition as unknown as FormDefinition;
    const byIdInDef = new Map(def.fields.map((f) => [f.id, f]));
    for (const page of def.pages) {
      for (const id of page.fieldIds) {
        const field = byIdInDef.get(id);
        if (field && !latestField.has(id)) {
          latestField.set(id, field);
          order.push(id);
        }
      }
    }
  }
  return { byId, latestField, order };
}

const BYTES = (n: number | null) =>
  n === null ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;

/** A canonical answer as text, using the field's own version for option labels. */
export function displayAnswer(field: Field, value: unknown, files: readonly AttachedFile[]): string {
  if (value === undefined || value === null) return "";
  const optionLabel = (id: string) => field.settings.options?.find((o) => o.id === id)?.label ?? id;
  switch (field.type) {
    case "dropdown":
    case "radio":
      return optionLabel(String(value));
    case "multi_select":
      return (value as string[]).map(optionLabel).join(", ");
    case "checkbox":
    case "consent":
      return value === true ? "Yes" : "No";
    case "file":
      return (value as string[])
        .map((id) => {
          const file = files.find((f) => f.uploadId === id);
          return file ? `${file.fileName} (${BYTES(file.bytes)})` : "File";
        })
        .join(", ");
    default:
      return String(value);
  }
}

export type MaskedAnswer = { masked: true } | { masked: false; value: unknown; display: string };

/** One answer as a reviewer sees it: the value and its text, or only the fact that it is hidden. */
export function presentAnswer(field: Field, value: unknown, files: readonly AttachedFile[], readable: ReadonlySet<PrivacyClass>): MaskedAnswer {
  if (!canRead(field, readable)) return { masked: true };
  return { masked: false, value: value ?? null, display: displayAnswer(field, value, files) };
}

export const shortReceipt = (receiptId: string) => receiptId.slice(0, 8).toUpperCase();
