"use client";

import { useEffect, useId, useState } from "react";
import { api, ApiError } from "../../../../../../lib/api";

interface Retention {
  retentionDays: number;
  legalHold: boolean;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.";
}

/**
 * How long responses are kept, and the legal hold that stops all deletion on
 * the form (GOV-01). Retention needs the publish permission; only owners and
 * admins can place or lift a hold, which the API enforces.
 */
export function RetentionEditor({ formPath, canEdit, announce }: { formPath: string; canEdit: boolean; announce: (message: string) => void }) {
  const ids = { days: useId(), hold: useId() };
  const [retention, setRetention] = useState<Retention | undefined>();
  const [days, setDays] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<Retention>(`${formPath}/retention`)
      .then((r) => {
        if (cancelled) return;
        setRetention(r);
        setDays(String(r.retentionDays));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [formPath]);

  async function save(change: Partial<Retention>, message: string) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await api<Retention>(`${formPath}/retention`, { method: "PATCH", body: change });
      setRetention(next);
      setDays(String(next.retentionDays));
      announce(message);
    } catch (err) {
      setError(err instanceof ApiError && err.problem.status === 403 ? "Only organization owners and admins can change the legal hold." : errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!retention) return error ? <p className="b-inline-error">{error}</p> : null;
  const n = Number(days);
  const validDays = Number.isInteger(n) && n >= 1 && n <= 3650;
  return (
    <section aria-labelledby={`${ids.days}-heading`} style={{ marginTop: 24 }}>
      <h2 id={`${ids.days}-heading`}>Data retention</h2>
      <div className="b-field">
        <label htmlFor={ids.days}>Keep responses for (days)</label>
        <div className="b-row" style={{ gap: 8 }}>
          <input id={ids.days} type="number" min={1} max={3650} value={days} disabled={!canEdit || busy} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: 120 }} />
          <button
            type="button"
            className="b-btn"
            disabled={!canEdit || busy || !validDays || n === retention.retentionDays}
            onClick={() => void save({ retentionDays: n }, `Responses are now kept for ${n} days.`)}
          >
            Save
          </button>
        </div>
        <p className="b-muted" style={{ margin: 0 }}>
          Older responses, with their files, are erased automatically. 1 to 3650 days.
        </p>
      </div>
      <label htmlFor={ids.hold} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input
          id={ids.hold}
          type="checkbox"
          checked={retention.legalHold}
          disabled={!canEdit || busy}
          onChange={(e) => void save({ legalHold: e.target.checked }, e.target.checked ? "Legal hold placed: nothing on this form will be deleted." : "Legal hold lifted.")}
        />
        <span>
          Legal hold
          <br />
          <span className="b-muted">While on hold nothing on this form is deleted, by people or by the retention period. Owners and admins only.</span>
        </span>
      </label>
      {error && (
        <p role="alert" className="b-inline-error">
          {error}
        </p>
      )}
    </section>
  );
}
