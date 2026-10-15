import type { FormDefinition } from "@workeasy/form-schema";

/**
 * Publication helpers (docs/02 §5). Both are pure, so the API, worker and
 * tests compute identical results.
 */

/**
 * What respondents receive for a published version: only the parts of the
 * definition the renderer needs, copied key by key. Anything a future
 * definition carries for internal use (workflow references, credentials,
 * notes) stays out unless it is added here deliberately.
 */
export function publicProjection(definition: FormDefinition): FormDefinition {
  const { schemaVersion, title, description, locale, pages, fields, rules, theme, success } = structuredClone(definition);
  return {
    schemaVersion,
    title,
    ...(description === undefined ? {} : { description }),
    locale,
    pages,
    fields,
    rules,
    theme,
    success,
  };
}

/**
 * JSON with object keys sorted at every level, so equal definitions always
 * serialize (and hash) the same way regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
