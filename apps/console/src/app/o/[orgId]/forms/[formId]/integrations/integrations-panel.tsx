"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { api, ApiError } from "../../../../../../lib/api";

interface Integration {
  id: string;
  kind: "webhook" | "email" | "confirmation";
  name: string;
  enabled: boolean;
  url: string | null;
  recipients: string[] | null;
  fieldIds: string[];
  recipientFieldId: string | null;
  subject: string | null;
  previousSecretExpiresAt: string | null;
}

interface Delivery {
  id: string;
  submissionId: string;
  eventId: string;
  status: "pending" | "retrying" | "succeeded" | "failed" | "skipped";
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  ambiguous: boolean;
  nextAttemptAt: string | null;
  createdAt: string;
}

interface Attempt {
  attempt: number;
  startedAt: string;
  durationMs: number;
  statusCode: number | null;
  errorCode: string | null;
  outcome: string;
}

const ERRORS: Record<string, string> = {
  destination_blocked: "The address points to a private or internal network, so it was not contacted.",
  redirect_not_followed: "The destination answered with a redirect; redirects are not followed.",
  timeout: "No answer within 10 seconds.",
  connection_refused: "The destination refused the connection.",
  dns_failed: "The destination's name could not be found.",
  tls_failed: "The destination's HTTPS certificate was not accepted.",
  network_error: "The connection failed.",
  smtp_unavailable: "The mail server could not be reached.",
  email_not_configured: "Email is not set up on this server.",
  response_deleted: "The response was deleted before it was sent.",
  integration_disabled: "The integration was paused or removed before it was sent.",
  no_recipient: "The respondent didn't give an email address.",
  recipient_limit: "This address already received 5 confirmations today; more are not sent, so the form can't be used to flood an inbox.",
  hourly_limit: "This confirmation already sent 500 emails in the last hour.",
};

function errorText(code: string | null, status: number | null): string {
  if (!code) return "";
  if (ERRORS[code]) return ERRORS[code];
  if (code.startsWith("http_")) return `The destination answered ${status ?? code.slice(5)}.`;
  if (code.startsWith("smtp_")) return `The mail server answered ${code.slice(5)}.`;
  return code;
}

function statusText(d: Delivery): string {
  switch (d.status) {
    case "succeeded":
      return "Delivered";
    case "pending":
      return "Waiting to send";
    case "retrying":
      return `Retrying${d.nextAttemptAt ? ` at ${new Date(d.nextAttemptAt).toLocaleString()}` : ""}`;
    case "skipped":
      return "Not sent";
    case "failed":
      return "Failed permanently";
  }
}

function message(err: unknown): string {
  return err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.";
}

/**
 * A form's email notifications and signed webhooks (AUT-01): add, pause,
 * rotate secrets, remove, and follow every delivery and attempt, with a
 * clear permanent-failure state and a way to send a failed one again.
 */
export function IntegrationsPanel({ orgId, formId }: { orgId: string; formId: string }) {
  const formPath = `/api/v1/organizations/${orgId}/forms/${formId}`;
  const orgPath = `/api/v1/organizations/${orgId}`;
  const [items, setItems] = useState<Integration[] | undefined>();
  const [fields, setFields] = useState<Array<{ id: string; label: string; type: string; privacy?: string }>>([]);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const [secret, setSecret] = useState<{ name: string; value: string } | undefined>();

  const reload = useCallback(() => {
    return api<{ items: Integration[] }>(`${formPath}/integrations`)
      .then((r) => setItems(r.items))
      .catch((err: unknown) => setError(message(err)));
  }, [formPath]);

  useEffect(() => {
    void reload();
    api<{ definition: { fields: Array<{ id: string; label: string; type: string; privacy?: string }> } }>(`${formPath}/draft`)
      // Headings and descriptions take no answer, so there is nothing to send.
      .then((d) => setFields(d.definition.fields.filter((f) => f.type !== "section" && f.type !== "description")))
      .catch(() => undefined);
  }, [formPath, reload]);

  async function act(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown, done: string) {
    setNotice("");
    try {
      const res = await api<{ secret?: string; integration?: Integration }>(path, { method, body });
      if (res.secret && res.integration) setSecret({ name: res.integration.name, value: res.secret });
      setNotice(done);
      await reload();
    } catch (err) {
      setNotice(message(err));
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 22, margin: "0 0 8px" }}>Notifications and webhooks</h2>
      <p style={{ color: "var(--we-color-textMuted)", marginTop: 0 }}>
        Each new response is sent to every active destination below. Failed sends are retried for about a day, and every attempt is listed.
      </p>
      <p role="status">{notice}</p>
      {error && <p role="alert">{error}</p>}
      {secret && (
        <div role="alert" style={{ border: "1px solid var(--we-color-border)", padding: 12, borderRadius: 8 }}>
          <p style={{ marginTop: 0 }}>
            Signing secret for <strong>{secret.name}</strong>. Copy it now: it won&apos;t be shown again.
          </p>
          <code style={{ overflowWrap: "anywhere" }}>{secret.value}</code>
          <p style={{ marginBottom: 0 }}>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(secret.value)}>
              Copy
            </button>{" "}
            <button type="button" onClick={() => setSecret(undefined)}>
              I&apos;ve saved it
            </button>
          </p>
        </div>
      )}
      {items?.length === 0 && <p>No destinations yet.</p>}
      {items?.map((i) => (
        <IntegrationCard key={i.id} integration={i} orgPath={orgPath} act={act} fields={fields} />
      ))}
      <AddWebhook formPath={formPath} fields={fields} act={act} />
      <AddEmail formPath={formPath} act={act} />
      <AddConfirmation formPath={formPath} emailFields={fields.filter((f) => f.type === "email")} act={act} />
    </div>
  );
}

type Act = (path: string, method: "POST" | "PATCH" | "DELETE", body: unknown, done: string) => Promise<void>;

const KIND_NAMES: Record<Integration["kind"], string> = { webhook: "Webhook", email: "Email", confirmation: "Confirmation to respondent" };

function IntegrationCard({ integration: i, orgPath, act, fields }: { integration: Integration; orgPath: string; act: Act; fields: Array<{ id: string; label: string }> }) {
  const [open, setOpen] = useState(false);
  const path = `${orgPath}/integrations/${i.id}`;
  return (
    <section style={{ border: "1px solid var(--we-color-border)", borderRadius: 8, padding: 12, margin: "12px 0" }} aria-label={i.name}>
      <h2 style={{ fontSize: 18, margin: 0 }}>
        {i.name} <span style={{ color: "var(--we-color-textMuted)", fontSize: 14 }}>({KIND_NAMES[i.kind]}{i.enabled ? "" : ", paused"})</span>
      </h2>
      <p style={{ overflowWrap: "anywhere", margin: "4px 0" }}>
        {i.kind === "webhook"
          ? i.url
          : i.kind === "confirmation"
            ? `"${i.subject ?? ""}" to the address given in "${fields.find((f) => f.id === i.recipientFieldId)?.label ?? i.recipientFieldId}"`
            : `To ${(i.recipients ?? []).join(", ")}`}
        {i.kind === "webhook" && <span style={{ color: "var(--we-color-textMuted)" }}> · {i.fieldIds.length === 0 ? "identifiers only" : `${i.fieldIds.length} answers included`}</span>}
      </p>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
        <button type="button" onClick={() => void act(path, "PATCH", { enabled: !i.enabled }, i.enabled ? `Paused ${i.name}.` : `Resumed ${i.name}.`)}>
          {i.enabled ? "Pause" : "Resume"}
        </button>
        {i.kind === "webhook" && (
          <button type="button" onClick={() => void act(`${path}/rotate-secret`, "POST", undefined, "New signing secret created. The old one keeps working for 24 hours.")}>
            New signing secret
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Remove "${i.name}"? Responses not yet sent to it won't be sent.`)) void act(path, "DELETE", undefined, `Removed ${i.name}.`);
          }}
        >
          Remove
        </button>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide deliveries" : "Show deliveries"}
        </button>
      </p>
      {open && <Deliveries orgPath={orgPath} integrationId={i.id} />}
    </section>
  );
}

function Deliveries({ orgPath, integrationId }: { orgPath: string; integrationId: string }) {
  const [items, setItems] = useState<Delivery[] | undefined>();
  const [attempts, setAttempts] = useState<Record<string, Attempt[]>>({});
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<{ items: Delivery[] }>(`${orgPath}/integrations/${integrationId}/deliveries?limit=50`)
        .then((r) => setItems(r.items))
        .catch(() => setItems([])),
    [orgPath, integrationId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function showAttempts(id: string) {
    const r = await api<{ attempts: Attempt[] }>(`${orgPath}/deliveries/${id}`);
    setAttempts((prev) => ({ ...prev, [id]: r.attempts }));
  }
  async function retry(id: string) {
    try {
      await api(`${orgPath}/deliveries/${id}/retry`, { method: "POST" });
      setNotice("Queued to send again.");
      await load();
    } catch (err) {
      setNotice(message(err));
    }
  }

  if (!items) return <p>Loading…</p>;
  if (items.length === 0) return <p>Nothing sent yet.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <p role="status">{notice}</p>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th scope="col" style={{ padding: 6 }}>Response received</th>
            <th scope="col" style={{ padding: 6 }}>Status</th>
            <th scope="col" style={{ padding: 6 }}>Attempts</th>
            <th scope="col" style={{ padding: 6 }}>Last problem</th>
            <th scope="col" style={{ padding: 6 }} aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id} style={{ borderTop: "1px solid var(--we-color-border)", verticalAlign: "top" }}>
              <td style={{ padding: 6, whiteSpace: "nowrap" }}>{new Date(d.createdAt).toLocaleString()}</td>
              <td style={{ padding: 6 }}>
                <strong style={d.status === "failed" ? { color: "var(--we-color-danger, #b42318)" } : undefined}>{statusText(d)}</strong>
                {d.ambiguous && <div style={{ fontSize: 12 }}>A timed-out attempt may have arrived; the destination can recognize repeats by event ID.</div>}
              </td>
              <td style={{ padding: 6 }}>
                {d.attempts}{" "}
                <button type="button" onClick={() => void showAttempts(d.id)} aria-label={`Show attempts for the delivery of ${new Date(d.createdAt).toLocaleString()}`}>
                  Details
                </button>
                {attempts[d.id] && (
                  <ol style={{ margin: "4px 0", paddingLeft: 18 }}>
                    {attempts[d.id]!.map((a) => (
                      <li key={a.attempt}>
                        {new Date(a.startedAt).toLocaleTimeString()}: {a.outcome}
                        {a.statusCode ? ` (${a.statusCode})` : ""}
                        {a.errorCode ? `, ${errorText(a.errorCode, a.statusCode)}` : ""} · {a.durationMs} ms
                      </li>
                    ))}
                  </ol>
                )}
              </td>
              <td style={{ padding: 6 }}>{errorText(d.lastError, d.lastStatusCode)}</td>
              <td style={{ padding: 6 }}>
                {d.status === "failed" && (
                  <button type="button" onClick={() => void retry(d.id)}>
                    Send again
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddWebhook({ formPath, fields, act }: { formPath: string; fields: Array<{ id: string; label: string; privacy?: string }>; act: Act }) {
  const ids = { name: useId(), url: useId() };
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <form
      style={{ border: "1px solid var(--we-color-border)", borderRadius: 8, padding: 12, margin: "12px 0", display: "grid", gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        void act(`${formPath}/integrations`, "POST", { kind: "webhook", name, url, fieldIds: chosen }, `Added ${name}.`).then(() => {
          setName("");
          setUrl("");
          setChosen([]);
        });
      }}
    >
      <h2 style={{ fontSize: 18, margin: 0 }}>Add a webhook</h2>
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      <label htmlFor={ids.url}>HTTPS URL</label>
      <input id={ids.url} type="url" value={url} onChange={(e) => setUrl(e.target.value)} required maxLength={2000} placeholder="https://example.com/hooks/workeasy" />
      <fieldset>
        <legend>Answers to include (others are never sent)</legend>
        {fields.map((f) => (
          <label key={f.id} style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={chosen.includes(f.id)}
              onChange={(e) => setChosen(e.target.checked ? [...chosen, f.id] : chosen.filter((x) => x !== f.id))}
            />{" "}
            {f.label}
            {f.privacy && f.privacy !== "ordinary" ? ` (${f.privacy})` : ""}
          </label>
        ))}
      </fieldset>
      <p style={{ margin: 0 }}>
        <button type="submit" disabled={!name.trim() || !url.trim()}>
          Add webhook
        </button>
      </p>
    </form>
  );
}

function AddEmail({ formPath, act }: { formPath: string; act: Act }) {
  const ids = { name: useId(), to: useId() };
  const [name, setName] = useState("");
  const [to, setTo] = useState("");
  const recipients = to
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return (
    <form
      style={{ border: "1px solid var(--we-color-border)", borderRadius: 8, padding: 12, margin: "12px 0", display: "grid", gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        void act(`${formPath}/integrations`, "POST", { kind: "email", name, recipients }, `Added ${name}.`).then(() => {
          setName("");
          setTo("");
        });
      }}
    >
      <h2 style={{ fontSize: 18, margin: 0 }}>Add an email notification</h2>
      <p style={{ margin: 0, color: "var(--we-color-textMuted)" }}>Emails link to the response; answers stay in Workeasy.</p>
      <label htmlFor={ids.name}>Name</label>
      <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      <label htmlFor={ids.to}>Send to (up to 10 addresses)</label>
      <textarea id={ids.to} rows={2} value={to} onChange={(e) => setTo(e.target.value)} required />
      <p style={{ margin: 0 }}>
        <button type="submit" disabled={!name.trim() || recipients.length === 0 || recipients.length > 10}>
          Add email notification
        </button>
      </p>
    </form>
  );
}

/**
 * Confirmation email to respondents (PAR-06): your own subject and message,
 * sent to the address each respondent gives in an email question.
 */
function AddConfirmation({ formPath, emailFields, act }: { formPath: string; emailFields: Array<{ id: string; label: string }>; act: Act }) {
  const ids = { name: useId(), field: useId(), subject: useId(), message: useId() };
  const [name, setName] = useState("Confirmation email");
  const [fieldId, setFieldId] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const chosen = fieldId || emailFields[0]?.id || "";
  return (
    <form
      style={{ border: "1px solid var(--we-color-border)", borderRadius: 8, padding: 12, margin: "12px 0", display: "grid", gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        void act(`${formPath}/integrations`, "POST", { kind: "confirmation", name, recipientFieldId: chosen, subject, message: text }, `Added ${name}.`).then(() => {
          setSubject("");
          setText("");
        });
      }}
    >
      <h2 style={{ fontSize: 18, margin: 0 }}>Add a confirmation email to respondents</h2>
      <p style={{ margin: 0, color: "var(--we-color-textMuted)" }}>
        Sends your message to the address each respondent gives. Their answers are not included. An address gets at most 5 confirmations a day.
      </p>
      {emailFields.length === 0 ? (
        <p style={{ margin: 0 }}>Add an email address question to the form first.</p>
      ) : (
        <>
          <label htmlFor={ids.name}>Name</label>
          <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          <label htmlFor={ids.field}>Send to the address given in</label>
          <select id={ids.field} value={chosen} onChange={(e) => setFieldId(e.target.value)}>
            {emailFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <label htmlFor={ids.subject}>Subject</label>
          <input id={ids.subject} value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={150} />
          <label htmlFor={ids.message}>Message</label>
          <textarea id={ids.message} rows={4} value={text} onChange={(e) => setText(e.target.value)} required maxLength={4000} />
          <p style={{ margin: 0 }}>
            <button type="submit" disabled={!name.trim() || !chosen || !subject.trim() || !text.trim()}>
              Add confirmation email
            </button>
          </p>
        </>
      )}
    </form>
  );
}
