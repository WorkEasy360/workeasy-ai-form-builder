"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../../lib/api";

interface Entry {
  id: string;
  occurredAt: string;
  actor: { type: "user" | "system"; id: string | null; displayName: string | null };
  action: string;
  resourceType: string;
  resourceId: string;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

const ACTIONS: Record<string, string> = {
  "form.created": "Created a form",
  "form.duplicated": "Duplicated a form",
  "form.published": "Published a version",
  "form.version_activated": "Changed the live version",
  "form.closed": "Closed a form",
  "form.reopened": "Reopened a form",
  "form.archived": "Archived a form",
  "form.restored": "Restored a form",
  "form.deleted": "Deleted a form",
  "form.access_policy_changed": "Changed access, limits or schedule",
  "form.grants_changed": "Changed form access",
  "form.retention_changed": "Changed data retention",
  "response.deleted": "Deleted a response",
  "response.purged": "Erased a deleted response",
  "responses.retention_deleted": "Deleted responses past retention",
  "responses.export_requested": "Requested an export",
  "responses.export_downloaded": "Downloaded an export",
  "job.replayed": "Retried a failed background job",
  "ai.generation_requested": "Asked AI for a form suggestion",
  "ai.generation_cancelled": "Cancelled an AI request",
  "ai.proposal_applied": "Applied an AI suggestion to a draft",
  "ai.proposal_rejected": "Rejected an AI suggestion",
  "organization.ai_settings_changed": "Changed AI settings",
  "integration.created": "Added a notification or webhook",
  "integration.updated": "Changed a notification or webhook",
  "integration.deleted": "Removed a notification or webhook",
  "integration.secret_rotated": "Replaced a webhook signing secret",
  "delivery.retried": "Sent a failed delivery again",
};

function details(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("; ");
}

/** The organization's audit log (GOV-01): who did what, when; identifiers and counts, never answers. */
export function AuditLog({ orgId }: { orgId: string }) {
  const [items, setItems] = useState<Entry[] | undefined>();
  const [next, setNext] = useState<string | undefined>();
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(
    (cursor: string | undefined, filter: string) => {
      const params = new URLSearchParams({ limit: "50" });
      if (cursor) params.set("cursor", cursor);
      if (filter) params.set("action", filter);
      return api<{ items: Entry[]; nextCursor?: string }>(`/api/v1/organizations/${orgId}/audit?${params.toString()}`);
    },
    [orgId],
  );

  useEffect(() => {
    let cancelled = false;
    load(undefined, action)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNext(page.nextCursor);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.problem.title : "Something went wrong.");
      });
    return () => {
      cancelled = true;
    };
  }, [load, action]);

  async function more() {
    if (!next) return;
    const page = await load(next, action);
    setItems((prev) => [...(prev ?? []), ...page.items]);
    setNext(page.nextCursor);
  }

  return (
    <div>
      <h1 style={{ margin: "0 0 8px" }}>Audit log</h1>
      <p style={{ color: "var(--we-text-secondary)", marginTop: 0 }}>Who changed what, and when. Entries never contain answers.</p>
      <label style={{ display: "inline-grid", gap: 4, marginBottom: 16 }}>
        Show
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {Object.entries(ACTIONS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {!items && !error && <p role="status">Loading…</p>}
      {items && items.length === 0 && <p>Nothing recorded yet.</p>}
      {items && items.length > 0 && (
        // Focusable so keyboard users can scroll the table sideways on narrow screens.
        <div style={{ overflowX: "auto", position: "relative" }} tabIndex={0} role="region" aria-label="Audit entries">
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--we-border)" }}>
                <th scope="col" style={{ padding: 8 }}>When</th>
                <th scope="col" style={{ padding: 8 }}>Who</th>
                <th scope="col" style={{ padding: 8 }}>What</th>
                <th scope="col" style={{ padding: 8 }}>Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} style={{ borderBottom: "1px solid var(--we-border)", verticalAlign: "top" }}>
                  <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                    <time dateTime={e.occurredAt}>{new Date(e.occurredAt).toLocaleString()}</time>
                  </td>
                  <td style={{ padding: 8 }}>{e.actor.type === "system" ? "System" : (e.actor.displayName ?? "A former member")}</td>
                  <td style={{ padding: 8 }}>
                    {ACTIONS[e.action] ?? e.action}
                    <div style={{ color: "var(--we-text-secondary)", fontSize: 12 }}>
                      {e.resourceType} {e.resourceId.slice(0, 8)}
                    </div>
                  </td>
                  <td style={{ padding: 8, overflowWrap: "anywhere", color: "var(--we-text-secondary)" }}>{details(e.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <p>
          <button type="button" onClick={() => void more()}>
            Load more
          </button>
        </p>
      )}
    </div>
  );
}
