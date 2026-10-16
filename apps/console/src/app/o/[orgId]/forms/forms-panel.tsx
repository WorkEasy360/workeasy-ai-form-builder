"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type FormResponse, type FormSummary, type Me } from "../../../../lib/api";

interface Template {
  id: string;
  name: string;
  description: string;
}

type Load =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; orgName: string; canCreate: boolean; canReadAudit: boolean };

/** Below 640px the table becomes stacked rows, each cell labelled from data-label. */
const RESPONSIVE_TABLE_CSS = `
@media (max-width: 640px) {
  .forms-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .forms-table, .forms-table tbody, .forms-table tr, .forms-table td { display: block; width: 100%; }
  .forms-table tr { padding: var(--we-space-1) 0; }
  .forms-table td[data-label]:not(:first-child)::before { content: attr(data-label) ": "; color: var(--we-color-textMuted); }
  .forms-table td.forms-actions { justify-content: flex-start !important; }
}
`;

const STATE_LABELS: Record<FormSummary["state"], string> = {
  draft: "Draft",
  published: "Published",
  closed: "Closed",
  archived: "Archived",
};

const button = {
  padding: "4px var(--we-space-1)",
  borderRadius: "var(--we-radius-sm)",
  border: "1px solid var(--we-color-border)",
  background: "var(--we-color-surface)",
  color: "var(--we-color-text)",
  font: "inherit",
  cursor: "pointer",
} as const;

const primaryButton = {
  ...button,
  padding: "var(--we-space-1) var(--we-space-2)",
  border: "1px solid var(--we-color-accent)",
  background: "var(--we-color-accent)",
  color: "var(--we-color-accentText)",
} as const;

const field = {
  font: "inherit",
  padding: "var(--we-space-1)",
  borderRadius: "var(--we-radius-sm)",
  border: "1px solid var(--we-color-border)",
  background: "var(--we-color-background)",
  color: "var(--we-color-text)",
} as const;

function message(err: unknown): string {
  return err instanceof ApiError ? err.problem.title : "Something went wrong.";
}

export function FormsPanel({ orgId }: { orgId: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [forms, setForms] = useState<FormSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [listError, setListError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<Me>("/api/v1/me"), api<{ templates: Template[] }>("/api/v1/form-templates")])
      .then(([me, t]) => {
        if (cancelled) return;
        const org = me.organizations.find((o) => o.id === orgId);
        if (!org) {
          setLoad({ kind: "not-found" });
          return;
        }
        setTemplates(t.templates);
        setLoad({
          kind: "ready",
          orgName: org.name,
          canCreate: org.permissions.includes("forms.create"),
          canReadAudit: org.permissions.includes("organization.audit.read"),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.problem.status === 401) setLoad({ kind: "signed-out" });
        else setLoad({ kind: "error", message: message(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  /** Fetches one page of forms; callers apply the result to state. */
  const fetchPage = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams({ limit: "25" });
      if (showArchived) params.set("state", "archived");
      if (cursor) params.set("cursor", cursor);
      return api<{ items: FormSummary[]; nextCursor?: string }>(`/api/v1/organizations/${orgId}/forms?${params}`);
    },
    [orgId, showArchived],
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
    if (load.kind !== "ready") return;
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
  }, [load.kind, fetchPage]);

  async function createForm(event: FormEvent) {
    event.preventDefault();
    setCreateError(null);
    setBusy("create");
    try {
      const created = await api<FormResponse>(`/api/v1/organizations/${orgId}/forms`, {
        method: "POST",
        body: template ? { name, template } : { name },
      });
      setName("");
      setTemplate("");
      setStatus(`Created "${created.form.name}".`);
      if (showArchived) setShowArchived(false);
      else await loadForms();
    } catch (err) {
      const fieldMessage = err instanceof ApiError ? err.problem.errors?.find((e) => e.field === "name")?.message : undefined;
      setCreateError(fieldMessage ? `Name: ${fieldMessage}` : message(err));
    } finally {
      setBusy(null);
    }
  }

  /** Deletes a form and every response on it, after asking why (the reason is kept with the deletion). */
  async function remove(formItem: FormSummary) {
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

  async function act(formItem: FormSummary, action: "duplicate" | "archive" | "restore") {
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

  if (load.kind === "loading") return <p role="status">Loading…</p>;
  if (load.kind === "signed-out") {
    return (
      <p>
        Your session has ended. <a href="/auth/login">Sign in</a> to continue.
      </p>
    );
  }
  if (load.kind === "not-found") {
    return (
      <div>
        <h1 style={{ fontSize: 24 }}>Organization not found</h1>
        <p>
          It doesn&apos;t exist or you don&apos;t have access. <a href="/">Back to your organizations</a>
        </p>
      </div>
    );
  }
  if (load.kind === "error") return <p role="alert">{load.message}</p>;

  return (
    <div>
      <p style={{ margin: 0 }}>
        <a href="/">← Your organizations</a>
      </p>
      <h1 style={{ fontSize: 28, marginBottom: 0 }}>Forms</h1>
      <p style={{ marginTop: 4, color: "var(--we-color-textMuted)" }}>
        {load.orgName}
        {load.canReadAudit && (
          <>
            {" · "}
            <a href={`/o/${orgId}/audit`}>Audit log</a>
          </>
        )}
      </p>

      {load.canCreate && (
        <form
          onSubmit={(e) => void createForm(e)}
          aria-labelledby="create-heading"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--we-space-1)",
            alignItems: "flex-end",
            padding: "var(--we-space-2)",
            border: "1px solid var(--we-color-border)",
            borderRadius: "var(--we-radius-md)",
            background: "var(--we-color-surface)",
          }}
        >
          <h2 id="create-heading" style={{ fontSize: 18, margin: 0, flexBasis: "100%" }}>
            Create a form
          </h2>
          <div style={{ display: "grid", gap: 4, flex: "1 1 240px" }}>
            <label htmlFor="new-form-name">Form name</label>
            <input
              id="new-form-name"
              style={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              required
              aria-invalid={createError ? true : undefined}
              aria-describedby={createError ? "create-error" : undefined}
            />
          </div>
          <div style={{ display: "grid", gap: 4, flex: "1 1 200px" }}>
            <label htmlFor="new-form-template">Start from</label>
            <select id="new-form-template" style={field} value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="">Blank form</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" style={primaryButton} disabled={busy === "create" || name.trim() === ""}>
            {busy === "create" ? "Creating…" : "Create form"}
          </button>
          {createError && (
            <p id="create-error" role="alert" style={{ flexBasis: "100%", margin: 0, color: "var(--we-color-danger)" }}>
              {createError}
            </p>
          )}
        </form>
      )}

      <style>{RESPONSIVE_TABLE_CSS}</style>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "space-between", alignItems: "center", marginTop: "var(--we-space-3)" }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>{showArchived ? "Archived forms" : "Your forms"}</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            id="show-archived"
            type="checkbox"
            checked={showArchived}
            onChange={(e) => {
              setForms(null);
              setShowArchived(e.target.checked);
            }}
          />
          <label htmlFor="show-archived">Show archived forms</label>
        </div>
      </div>

      <p role="status" aria-live="polite" style={{ minHeight: "1.5em" }}>
        {status}
      </p>

      {listError && (
        <p role="alert">
          {listError}{" "}
          <button type="button" style={button} onClick={() => void loadForms()}>
            Try again
          </button>
        </p>
      )}

      {forms === null && !listError && <p role="status">Loading forms…</p>}

      {forms !== null && forms.length === 0 && (
        <p>
          {showArchived
            ? "No archived forms."
            : load.canCreate
              ? "No forms yet. Create your first form above."
              : "No forms have been shared with you yet."}
        </p>
      )}

      {forms !== null && forms.length > 0 && (
        <table className="forms-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--we-color-border)" }}>
              <th scope="col" style={{ padding: "var(--we-space-1)" }}>Name</th>
              <th scope="col" style={{ padding: "var(--we-space-1)" }}>State</th>
              <th scope="col" style={{ padding: "var(--we-space-1)" }}>Last changed</th>
              <th scope="col" style={{ padding: "var(--we-space-1)" }}>
                <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {forms.map((f) => {
              const canDuplicate = load.canCreate && f.permissions.includes("forms.edit");
              const canArchive = f.permissions.includes("forms.publish");
              return (
                <tr key={f.id} style={{ borderBottom: "1px solid var(--we-color-border)" }}>
                  <td data-label="Name" style={{ padding: "var(--we-space-1)", fontWeight: 600 }}>
                    {f.permissions.includes("forms.edit") && f.state !== "archived" ? <a href={`/o/${orgId}/forms/${f.id}/build`}>{f.name}</a> : f.name}
                  </td>
                  <td data-label="State" style={{ padding: "var(--we-space-1)" }}>{STATE_LABELS[f.state]}</td>
                  <td data-label="Last changed" style={{ padding: "var(--we-space-1)" }}>
                    <time dateTime={f.updatedAt}>{new Date(f.updatedAt).toLocaleString()}</time>
                  </td>
                  <td className="forms-actions" style={{ padding: "var(--we-space-1)", display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
                    {f.permissions.includes("responses.read") && (
                      <a href={`/o/${orgId}/forms/${f.id}/responses`} aria-label={`Responses to ${f.name}`} style={{ alignSelf: "center" }}>
                        Responses
                      </a>
                    )}
                    {canDuplicate && f.state !== "archived" && (
                      <button type="button" style={button} disabled={busy !== null} onClick={() => void act(f, "duplicate")} aria-label={`Duplicate ${f.name}`}>
                        Duplicate
                      </button>
                    )}
                    {canArchive && f.state !== "archived" && (
                      <button type="button" style={button} disabled={busy !== null} onClick={() => void act(f, "archive")} aria-label={`Archive ${f.name}`}>
                        Archive
                      </button>
                    )}
                    {f.permissions.includes("forms.delete") && (
                      <button type="button" style={button} disabled={busy !== null} onClick={() => void remove(f)} aria-label={`Delete ${f.name}`}>
                        Delete
                      </button>
                    )}
                    {canArchive && f.state === "archived" && (
                      <button type="button" style={button} disabled={busy !== null} onClick={() => void act(f, "restore")} aria-label={`Restore ${f.name}`}>
                        Restore
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {nextCursor && (
        <p>
          <button type="button" style={button} onClick={() => void loadForms(nextCursor)}>
            Load more
          </button>
        </p>
      )}
    </div>
  );
}
