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
      <p style={{ margin: 0 }}>
        <a href={`/o/${orgId}/forms`}>← Forms</a>
      </p>
      <h1 style={{ fontSize: 24, margin: "8px 0" }}>Analytics</h1>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "end", marginBottom: 16 }}>
        <label htmlFor={ids.from} style={{ display: "grid", gap: 4 }}>
          From
          <input id={ids.from} type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label htmlFor={ids.to} style={{ display: "grid", gap: 4 }}>
          To
          <input id={ids.to} type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
        <span style={{ color: "var(--we-color-textMuted)", fontSize: 14 }}>Dates are UTC.</span>
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Loading…</p>}
      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {tiles.map((t) => (
              <section key={t.label} style={{ border: "1px solid var(--we-color-border)", borderRadius: 8, padding: 12 }} aria-label={t.label}>
                <h2 style={{ fontSize: 14, margin: 0, color: "var(--we-color-textMuted)" }}>{t.label}</h2>
                <p style={{ fontSize: 28, margin: "4px 0", fontVariantNumeric: "tabular-nums" }}>{t.value}</p>
                <p style={{ fontSize: 13, margin: 0, color: "var(--we-color-textMuted)" }}>{t.note}</p>
              </section>
            ))}
          </div>
          <p style={{ fontSize: 13, color: "var(--we-color-textMuted)" }}>{data.definitions.day}</p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14, fontVariantNumeric: "tabular-nums" }}>
              <caption style={{ textAlign: "left", fontWeight: 600, padding: "8px 0" }}>By day</caption>
              <thead>
                <tr style={{ textAlign: "right" }}>
                  <th scope="col" style={{ textAlign: "left", padding: 6 }}>
                    Day
                  </th>
                  <th scope="col" style={{ padding: 6 }}>Views</th>
                  <th scope="col" style={{ padding: 6 }}>Starts</th>
                  <th scope="col" style={{ padding: 6 }}>Accepted</th>
                </tr>
              </thead>
              <tbody>
                {data.days.toReversed().map((d) => (
                  <tr key={d.day} style={{ borderTop: "1px solid var(--we-color-border)", textAlign: "right" }}>
                    <th scope="row" style={{ textAlign: "left", padding: 6, fontWeight: 400 }}>
                      {d.day}
                    </th>
                    <td style={{ padding: 6 }}>{number.format(d.views)}</td>
                    <td style={{ padding: 6 }}>{number.format(d.starts)}</td>
                    <td style={{ padding: 6 }}>{number.format(d.accepts)}</td>
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
