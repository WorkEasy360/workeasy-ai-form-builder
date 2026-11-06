"use client";

import { useEffect, useId, useState } from "react";
import { api, ApiError } from "../../../../lib/api";
import { ModuleHeader } from "../module-header";

interface AiSettingsResponse {
  settings: { dailyTokenLimit: number };
  available: boolean;
  today: { usedTokens: number; reservedTokens: number };
}

const number = new Intl.NumberFormat();

/**
 * The organization's daily AI budget (AI-03). AI drafting and the assistant
 * are always on; owners cap the tokens they may use per day, and everyone
 * else sees the setting read-only.
 */
export function AiSettingsForm({ orgId }: { orgId: string }) {
  const ids = { limit: useId() };
  const path = `/api/v1/organizations/${orgId}/ai-settings`;
  const [data, setData] = useState<AiSettingsResponse | undefined>();
  const [canManage, setCanManage] = useState(false);
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
      const next = await api<AiSettingsResponse>(path, { method: "PUT", body: { dailyTokenLimit: Number(limit) } });
      setData(next);
      setNotice("Saved the daily limit.");
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
      <ModuleHeader module="ai" />
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
          {!data.available && <p role="note">AI isn&apos;t set up on this server, so AI drafting and the assistant aren&apos;t available yet.</p>}
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
            <span style={{ color: "var(--we-text-secondary)", fontSize: 14 }}>
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
            <p style={{ margin: 0, color: "var(--we-text-secondary)" }}>Only organization owners can change the daily limit.</p>
          )}
          <p role="status">{notice}</p>
        </form>
      )}
    </div>
  );
}
