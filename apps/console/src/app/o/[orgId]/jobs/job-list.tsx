"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../../../lib/api";

type Status = "queued" | "running" | "succeeded" | "dead";

interface Job {
  id: string;
  type: string;
  status: Status;
  sourceEventId: string | null;
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  finishedAt: string | null;
}

const STATUS: Record<Status, string> = {
  queued: "Waiting",
  running: "Running",
  succeeded: "Done",
  dead: "Failed (needs attention)",
};

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.problem.title : "Something went wrong.";
}

/**
 * Background jobs (JOB-01): deliveries and other work the worker does after a
 * change is saved. Shows state, attempts and an error code, never payloads.
 * People who manage integrations can retry a job that stopped failing.
 */
export function JobList({ orgId }: { orgId: string }) {
  const [items, setItems] = useState<Job[] | undefined>();
  const [next, setNext] = useState<string | undefined>();
  const [status, setStatus] = useState<Status | "">("");
  const [canReplay, setCanReplay] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState("");

  const load = useCallback(
    (cursor: string | undefined, filter: Status | "") => {
      const params = new URLSearchParams({ limit: "50" });
      if (cursor) params.set("cursor", cursor);
      if (filter) params.set("status", filter);
      return api<{ items: Job[]; nextCursor?: string }>(`/api/v1/organizations/${orgId}/jobs?${params.toString()}`);
    },
    [orgId],
  );

  useEffect(() => {
    let cancelled = false;
    api<{ organizations: Array<{ id: string; permissions: string[] }> }>("/api/v1/me")
      .then((me) => {
        if (!cancelled) setCanReplay(me.organizations.find((o) => o.id === orgId)?.permissions.includes("integrations.manage") ?? false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  useEffect(() => {
    let cancelled = false;
    load(undefined, status)
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setNext(page.nextCursor);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [load, status]);

  async function more() {
    if (!next) return;
    const page = await load(next, status);
    setItems((prev) => [...(prev ?? []), ...page.items]);
    setNext(page.nextCursor);
  }

  async function replay(job: Job) {
    setNotice("");
    try {
      const res = await api<{ job: Job }>(`/api/v1/organizations/${orgId}/jobs/${job.id}/replay`, { method: "POST" });
      setItems((prev) => prev?.map((j) => (j.id === job.id ? res.job : j)));
      setNotice(`Retrying ${job.type}.`);
    } catch (err) {
      setNotice(`Couldn't retry ${job.type}: ${errorText(err)}`);
    }
  }

  return (
    <div>
      <h1 style={{ margin: "0 0 8px" }}>Background jobs</h1>
      <p style={{ color: "var(--we-text-secondary)", marginTop: 0 }}>
        Work done after a change is saved, such as deliveries. Failed attempts are retried automatically; a job that keeps failing stops and waits here.
      </p>
      <label style={{ display: "inline-grid", gap: 4, marginBottom: 16 }}>
        Show
        <select value={status} onChange={(e) => setStatus(e.target.value as Status | "")}>
          <option value="">All jobs</option>
          {Object.entries(STATUS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p role="status">{notice}</p>
      {error && <p role="alert">{error}</p>}
      {!items && !error && <p>Loading…</p>}
      {items && items.length === 0 && <p>No jobs yet.</p>}
      {items && items.length > 0 && (
        // Focusable so keyboard users can scroll the table sideways on narrow screens.
        <div style={{ overflowX: "auto", position: "relative" }} tabIndex={0} role="region" aria-label="Background jobs">
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--we-border)" }}>
                <th scope="col" style={{ padding: 8 }}>Created</th>
                <th scope="col" style={{ padding: 8 }}>Job</th>
                <th scope="col" style={{ padding: 8 }}>Status</th>
                <th scope="col" style={{ padding: 8 }}>Attempts</th>
                <th scope="col" style={{ padding: 8 }}>Last error</th>
                {canReplay && (
                  <th scope="col" style={{ padding: 8 }}>
                    <span className="c-visually-hidden">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((j) => (
                <tr key={j.id} style={{ borderBottom: "1px solid var(--we-border)", verticalAlign: "top" }}>
                  <td style={{ padding: 8, whiteSpace: "nowrap" }}>
                    <time dateTime={j.createdAt}>{new Date(j.createdAt).toLocaleString()}</time>
                  </td>
                  <td style={{ padding: 8 }}>
                    {j.type}
                    <div style={{ color: "var(--we-text-secondary)", fontSize: 12 }}>{j.id.slice(0, 8)}</div>
                  </td>
                  <td style={{ padding: 8 }}>
                    {STATUS[j.status]}
                    {j.status === "queued" && j.attempt > 0 && (
                      <div style={{ color: "var(--we-text-secondary)", fontSize: 12 }}>
                        Next try <time dateTime={j.nextAttemptAt}>{new Date(j.nextAttemptAt).toLocaleTimeString()}</time>
                      </div>
                    )}
                  </td>
                  <td style={{ padding: 8 }}>
                    {j.attempt} of {j.maxAttempts}
                  </td>
                  <td style={{ padding: 8, color: "var(--we-text-secondary)" }}>{j.lastError ?? "—"}</td>
                  {canReplay && (
                    <td style={{ padding: 8 }}>
                      {j.status === "dead" && (
                        <button type="button" onClick={() => void replay(j)} aria-label={`Retry ${j.type} ${j.id.slice(0, 8)}`}>
                          Retry
                        </button>
                      )}
                    </td>
                  )}
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
