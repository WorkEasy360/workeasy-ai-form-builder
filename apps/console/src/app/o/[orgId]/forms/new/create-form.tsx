"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { api, ApiError, type FormResponse } from "../../../../../lib/api";
import { BlankIcon, SparkleIcon, TemplateIcon } from "../../../../icons";
import { useOrg } from "../../org-shell";

interface Template {
  id: string;
  name: string;
  description: string;
  pages: number;
  fields: Array<{ label: string; type: string; required: boolean }>;
}

interface AiSettings {
  settings: { enabled: boolean };
  available: boolean;
}

type Start = "blank" | "template" | "ai";

const TYPE_NAMES: Record<string, string> = {
  text: "Short text",
  textarea: "Long text",
  email: "Email",
  phone: "Phone",
  url: "Website",
  integer: "Number",
  decimal: "Decimal",
  date: "Date",
  time: "Time",
  dropdown: "Dropdown",
  radio: "Single choice",
  multi_select: "Multiple choice",
  checkbox: "Checkbox",
  consent: "Consent",
  rating: "Rating",
  file: "File upload",
  name: "Name",
  address: "Address",
  date_time: "Date and time",
  slider: "Slider",
  section: "Section heading",
  description: "Description",
};

function problemText(err: unknown): string {
  return err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.";
}

/**
 * Creating a form (docs/01 §3 "Manual" and "AI" journeys): name it, then
 * start blank, from a template chosen in a gallery with previews, or by
 * describing it to AI. The new form opens in the builder; with AI, the
 * builder opens on the suggestion so it can be reviewed and applied.
 */
export function CreateForm({ orgId }: { orgId: string }) {
  const org = useOrg();
  const ids = { name: useId(), prompt: useId(), heading: useId() };
  const [name, setName] = useState("");
  const [start, setStart] = useState<Start>("blank");
  const [templates, setTemplates] = useState<Template[] | undefined>();
  const [template, setTemplate] = useState<string | undefined>();
  const [prompt, setPrompt] = useState("");
  const [ai, setAi] = useState<{ ready: boolean; reason?: string } | undefined>();
  const [error, setError] = useState<{ text: string; formId?: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const canCreate = org?.permissions.includes("forms.create") ?? true;

  useEffect(() => {
    api<{ templates: Template[] }>("/api/v1/form-templates")
      .then((r) => setTemplates(r.templates))
      .catch(() => setTemplates([]));
    api<AiSettings>(`/api/v1/organizations/${orgId}/ai-settings`)
      .then((s) =>
        setAi(
          !s.available
            ? { ready: false, reason: "AI isn't set up on this server." }
            : !s.settings.enabled
              ? { ready: false, reason: "AI is turned off for your organization. An owner can turn it on in AI settings." }
              : { ready: true },
        ),
      )
      .catch(() => setAi({ ready: false, reason: "AI settings couldn't be loaded." }));
  }, [orgId]);

  function chooseTemplate(t: Template) {
    setTemplate(t.id);
    if (!name.trim()) setName(t.name);
  }

  const chosenTemplate = templates?.find((t) => t.id === template);
  const ready = name.trim().length > 0 && (start !== "template" || !!template) && (start !== "ai" || (ai?.ready === true && prompt.trim().length >= 3));
  /** Why the create button is disabled, so it never is without saying why. */
  const missing = !name.trim()
    ? "Give the form a name first."
    : start === "template" && !template
      ? "Choose a template."
      : start === "ai" && ai === undefined
        ? "Checking whether AI is available…"
        : start === "ai" && ai?.ready === false
          ? (ai.reason ?? "AI isn't available.")
          : start === "ai" && prompt.trim().length < 3
            ? "Describe the form you want."
            : undefined;

  async function create() {
    setBusy(true);
    setError(undefined);
    let created: FormResponse | undefined;
    try {
      created = await api<FormResponse>(`/api/v1/organizations/${orgId}/forms`, {
        method: "POST",
        body: start === "template" && template ? { name: name.trim(), template } : { name: name.trim() },
      });
      const build = `/o/${orgId}/forms/${created.form.id}/build`;
      if (start !== "ai") {
        window.location.assign(build);
        return;
      }
      const job = await api<{ job: { id: string } }>(`/api/v1/organizations/${orgId}/forms/${created.form.id}/ai-jobs`, {
        method: "POST",
        body: { prompt: prompt.trim(), operation: "create", baseRevision: created.draft.revision },
      });
      window.location.assign(`${build}?ai=${encodeURIComponent(job.job.id)}`);
    } catch (err) {
      setError({ text: created ? `The form was created, but the AI request failed: ${problemText(err)}` : problemText(err), ...(created ? { formId: created.form.id } : {}) });
      setBusy(false);
    }
  }

  if (!canCreate) {
    return (
      <div className="c-page">
        <div className="c-empty">
          <h2>You can&apos;t create forms here</h2>
          <p>Ask an organization owner or admin for permission to create forms.</p>
          <a className="c-btn" href={`/o/${orgId}/forms`}>
            Back to forms
          </a>
        </div>
      </div>
    );
  }

  const options: Array<{ id: Start; title: string; text: string; icon: ReactNode; disabled?: boolean }> = [
    { id: "blank", title: "Blank form", text: "Start from an empty page and add questions yourself.", icon: <BlankIcon size={22} /> },
    { id: "template", title: "Template", text: "Pick a ready-made form and adjust it.", icon: <TemplateIcon size={22} /> },
    { id: "ai", title: "Describe it with AI", text: ai?.ready === false ? (ai.reason ?? "") : "Say what you need; AI suggests a form for you to review.", icon: <SparkleIcon size={22} /> },
  ];

  return (
    <div className="c-page" style={{ maxWidth: 960 }}>
      <p style={{ margin: "0 0 8px" }}>
        <a href={`/o/${orgId}/forms`}>← Forms</a>
      </p>
      <div className="c-page-head">
        <div>
          <h1>Create a form</h1>
          <p className="c-subtitle">Name it, choose how to start, and you&apos;ll go straight to the builder.</p>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void create();
        }}
        style={{ display: "grid", gap: 24 }}
      >
        <div className="c-field" style={{ maxWidth: 520 }}>
          <label className="c-label" htmlFor={ids.name}>
            Form name
          </label>
          <input id={ids.name} className="c-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required autoFocus placeholder="For example: Event registration" />
          <p className="c-hint">Respondents see this as the form&apos;s title. You can change it later.</p>
        </div>

        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="c-label" id={ids.heading} style={{ marginBottom: 8 }}>
            How do you want to start?
          </legend>
          <div className="c-grid" role="radiogroup" aria-labelledby={ids.heading}>
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={start === o.id}
                className="c-card c-choice"
                onClick={() => setStart(o.id)}
              >
                <span className="c-icon-tile">{o.icon}</span>
                <h2>{o.title}</h2>
                <p>{o.text}</p>
              </button>
            ))}
          </div>
        </fieldset>

        {start === "template" && (
          <section aria-label="Templates">
            {!templates && <p role="status">Loading templates…</p>}
            <div className="c-grid">
              {templates?.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={template === t.id}
                  className="c-card c-choice"
                  onClick={() => chooseTemplate(t)}
                  aria-label={`${t.name}: ${t.description}`}
                >
                  <h2>{t.name}</h2>
                  <p>{t.description}</p>
                  <p>
                    {t.fields.length} questions{t.pages > 1 ? ` · ${t.pages} pages` : ""}
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--we-color-textMuted)" }}>
                    {t.fields.slice(0, 4).map((f, i) => (
                      <li key={i}>
                        {f.label} <span style={{ opacity: 0.75 }}>· {TYPE_NAMES[f.type] ?? f.type}</span>
                        {f.required ? " *" : ""}
                      </li>
                    ))}
                    {t.fields.length > 4 && <li>and {t.fields.length - 4} more</li>}
                  </ul>
                </button>
              ))}
            </div>
            {chosenTemplate && (
              <p className="c-hint" style={{ marginTop: 8 }} role="status">
                Starting from “{chosenTemplate.name}”.
              </p>
            )}
          </section>
        )}

        {start === "ai" && (
          <div className="c-field" style={{ maxWidth: 720 }}>
            <label className="c-label" htmlFor={ids.prompt}>
              Describe the form
            </label>
            <textarea
              id={ids.prompt}
              className="c-textarea"
              rows={5}
              maxLength={8000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={ai?.ready === false}
              placeholder="For example: a registration form for a 5 km charity run, with T-shirt size, emergency contact and a waiver"
            />
            <p className="c-hint">
              {ai?.ready === false ? (
                <>
                  {ai.reason} {org?.permissions.includes("organization.manage") && <a href={`/o/${orgId}/ai`}>Open AI settings</a>}
                </>
              ) : (
                "The suggestion opens in the builder for you to review. Nothing is published until you publish it."
              )}
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="c-error">
            {error.text} {error.formId && <a href={`/o/${orgId}/forms/${error.formId}/build`}>Open the form</a>}
          </p>
        )}

        <div className="c-toolbar">
          <button type="submit" className="c-btn c-btn-primary" disabled={!ready || busy}>
            {busy ? "Creating…" : start === "ai" ? "Create and suggest" : "Create form"}
          </button>
          <a className="c-btn c-btn-ghost" href={`/o/${orgId}/forms`}>
            Cancel
          </a>
          {!busy && missing && (
            <span className="c-hint" role="status">
              {missing}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
