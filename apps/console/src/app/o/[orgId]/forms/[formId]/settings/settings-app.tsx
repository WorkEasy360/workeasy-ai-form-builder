"use client";

import type { FormDefinition } from "@workeasy/form-schema";
import { useEffect, useId, useState } from "react";
import { api, ApiError, type FormResponse, type FormSummary } from "../../../../../../lib/api";
import { LimitsEditor } from "../build/limits-editor";
import { RetentionEditor } from "../build/retention-editor";
import { BUILDER_CSS } from "../build/styles";

type AccessMode = "public" | "organization";
type Section = "general" | "access" | "limits" | "spam" | "retention";

interface Policy {
  mode: AccessMode;
  spamProtection: boolean;
}

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: "general", label: "General" },
  { id: "access", label: "Access" },
  { id: "limits", label: "Limits and schedule" },
  { id: "spam", label: "Spam protection" },
  { id: "retention", label: "Data retention" },
];

function errorText(err: unknown): string {
  return err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.";
}

/**
 * Form settings in one place (like the settings area of other form
 * builders): what respondents see after submitting, who can respond and
 * whether the form is accepting responses, limits and schedule, spam
 * protection and data retention. Link, QR code and embedding stay in Share.
 */
export function SettingsApp({ orgId, formId }: { orgId: string; formId: string }) {
  const formPath = `/api/v1/organizations/${orgId}/forms/${formId}`;
  const [form, setForm] = useState<FormSummary | undefined>();
  const [section, setSection] = useState<Section>("general");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    api<FormResponse>(formPath)
      .then((r) => {
        if (!cancelled) setForm(r.form);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [formPath]);

  if (error) return <p role="alert">{error}</p>;
  if (!form) return <p>Loading…</p>;
  const canEdit = form.permissions.includes("forms.edit") && form.state !== "archived";
  const canPublish = form.permissions.includes("forms.publish") && form.state !== "archived";

  return (
    <div className="s-layout">
      <style>{BUILDER_CSS + SETTINGS_CSS}</style>
      <nav className="s-nav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" aria-current={section === s.id ? "page" : undefined} onClick={() => setSection(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="s-body">
        <p role="status" aria-live="polite" className="b-muted" style={{ minHeight: "1.5em", margin: "0 0 8px" }}>
          {status}
        </p>
        {form.state === "archived" && <p className="b-banner">This form is archived. Restore it from the forms list to change its settings.</p>}
        {section === "general" && <GeneralSettings formPath={formPath} canEdit={canEdit} announce={setStatus} />}
        {section === "access" && <AccessSettings formPath={formPath} form={form} canPublish={canPublish} onFormChange={setForm} announce={setStatus} />}
        {section === "limits" && <LimitsEditor formPath={formPath} canEdit={canPublish} announce={setStatus} />}
        {section === "spam" && <SpamSettings formPath={formPath} canPublish={canPublish} announce={setStatus} />}
        {section === "retention" && <RetentionEditor formPath={formPath} canEdit={canPublish} announce={setStatus} />}
      </div>
    </div>
  );
}

const SETTINGS_CSS = `
.s-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; }
.s-nav { display: grid; gap: 2px; position: sticky; top: calc(var(--c-topbar, 0px) + 16px); }
.s-nav button { all: unset; box-sizing: border-box; cursor: pointer; padding: 8px 12px; border-radius: var(--we-radius-md); color: var(--we-text-primary); }
.s-nav button { font-weight: 500; transition: background-color var(--we-duration-fast) var(--we-ease); }
.s-nav button:hover { background: var(--we-surface-hover); }
.s-nav button:focus-visible { outline: 2px solid var(--we-focus); }
.s-nav button[aria-current="page"] { background: var(--we-surface); color: var(--we-primary); font-weight: 600; box-shadow: inset 3px 0 0 var(--we-accent), var(--we-shadow-xs); }
.s-body { max-width: 640px; min-width: 0; }
.s-body h2 { font-size: var(--we-text-lg); margin: 0 0 4px; }
.s-body section + section { margin-top: 32px; }
@media (max-width: 899px) {
  .s-layout { grid-template-columns: minmax(0, 1fr); }
  .s-nav { position: static; display: flex; overflow-x: auto; }
  .s-nav button { white-space: nowrap; }
}
`;

/** The thank-you message and an optional redirect: part of the form, so they go live when it is published. */
function GeneralSettings({ formPath, canEdit, announce }: { formPath: string; canEdit: boolean; announce: (m: string) => void }) {
  const ids = { message: useId(), redirect: useId(), mode: useId() };
  const [draft, setDraft] = useState<{ revision: number; definition: FormDefinition } | undefined>();
  const [message, setMessage] = useState("");
  const [redirect, setRedirect] = useState("");
  const [useRedirect, setUseRedirect] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ revision: number; definition: FormDefinition }>(`${formPath}/draft`)
      .then((d) => {
        if (cancelled) return;
        setDraft(d);
        setMessage(d.definition.success.message);
        setRedirect(d.definition.success.redirectUrl ?? "");
        setUseRedirect(!!d.definition.success.redirectUrl);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [formPath]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    const success: FormDefinition["success"] = { message: message.trim() };
    if (useRedirect && redirect.trim()) success.redirectUrl = redirect.trim();
    try {
      const saved = await api<{ revision: number }>(`${formPath}/draft`, {
        method: "PUT",
        headers: { "If-Match": `"draft-${draft.revision}"` },
        body: { ...draft.definition, success },
      });
      setDraft({ revision: saved.revision, definition: { ...draft.definition, success } });
      announce("Saved to the draft. Respondents see it after you publish.");
    } catch (err) {
      setError(err instanceof ApiError && err.problem.status === 412 ? "Someone changed the form meanwhile. Reload the page to see their version, then try again." : errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!draft) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;
  const changed = message.trim() !== draft.definition.success.message || (useRedirect ? redirect.trim() : "") !== (draft.definition.success.redirectUrl ?? "");
  return (
    <section aria-labelledby={`${ids.message}-h`}>
      <h2 id={`${ids.message}-h`}>After submitting</h2>
      <p className="b-muted" style={{ marginTop: 0 }}>
        What respondents see once their response is in. Saved to the draft; it goes live when you publish.
      </p>
      <div className="b-field">
        <label htmlFor={ids.message}>Thank-you message</label>
        <textarea id={ids.message} rows={3} maxLength={2000} value={message} disabled={!canEdit || busy} onChange={(e) => setMessage(e.target.value)} />
      </div>
      <fieldset className="b-field" style={{ border: 0, padding: 0, margin: 0 }} disabled={!canEdit || busy}>
        <legend style={{ fontWeight: 600, marginBottom: 6, padding: 0 }}>Then</legend>
        <label style={{ display: "flex", gap: 8 }}>
          <input type="radio" name={ids.mode} checked={!useRedirect} onChange={() => setUseRedirect(false)} /> Stay on the thank-you message
        </label>
        <label style={{ display: "flex", gap: 8 }}>
          <input type="radio" name={ids.mode} checked={useRedirect} onChange={() => setUseRedirect(true)} /> Go to a web page after a moment
        </label>
      </fieldset>
      {useRedirect && (
        <div className="b-field">
          <label htmlFor={ids.redirect}>Web page address</label>
          <input id={ids.redirect} type="url" placeholder="https://example.com/thank-you" maxLength={2000} value={redirect} disabled={!canEdit || busy} onChange={(e) => setRedirect(e.target.value)} />
          <p className="b-muted" style={{ margin: 0 }}>
            Respondents see the thank-you message and their receipt number first. Embedded forms send the whole page there when the site allows it.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="b-inline-error">
          {error}
        </p>
      )}
      <p>
        <button type="button" className="b-btn b-primary" disabled={!canEdit || busy || !changed || message.trim() === "" || (useRedirect && !/^https?:\/\/\S+$/.test(redirect.trim()))} onClick={() => void save()}>
          Save
        </button>
      </p>
    </section>
  );
}

const ACCESS_CHOICES: Array<{ mode: AccessMode; label: string; hint: string }> = [
  { mode: "public", label: "Anyone with the link", hint: "No sign-in needed." },
  { mode: "organization", label: "Only members of this organization", hint: "Respondents sign in with their Workeasy account; others are turned away." },
];

/** Who can respond, and whether the form is accepting responses right now. */
function AccessSettings({
  formPath,
  form,
  canPublish,
  onFormChange,
  announce,
}: {
  formPath: string;
  form: FormSummary;
  canPublish: boolean;
  onFormChange: (form: FormSummary) => void;
  announce: (m: string) => void;
}) {
  const name = useId();
  const reasonId = useId();
  const [policy, setPolicy] = useState<Policy | undefined>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    api<Policy>(`${formPath}/access-policy`)
      .then((p) => {
        if (!cancelled) setPolicy(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [formPath]);

  async function setMode(mode: AccessMode) {
    if (!policy || policy.mode === mode) return;
    setBusy(true);
    try {
      setPolicy(await api<Policy>(`${formPath}/access-policy`, { method: "PATCH", body: { mode } }));
      announce(mode === "organization" ? "Only signed-in members of this organization can respond now." : "Anyone with the link can respond now.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function change(action: "close" | "reopen") {
    if (action === "close" && !window.confirm("Close this form?\n\nRespondents can no longer submit, including anyone who has it open right now. You can reopen it later.")) return;
    setBusy(true);
    try {
      const res = await api<FormResponse>(`${formPath}/${action}`, { method: "POST", ...(action === "close" ? { body: reason.trim() ? { reason: reason.trim() } : {} } : {}) });
      onFormChange(res.form);
      setReason("");
      announce(action === "close" ? "The form is closed. Respondents see that it isn't accepting responses." : "The form is open again.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section aria-labelledby={`${name}-who`}>
        <h2 id={`${name}-who`}>Who can respond</h2>
        {!policy && !error && <p>Loading…</p>}
        {policy &&
          ACCESS_CHOICES.map((choice) => (
            <label key={choice.mode} style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0 8px", margin: "8px 0" }}>
              <input type="radio" name={name} checked={policy.mode === choice.mode} disabled={!canPublish || busy} onChange={() => void setMode(choice.mode)} />
              <span>{choice.label}</span>
              <span />
              <span className="b-muted">{choice.hint}</span>
            </label>
          ))}
      </section>
      <section aria-labelledby={`${name}-open`}>
        <h2 id={`${name}-open`}>Accepting responses</h2>
        {form.state === "published" && (
          <>
            <p className="b-muted" style={{ marginTop: 0 }}>
              The form is open. Closing it stops new responses at once, even from people who have it open.
            </p>
            <div className="b-field">
              <label htmlFor={reasonId}>Reason for closing (optional, kept in the audit log)</label>
              <input id={reasonId} value={reason} maxLength={500} disabled={!canPublish || busy} onChange={(e) => setReason(e.target.value)} />
            </div>
            <button type="button" className="b-btn" disabled={!canPublish || busy} onClick={() => void change("close")}>
              Close form
            </button>
          </>
        )}
        {form.state === "closed" && (
          <>
            <p className="b-muted" style={{ marginTop: 0 }}>
              The form is closed: its link says it isn&apos;t accepting responses.
            </p>
            <button type="button" className="b-btn b-primary" disabled={!canPublish || busy} onClick={() => void change("reopen")}>
              Reopen form
            </button>
          </>
        )}
        {(form.state === "draft" || form.state === "archived") && <p className="b-muted">Only a published form can be closed or reopened.</p>}
      </section>
      {error && (
        <p role="alert" className="b-inline-error">
          {error}
        </p>
      )}
    </>
  );
}

/** Honeypot and minimum fill time, on by default; no outside service involved. */
function SpamSettings({ formPath, canPublish, announce }: { formPath: string; canPublish: boolean; announce: (m: string) => void }) {
  const id = useId();
  const [policy, setPolicy] = useState<Policy | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<Policy>(`${formPath}/access-policy`)
      .then((p) => {
        if (!cancelled) setPolicy(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [formPath]);

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      setPolicy(await api<Policy>(`${formPath}/access-policy`, { method: "PATCH", body: { spamProtection: on } }));
      announce(on ? "Spam protection is on." : "Spam protection is off.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Spam protection</h2>
      <p className="b-muted" style={{ marginTop: 0 }}>
        Turns away automated submissions without a puzzle for respondents: a hidden field people never see and bots tend to fill in, and a check that the form
        wasn&apos;t submitted within two seconds of opening. Blocked submissions are not stored.
      </p>
      {!policy && !error && <p>Loading…</p>}
      {policy && (
        <label htmlFor={id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input id={id} type="checkbox" checked={policy.spamProtection} disabled={!canPublish || busy} onChange={(e) => void toggle(e.target.checked)} />
          Protect this form from spam
        </label>
      )}
      {error && (
        <p role="alert" className="b-inline-error">
          {error}
        </p>
      )}
    </section>
  );
}
