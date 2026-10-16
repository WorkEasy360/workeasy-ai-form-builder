"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { api, ApiError } from "../../../../../../lib/api";

interface ExportItem {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "expired";
  failureCode: "access_revoked" | "form_unavailable" | "error" | null;
  raw: boolean;
  cutoff: string;
  rowCount: number | null;
  createdAt: string;
  expiresAt: string | null;
}

/** The filters currently applied to the response list, as the export API takes them. */
export type ExportFilters = Partial<Record<"version" | "from" | "to" | "field" | "op" | "value", string>>;

const STATE_TEXT: Record<ExportItem["state"], string> = {
  queued: "Waiting to start…",
  running: "Preparing…",
  succeeded: "Ready",
  failed: "Failed",
  expired: "Expired",
};

const FAILURE_TEXT: Record<NonNullable<ExportItem["failureCode"]>, string> = {
  access_revoked: "your access changed before it was ready",
  form_unavailable: "the form is no longer available",
  error: "something went wrong; try again",
};

function errorText(err: unknown): string {
  return err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.";
}

/**
 * CSV exports of this form's responses (RES-02): made in the background with
 * the list's current filters and only the questions you can see; ready files
 * download for 24 hours, and only while you still have access.
 */
export function ExportsPanel({ orgId, formId, filters }: { orgId: string; formId: string; filters: ExportFilters }) {
  const formPath = `/api/v1/organizations/${orgId}/forms/${formId}`;
  const rawId = useId();
  const [items, setItems] = useState<ExportItem[]>([]);
  const [raw, setRaw] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const fetchItems = useCallback(() => api<{ items: ExportItem[] }>(`${formPath}/exports`).then((r) => r.items), [formPath]);

  // Load the list, and keep checking while an export is still being prepared.
  const pending = items.some((i) => i.state === "queued" || i.state === "running");
  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      fetchItems()
        .then((next) => {
          if (!cancelled) setItems(next);
        })
        .catch(() => undefined);
    void tick();
    if (!pending) return () => void (cancelled = true);
    const timer = setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetchItems, pending]);

  async function start() {
    setBusy(true);
    setMessage(undefined);
    try {
      const body = { ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), raw };
      const created = await api<ExportItem>(`${formPath}/exports`, { method: "POST", body });
      setItems((prev) => [created, ...prev]);
      setMessage("Export started. It will appear below when it's ready.");
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function download(item: ExportItem) {
    setMessage(undefined);
    try {
      // Each download asks for a fresh 15-minute link, rechecking access.
      const link = await api<{ url: string }>(`/api/v1/organizations/${orgId}/exports/${item.id}/download`);
      window.location.assign(link.url);
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <section aria-labelledby={`${rawId}-heading`} style={{ margin: "24px 0", padding: 16, border: "1px solid var(--we-color-border)", borderRadius: "var(--we-radius-md)" }}>
      <h2 id={`${rawId}-heading`} style={{ fontSize: 18, margin: "0 0 8px" }}>
        Export
      </h2>
      <p className="r-muted" style={{ marginTop: 0 }}>
        A CSV of the responses that match the current filters, with only the questions you can see. Files are kept for 24 hours.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <button type="button" className="r-btn r-primary" disabled={busy} onClick={() => void start()}>
          Export CSV
        </button>
        <label htmlFor={rawId} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input id={rawId} type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />
          Raw values for other systems (not for spreadsheets)
        </label>
      </div>
      {message && (
        <p role="status" style={{ marginBottom: 0 }}>
          {message}
        </p>
      )}
      {items.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 8 }}>
          {items.map((item) => (
            <li key={item.id} style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", alignItems: "center" }}>
              <span>
                {new Date(item.createdAt).toLocaleString()}
                {item.raw ? " · raw" : ""}
              </span>
              <span className="r-muted" aria-live="polite">
                {STATE_TEXT[item.state]}
                {item.state === "succeeded" && item.rowCount !== null ? ` · ${item.rowCount === 1 ? "1 response" : `${item.rowCount} responses`}` : ""}
                {item.state === "failed" && item.failureCode ? `: ${FAILURE_TEXT[item.failureCode]}` : ""}
              </span>
              {item.state === "succeeded" && (
                <button type="button" className="r-btn" onClick={() => void download(item)}>
                  Download
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
