"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { api, ApiError, type FormResponse, type VersionSummary } from "../../../../../../lib/api";
import { ExportsPanel, type ExportFilters } from "./exports-panel";

type Masked = { masked: true } | { masked: false; value: unknown; display: string };

interface Column {
  fieldId: string;
  label: string;
  type: string;
  privacy: "ordinary" | "personal" | "sensitive";
  masked: boolean;
}

interface ListPage {
  columns: Column[];
  items: Array<{ id: string; receiptNumber: string; receivedAt: string; versionNumber: number; answers: Record<string, Masked> }>;
  total: number;
  cutoff: string;
  nextCursor?: string;
}

type Op = "eq" | "contains" | "isEmpty" | "isNotEmpty";

interface Filters {
  field: string;
  op: Op;
  value: string;
  from: string;
  to: string;
  version: string;
}

const NO_FILTERS: Filters = { field: "", op: "contains", value: "", from: "", to: "", version: "" };

const OPS: Array<{ op: Op; label: string; needsValue: boolean }> = [
  { op: "contains", label: "contains", needsValue: true },
  { op: "eq", label: "is exactly", needsValue: true },
  { op: "isNotEmpty", label: "is answered", needsValue: false },
  { op: "isEmpty", label: "is not answered", needsValue: false },
];

const CSS = `
.r-filters { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: end; margin: 16px 0; }
.r-filters label { display: grid; gap: 4px; font-size: 14px; }
.r-filters input, .r-filters select { font: inherit; padding: 6px; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-sm); background: var(--we-color-background); color: var(--we-color-text); }
.r-btn { font: inherit; padding: 6px 12px; border-radius: var(--we-radius-sm); border: 1px solid var(--we-color-border); background: var(--we-color-background); color: var(--we-color-text); cursor: pointer; }
.r-primary { background: var(--we-color-accent); border-color: var(--we-color-accent); color: var(--we-color-accentText); }
.r-scroll { overflow-x: auto; border: 1px solid var(--we-color-border); border-radius: var(--we-radius-md); }
.r-table { border-collapse: collapse; min-width: 100%; font-size: 14px; }
.r-table th, .r-table td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--we-color-border); vertical-align: top; max-width: 280px; overflow-wrap: anywhere; }
.r-table th { position: sticky; top: 0; background: var(--we-color-surface); white-space: nowrap; }
.r-hidden { color: var(--we-color-textMuted); font-style: italic; }
.r-muted { color: var(--we-color-textMuted); }
`;

function errorText(err: unknown): string {
  return err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.";
}

/** The localized date-time a `datetime`-free date input means: the start of that day in the viewer's time zone. */
const dayStart = (date: string) => (date ? new Date(`${date}T00:00:00`).toISOString() : "");
const dayEnd = (date: string) => (date ? new Date(new Date(`${date}T00:00:00`).getTime() + 86_400_000).toISOString() : "");

/** Responses to one form (RES-01): filters, a table of masked answers, and paging that never repeats a response. */
export function ResponsesApp({ orgId, formId }: { orgId: string; formId: string }) {
  const formPath = `/api/v1/organizations/${orgId}/forms/${formId}`;
  const ids = { field: useId(), op: useId(), value: useId(), from: useId(), to: useId(), version: useId() };
  const [form, setForm] = useState<FormResponse["form"] | undefined>();
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [page, setPage] = useState<ListPage | undefined>();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const fetchPage = useCallback(
    (filters: Filters, cursor?: string) => {
      const params = new URLSearchParams({ limit: "25" });
      if (cursor) params.set("cursor", cursor);
      if (filters.version) params.set("version", filters.version);
      if (filters.from) params.set("from", dayStart(filters.from));
      if (filters.to) params.set("to", dayEnd(filters.to));
      if (filters.field) {
        params.set("field", filters.field);
        params.set("op", filters.op);
        if (OPS.find((o) => o.op === filters.op)?.needsValue) params.set("value", filters.value);
      }
      return api<ListPage>(`${formPath}/submissions?${params.toString()}`);
    },
    [formPath],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<FormResponse>(formPath), api<{ items: VersionSummary[] }>(`${formPath}/versions`), fetchPage(NO_FILTERS)])
      .then(([f, v, first]) => {
        if (cancelled) return;
        setForm(f.form);
        setVersions(v.items);
        setPage(first);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [formPath, fetchPage]);

  async function load(filters: Filters, cursor?: string) {
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchPage(filters, cursor);
      setPage((prev) => (cursor && prev ? { ...next, items: [...prev.items, ...next.items] } : next));
      if (!cursor) setApplied(filters);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }

  const readable = page?.columns.filter((c) => !c.masked) ?? [];
  const exportFilters: ExportFilters = {
    version: applied.version,
    from: dayStart(applied.from),
    to: dayEnd(applied.to),
    ...(applied.field ? { field: applied.field, op: applied.op, ...(OPS.find((o) => o.op === applied.op)?.needsValue ? { value: applied.value } : {}) } : {}),
  };
  const needsValue = OPS.find((o) => o.op === draft.op)?.needsValue ?? false;
  const filtered = JSON.stringify(applied) !== JSON.stringify(NO_FILTERS);

  return (
    <div>
      <style>{CSS}</style>
      <h2 style={{ margin: "0 0 4px", fontSize: 22 }}>Responses</h2>

      {error && (
        <p role="alert" style={{ color: "var(--we-color-danger)" }}>
          {error}
        </p>
      )}
      {!page && !error && <p role="status">Loading responses…</p>}

      {page && (
        <>
          <form
            className="r-filters"
            aria-label="Filter responses"
            onSubmit={(e) => {
              e.preventDefault();
              void load(draft);
            }}
          >
            <label htmlFor={ids.field}>
              Question
              <select id={ids.field} value={draft.field} onChange={(e) => setDraft({ ...draft, field: e.target.value })}>
                <option value="">Any</option>
                {readable.map((c) => (
                  <option key={c.fieldId} value={c.fieldId}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            {draft.field && (
              <label htmlFor={ids.op}>
                Condition
                <select id={ids.op} value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value as Op })}>
                  {OPS.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {draft.field && needsValue && (
              <label htmlFor={ids.value}>
                Value
                <input id={ids.value} value={draft.value} maxLength={200} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
              </label>
            )}
            <label htmlFor={ids.from}>
              Received from
              <input id={ids.from} type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </label>
            <label htmlFor={ids.to}>
              to
              <input id={ids.to} type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </label>
            {versions.length > 1 && (
              <label htmlFor={ids.version}>
                Version
                <select id={ids.version} value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })}>
                  <option value="">All</option>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      Version {v.versionNumber}
                      {v.active ? " (live)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="submit" className="r-btn r-primary" disabled={loading}>
              Apply
            </button>
            {filtered && (
              <button
                type="button"
                className="r-btn"
                disabled={loading}
                onClick={() => {
                  setDraft(NO_FILTERS);
                  void load(NO_FILTERS);
                }}
              >
                Clear filters
              </button>
            )}
          </form>

          <p role="status" className="r-muted">
            {page.total === 1 ? "1 response" : `${page.total} responses`} received up to {new Date(page.cutoff).toLocaleString()}
            {filtered ? `; showing ${page.items.length}${page.nextCursor ? "+" : ""} that match` : ""}.{" "}
            <button type="button" className="r-btn" disabled={loading} onClick={() => void load(applied)}>
              Refresh
            </button>
          </p>
          {page.columns.some((c) => c.masked) && (
            <p className="r-muted">Some questions hold personal or sensitive data you don&apos;t have permission to see; their answers are hidden.</p>
          )}

          {page.items.length === 0 ? (
            <p>{filtered ? "No responses match these filters." : "No responses yet."}</p>
          ) : (
            <div className="r-scroll" tabIndex={0} role="region" aria-label="Responses table">
              <table className="r-table">
                <thead>
                  <tr>
                    <th scope="col">Receipt no.</th>
                    <th scope="col">Received</th>
                    {page.columns.map((c) => (
                      <th key={c.fieldId} scope="col">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <a href={`/o/${orgId}/forms/${formId}/responses/${item.id}`} aria-label={`Response ${item.receiptNumber}`}>
                          {item.receiptNumber}
                        </a>
                      </th>
                      <td>
                        <time dateTime={item.receivedAt}>{new Date(item.receivedAt).toLocaleString()}</time>
                        {versions.length > 1 && <div className="r-muted">v{item.versionNumber}</div>}
                      </td>
                      {page.columns.map((c) => {
                        const answer = item.answers[c.fieldId];
                        if (!answer) return <td key={c.fieldId} className="r-muted" aria-label="Not in this version" />;
                        return answer.masked ? (
                          <td key={c.fieldId} className="r-hidden">
                            Hidden
                          </td>
                        ) : (
                          <td key={c.fieldId}>{answer.display}</td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {page.nextCursor && (
            <p>
              <button type="button" className="r-btn" disabled={loading} onClick={() => void load(applied, page.nextCursor)}>
                {loading ? "Loading…" : "Load more"}
              </button>
            </p>
          )}

          {form?.permissions.includes("responses.export") && <ExportsPanel orgId={orgId} formId={formId} filters={exportFilters} />}
        </>
      )}
    </div>
  );
}
