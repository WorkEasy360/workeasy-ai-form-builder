"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type FormListItem, type FormResponse } from "../../../../lib/api";
import { FormsIcon, MoreIcon, PlusIcon, SearchIcon } from "../../../icons";
import { useOrg } from "../org-shell";
import { STATE_BADGE } from "./[formId]/form-frame";

function message(err: unknown): string {
  return err instanceof ApiError ? err.problem.title : "Something went wrong.";
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "3 hours ago", "yesterday", … for recent times; a date for older ones. */
export function ago(iso: string): string {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit);
    value /= size;
  }
  return new Date(iso).toLocaleDateString();
}

/**
 * All forms in the organization: search, active or archived, each with its
 * state, responses and last change, an Edit button and a menu of actions.
 * Creating a form happens on its own page (blank, template or AI).
 */
export function FormsPanel({ orgId }: { orgId: string }) {
  const org = useOrg();
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [forms, setForms] = useState<FormListItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [listError, setListError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const canCreate = org?.permissions.includes("forms.create") ?? false;
  const canIntegrate = org?.permissions.includes("integrations.manage") ?? false;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Search as you type, after a short pause.
  useEffect(() => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(searchTimer.current);
  }, [query]);

  const fetchPage = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams({ limit: "25" });
      if (showArchived) params.set("state", "archived");
      if (search) params.set("q", search);
      if (cursor) params.set("cursor", cursor);
      return api<{ items: FormListItem[]; nextCursor?: string }>(`/api/v1/organizations/${orgId}/forms?${params}`);
    },
    [orgId, showArchived, search],
  );

  async function loadForms(cursor?: string) {
    try {
      const page = await fetchPage(cursor);
      setListError(null);
      setForms((current) => (cursor && current ? [...current, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
    } catch (err) {
      setListError(message(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchPage().then(
      (page) => {
        if (cancelled) return;
        setListError(null);
        setForms(page.items);
        setNextCursor(page.nextCursor);
      },
      (err: unknown) => {
        if (!cancelled) setListError(message(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  /** Deletes a form and every response on it, after asking why (the reason is kept with the deletion). */
  async function remove(formItem: FormListItem) {
    const reason = window.prompt(
      `Delete "${formItem.name}" and all its responses?\n\nThis can't be undone: responses and their files are erased shortly afterwards. Type the reason to continue.`,
    );
    if (!reason || reason.trim().length < 3) return;
    setBusy(`delete:${formItem.id}`);
    setStatus("");
    try {
      const res = await api<{ responses: number }>(`/api/v1/organizations/${orgId}/forms/${formItem.id}`, { method: "DELETE", body: { reason: reason.trim() } });
      setStatus(`Deleted "${formItem.name}" and ${res.responses === 1 ? "1 response" : `${res.responses} responses`}.`);
      await loadForms();
    } catch (err) {
      setStatus(`Couldn't delete "${formItem.name}": ${message(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function act(formItem: FormListItem, action: "duplicate" | "archive" | "restore") {
    setBusy(`${action}:${formItem.id}`);
    setStatus("");
    try {
      const path = `/api/v1/organizations/${orgId}/forms/${formItem.id}/${action}`;
      if (action === "duplicate") {
        const copyName = `${formItem.name} (copy)`.slice(0, 200);
        await api<FormResponse>(path, { method: "POST", body: { name: copyName } });
        setStatus(`Created "${copyName}".`);
      } else {
        await api<FormResponse>(path, { method: "POST" });
        setStatus(action === "archive" ? `Archived "${formItem.name}".` : `Restored "${formItem.name}" as a draft.`);
      }
      await loadForms();
    } catch (err) {
      setStatus(`Couldn't ${action} "${formItem.name}": ${message(err)}`);
    } finally {
      setBusy(null);
    }
  }

  const base = `/o/${orgId}/forms`;
  return (
    <div className="c-page">
      <div className="c-page-head">
        <div>
          <h1>Forms</h1>
          <p className="c-subtitle">{org ? `Everything your team collects in ${org.orgName}.` : " "}</p>
        </div>
        {canCreate && (
          <a className="c-btn c-btn-primary" href={`${base}/new`}>
            <PlusIcon size={16} /> Create form
          </a>
        )}
      </div>

      <div className="c-toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <label className="c-search">
          <SearchIcon size={16} />
          <span className="c-visually-hidden">Search forms</span>
          <input className="c-input" type="search" placeholder="Search forms by name" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={200} />
        </label>
        <div className="c-segmented" role="group" aria-label="Which forms">
          <button
            type="button"
            aria-pressed={!showArchived}
            onClick={() => {
              setForms(null);
              setShowArchived(false);
            }}
          >
            Active
          </button>
          <button
            type="button"
            aria-pressed={showArchived}
            onClick={() => {
              setForms(null);
              setShowArchived(true);
            }}
          >
            Archived
          </button>
        </div>
      </div>

      <p className="c-status" role="status" aria-live="polite">
        {status}
      </p>

      {listError && (
        <p role="alert">
          {listError}{" "}
          <button type="button" className="c-btn c-btn-sm" onClick={() => void loadForms()}>
            Try again
          </button>
        </p>
      )}

      {forms === null && !listError && (
        <div className="c-table-wrap" aria-busy="true">
          <p className="c-visually-hidden" role="status">
            Loading forms…
          </p>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ padding: 16, display: "grid", gap: 8, borderBottom: "1px solid var(--we-border)" }}>
              <div className="c-skeleton" style={{ width: "40%" }} />
              <div className="c-skeleton" style={{ width: "20%" }} />
            </div>
          ))}
        </div>
      )}

      {forms !== null && forms.length === 0 && (
        <div className="c-empty">
          <span className="c-icon-tile" style={{ margin: "0 auto" }}>
            <FormsIcon />
          </span>
          {search ? (
            <>
              <h2>No forms match “{search}”</h2>
              <p>Try another name, or clear the search.</p>
              <button type="button" className="c-btn" onClick={() => setQuery("")}>
                Clear search
              </button>
            </>
          ) : showArchived ? (
            <>
              <h2>No archived forms</h2>
              <p>Forms you archive are kept here, and can be restored.</p>
            </>
          ) : (
            <>
              <h2>{canCreate ? "Create your first form" : "No forms yet"}</h2>
              <p>{canCreate ? "Start from a blank form, a template, or describe what you need and let AI draft it." : "Forms shared with you will appear here."}</p>
              {canCreate && (
                <a className="c-btn c-btn-primary" href={`${base}/new`}>
                  <PlusIcon size={16} /> Create form
                </a>
              )}
            </>
          )}
        </div>
      )}

      {forms !== null && forms.length > 0 && (
        <div className="c-table-wrap">
          <table className="c-table c-table-stack">
            <thead>
              <tr>
                <th scope="col">Form</th>
                <th scope="col">Status</th>
                <th scope="col" className="c-num">
                  Responses
                </th>
                <th scope="col">Last response</th>
                <th scope="col">
                  <span className="c-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {forms.map((f) => {
                const canEdit = f.permissions.includes("forms.edit") && f.state !== "archived";
                const canDuplicate = canCreate && f.permissions.includes("forms.edit") && f.state !== "archived";
                const canArchive = f.permissions.includes("forms.publish");
                const badge = STATE_BADGE[f.state];
                return (
                  <tr key={f.id}>
                    <td data-label="Form">
                      {canEdit ? (
                        <a className="c-cell-title" href={`${base}/${f.id}/build`}>
                          {f.name}
                        </a>
                      ) : (
                        <span className="c-cell-title">{f.name}</span>
                      )}
                      <span className="c-cell-sub">
                        Changed <time dateTime={f.updatedAt}>{ago(f.updatedAt)}</time>
                      </span>
                    </td>
                    <td data-label="Status">
                      <span className="c-badge" data-tone={badge.tone}>
                        {badge.label}
                      </span>
                    </td>
                    <td data-label="Responses" className="c-num">
                      {f.responseCount === null ? (
                        "—"
                      ) : f.permissions.includes("responses.read") ? (
                        <a href={`${base}/${f.id}/responses`} aria-label={`${f.responseCount} responses to ${f.name}`}>
                          {f.responseCount.toLocaleString()}
                        </a>
                      ) : (
                        f.responseCount.toLocaleString()
                      )}
                    </td>
                    <td data-label="Last response">{f.lastResponseAt ? <time dateTime={f.lastResponseAt}>{ago(f.lastResponseAt)}</time> : "—"}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <span className="c-toolbar" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                        {canEdit && (
                          <a className="c-btn c-btn-sm" href={`${base}/${f.id}/build`} aria-label={`Edit ${f.name}`}>
                            Edit
                          </a>
                        )}
                        <details className="c-menu">
                          <summary className="c-btn c-btn-sm c-btn-ghost" aria-label={`More actions for ${f.name}`}>
                            <MoreIcon />
                          </summary>
                          <div className="c-menu-list">
                            {f.permissions.includes("responses.read") && <a href={`${base}/${f.id}/responses`}>Responses</a>}
                            {f.permissions.includes("analytics.read") && <a href={`${base}/${f.id}/analytics`}>Analytics</a>}
                            {canIntegrate && <a href={`${base}/${f.id}/integrations`}>Notifications and webhooks</a>}
                            {canDuplicate && (
                              <button type="button" disabled={busy !== null} onClick={() => void act(f, "duplicate")}>
                                Duplicate
                              </button>
                            )}
                            {canArchive && f.state !== "archived" && (
                              <button type="button" disabled={busy !== null} onClick={() => void act(f, "archive")}>
                                Archive
                              </button>
                            )}
                            {canArchive && f.state === "archived" && (
                              <button type="button" disabled={busy !== null} onClick={() => void act(f, "restore")}>
                                Restore
                              </button>
                            )}
                            {f.permissions.includes("forms.delete") && (
                              <>
                                <hr />
                                <button type="button" className="c-danger" disabled={busy !== null} onClick={() => void remove(f)}>
                                  Delete…
                                </button>
                              </>
                            )}
                          </div>
                        </details>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <p style={{ textAlign: "center" }}>
          <button type="button" className="c-btn" onClick={() => void loadForms(nextCursor)}>
            Load more
          </button>
        </p>
      )}
    </div>
  );
}
