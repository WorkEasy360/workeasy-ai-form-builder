"use client";

import { useEffect, useId, useState } from "react";
import { api, ApiError } from "../../../../../../lib/api";

interface Analytics {
  from: string;
  to: string;
  days: Array<{ day: string; views: number; starts: number; accepts: number }>;
  totals: { views: number; starts: number; accepts: number; startRate: number | null; completionRate: number | null };
  definitions: { view: string; start: string; accept: string; day: string };
}

const number = new Intl.NumberFormat();
const percent = (r: number | null) => (r === null ? "—" : `${Math.round(r * 1000) / 10}%`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Basic analytics for one form (ANA-01): views, starts and accepted responses
 * per UTC day, with the definitions shown next to the numbers. Built from
 * respondent sessions only; no answers are involved.
 */
export function FormAnalytics({ orgId, formId }: { orgId: string; formId: string }) {
  const ids = { from: useId(), to: useId() };
  // The last 30 days by default, fixed when the page opens.
  const [today] = useState(() => isoDay(new Date()));
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Analytics | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    api<Analytics>(`/api/v1/organizations/${orgId}/forms/${formId}/analytics?from=${from}&to=${to}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.");
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, formId, from, to]);

  const tiles = data
    ? [
        { label: "Views", value: number.format(data.totals.views), note: data.definitions.view },
        { label: "Starts", value: number.format(data.totals.starts), note: `${percent(data.totals.startRate)} of views. ${data.definitions.start}` },
        { label: "Accepted", value: number.format(data.totals.accepts), note: `${percent(data.totals.completionRate)} of starts. ${data.definitions.accept}` },
      ]
    : [];

  return (
    <div>
      <h2 style={{ margin: "0 0 12px" }}>Analytics</h2>
      <div className="c-toolbar" style={{ alignItems: "end", gap: 16, marginBottom: 20 }}>
        <div className="c-field">
          <label className="c-label" htmlFor={ids.from}>
            From
          </label>
          <input id={ids.from} className="c-input" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </div>
        <div className="c-field">
          <label className="c-label" htmlFor={ids.to}>
            To
          </label>
          <input id={ids.to} className="c-input" type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </div>
        <span className="c-hint" style={{ paddingBottom: 8 }}>
          Dates are UTC.
        </span>
      </div>
      {error && (
        <p role="alert" className="c-alert" data-tone="danger">
          {error}
        </p>
      )}
      {!data && !error && <p className="c-hint">Loading…</p>}
      {data && (
        <>
          <div className="c-stats">
            {tiles.map((t) => (
              <section key={t.label} className="c-stat" aria-label={t.label}>
                <h2>{t.label}</h2>
                <p className="c-stat-value">{t.value}</p>
                <p>{t.note}</p>
              </section>
            ))}
          </div>
          <p className="c-hint" style={{ marginBottom: 12 }}>
            {data.definitions.day}
          </p>
          <div className="c-table-wrap">
            <table className="c-table" style={{ fontVariantNumeric: "tabular-nums" }}>
              <caption className="c-visually-hidden">By day</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col" className="c-num">
                    Views
                  </th>
                  <th scope="col" className="c-num">
                    Starts
                  </th>
                  <th scope="col" className="c-num">
                    Accepted
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.days.toReversed().map((d) => (
                  <tr key={d.day}>
                    <th scope="row" style={{ textAlign: "left", fontWeight: 500, padding: "12px 16px", borderBottom: "1px solid var(--we-border)" }}>
                      {d.day}
                    </th>
                    <td className="c-num">{number.format(d.views)}</td>
                    <td className="c-num">{number.format(d.starts)}</td>
                    <td className="c-num">{number.format(d.accepts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
