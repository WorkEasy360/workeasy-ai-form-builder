"use client";

import { useEffect, useId, useState } from "react";
import { api, ApiError } from "../../../../../../lib/api";

interface Policy {
  mode: "public" | "organization";
  maxResponses: number | null;
  openAt: string | null;
  closeAt: string | null;
  acceptedResponses: number;
}

type Change = Partial<Pick<Policy, "maxResponses" | "openAt" | "closeAt">>;

/** `datetime-local` works in the viewer's local time; the API stores UTC instants. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * How many responses a form takes and when (RUN-03). Changes apply at once to
 * everyone, including respondents who already have the form open.
 */
export function LimitsEditor({ formPath, canEdit, announce }: { formPath: string; canEdit: boolean; announce: (message: string) => void }) {
  const ids = { limit: useId(), open: useId(), close: useId() };
  const [policy, setPolicy] = useState<Policy | undefined>();
  const [limit, setLimit] = useState("");
  const [openAt, setOpenAt] = useState("");
  const [closeAt, setCloseAt] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<Policy>(`${formPath}/access-policy`)
      .then((p) => {
        if (cancelled) return;
        setPolicy(p);
        setLimit(p.maxResponses === null ? "" : String(p.maxResponses));
        setOpenAt(toLocalInput(p.openAt));
        setCloseAt(toLocalInput(p.closeAt));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.problem.title : "Couldn't load the limits.");
      });
    return () => {
      cancelled = true;
    };
  }, [formPath]);

  async function save(change: Change, message: string) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await api<Policy>(`${formPath}/access-policy`, { method: "PATCH", body: change });
      setPolicy(next);
      announce(message);
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  function saveLimit() {
    const trimmed = limit.trim();
    if (trimmed === "") return void save({ maxResponses: null }, "The response limit was removed.");
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1) {
      setError("Enter a whole number of responses, 1 or more, or leave it empty for no limit.");
      return;
    }
    void save({ maxResponses: n }, `The form now stops after ${n} responses.`);
  }

  function saveSchedule() {
    const change: Change = { openAt: fromLocalInput(openAt), closeAt: fromLocalInput(closeAt) };
    if (change.openAt && change.closeAt && change.closeAt <= change.openAt) {
      setError("The closing time must be after the opening time.");
      return;
    }
    void save(change, "The schedule was saved.");
  }

  if (!policy) return error ? <p className="b-inline-error">{error}</p> : <p className="b-muted">Loading limits…</p>;
  const disabled = !canEdit || busy;
  const full = policy.maxResponses !== null && policy.acceptedResponses >= policy.maxResponses;
  return (
    <section aria-labelledby={`${ids.limit}-heading`} style={{ marginTop: 24 }}>
      <h2 id={`${ids.limit}-heading`}>Limits and schedule</h2>
      <p role="status" style={{ marginTop: 0 }} className={full ? "b-inline-error" : undefined}>
        {policy.acceptedResponses === 1 ? "1 response" : `${policy.acceptedResponses} responses`} so far
        {policy.maxResponses !== null ? ` of ${policy.maxResponses}${full ? ": the form is full and isn't accepting more." : "."}` : "."}
      </p>
      <div className="b-field">
        <label htmlFor={ids.limit}>Response limit</label>
        <div className="b-row" style={{ gap: 8 }}>
          <input id={ids.limit} type="number" min={1} inputMode="numeric" value={limit} disabled={disabled} onChange={(e) => setLimit(e.target.value)} style={{ maxWidth: 160 }} />
          <button type="button" className="b-btn" disabled={disabled} onClick={saveLimit}>
            Save limit
          </button>
        </div>
        <p className="b-muted" style={{ margin: 0 }}>
          Leave empty for no limit. Responses already stored count towards it.
        </p>
      </div>
      <div className="b-field">
        <label htmlFor={ids.open}>Opens at (optional)</label>
        <input id={ids.open} type="datetime-local" value={openAt} disabled={disabled} onChange={(e) => setOpenAt(e.target.value)} />
      </div>
      <div className="b-field">
        <label htmlFor={ids.close}>Closes at (optional)</label>
        <input id={ids.close} type="datetime-local" value={closeAt} disabled={disabled} onChange={(e) => setCloseAt(e.target.value)} />
        <p className="b-muted" style={{ margin: 0 }}>Times are in your time zone ({TIME_ZONE}). Respondents see the form only between them.</p>
      </div>
      <button type="button" className="b-btn" disabled={disabled} onClick={saveSchedule}>
        Save schedule
      </button>
      {error && (
        <p role="alert" className="b-inline-error" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
    </section>
  );
}
