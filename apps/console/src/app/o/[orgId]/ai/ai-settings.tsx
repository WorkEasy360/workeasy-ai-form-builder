"use client";

import { useEffect, useId, useState } from "react";
import { api, ApiError } from "../../../../lib/api";

interface AiSettingsResponse {
  settings: { enabled: boolean; dailyTokenLimit: number };
  available: boolean;
  today: { usedTokens: number; reservedTokens: number };
}

const number = new Intl.NumberFormat();

/**
 * AI opt-in and daily budget (AI-03). Owners turn AI on for the
 * organization and cap the tokens it may use per day; everyone else sees
 * the settings read-only.
 */
export function AiSettingsForm({ orgId }: { orgId: string }) {
  const ids = { enabled: useId(), limit: useId() };
  const path = `/api/v1/organizations/${orgId}/ai-settings`;
  const [data, setData] = useState<AiSettingsResponse | undefined>();
  const [canManage, setCanManage] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [limit, setLimit] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<AiSettingsResponse>(path), api<{ organizations: Array<{ id: string; permissions: string[] }> }>("/api/v1/me")])
      .then(([settings, me]) => {
        if (cancelled) return;
        setData(settings);
        setEnabled(settings.settings.enabled);
        setLimit(String(settings.settings.dailyTokenLimit));
        setCanManage(me.organizations.find((o) => o.id === orgId)?.permissions.includes("organization.manage") ?? false);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.problem.title : "Something went wrong.");
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, path]);

  async function save() {
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      const next = await api<AiSettingsResponse>(path, { method: "PUT", body: { enabled, dailyTokenLimit: Number(limit) } });
      setData(next);
      setNotice(next.settings.enabled ? "AI is on for your organization." : "AI is off for your organization.");
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const n = Number(limit);
  const validLimit = Number.isInteger(n) && n >= 1000 && n <= 100_000_000;
  return (
    <div>
      <h1 style={{ fontSize: 26, margin: "0 0 8px" }}>AI settings</h1>
      <p style={{ color: "var(--we-color-textMuted)", marginTop: 0 }}>
        AI can suggest forms for people who edit them. Suggestions never change a form until someone applies them, and prompts are not kept after a request
        ends.
      </p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Loading…</p>}
      {data && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          style={{ display: "grid", gap: 16 }}
        >
          {!data.available && <p role="note">AI isn&apos;t set up on this server, so these settings have no effect yet.</p>}
          <label htmlFor={ids.enabled} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input id={ids.enabled} type="checkbox" checked={enabled} disabled={!canManage || busy} onChange={(e) => setEnabled(e.target.checked)} />
            Allow AI suggestions in this organization
          </label>
          <div style={{ display: "grid", gap: 4 }}>
            <label htmlFor={ids.limit}>Daily limit (tokens)</label>
            <input
              id={ids.limit}
              type="number"
              min={1000}
              max={100_000_000}
              step={1000}
              value={limit}
              disabled={!canManage || busy}
              onChange={(e) => setLimit(e.target.value)}
              style={{ maxWidth: 200 }}
            />
            <span style={{ color: "var(--we-color-textMuted)", fontSize: 14 }}>
              Each request holds its largest possible cost until it finishes, so requests stop before the limit can be passed. Resets at midnight UTC.
            </span>
          </div>
          <p style={{ margin: 0 }}>
            Today: {number.format(data.today.usedTokens)} tokens used
            {data.today.reservedTokens > 0 ? `, ${number.format(data.today.reservedTokens)} held by requests in progress` : ""}, of{" "}
            {number.format(data.settings.dailyTokenLimit)}.
          </p>
          {canManage ? (
            <p style={{ margin: 0 }}>
              <button type="submit" disabled={busy || !validLimit}>
                Save
              </button>
            </p>
          ) : (
            <p style={{ margin: 0, color: "var(--we-color-textMuted)" }}>Only organization owners can change these settings.</p>
          )}
          <p role="status">{notice}</p>
        </form>
      )}
    </div>
  );
}
