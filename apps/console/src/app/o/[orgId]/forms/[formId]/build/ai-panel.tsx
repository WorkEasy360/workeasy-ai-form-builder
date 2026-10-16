"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError } from "../../../../../../lib/api";

type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface Generation {
  id: string;
  status: Status;
  operation: "create" | "edit";
  proposal: { title: string; fields: Array<{ id: string; type: string; label: string; required: boolean }>; pages: unknown[] } | null;
  summary: { warnings?: string[]; removedFieldIds?: string[]; addedFieldIds?: string[]; typeChangedFieldIds?: string[] } | null;
  failureCode: string | null;
}

const FAILURES: Record<string, string> = {
  invalid_output: "The AI didn't produce a valid form, even after a second try. Try rewording your request.",
  deadline_exceeded: "That took too long and was stopped. Try again, perhaps with a shorter request.",
  provider_unavailable: "The AI service is unavailable right now. Try again later; you can keep editing yourself.",
  provider_rate_limited: "The AI service is busy right now. Try again in a minute.",
  provider_timeout: "The AI service didn't answer in time. Try again later.",
  provider_unreachable: "The AI service couldn't be reached. Try again later.",
  provider_refused: "The AI service declined this request. Try rewording it.",
  output_truncated: "The form was too large for one answer. Ask for fewer questions.",
  ai_unavailable: "AI isn't set up for this workspace yet.",
};

const WARNINGS: Record<string, string> = {
  removes_fields: "Removes questions from your form.",
  changes_field_types: "Changes the type of some questions; existing answers may not fit.",
  review_consent_wording: "Has consent questions: check the wording yourself; it is not legal advice.",
  review_file_settings: "Has file uploads: check the allowed file types and sizes.",
};

const ACTIVE: Status[] = ["queued", "running"];

/**
 * Ask AI for a proposal (AI-01). The request goes against the saved draft;
 * the result is a validated proposal shown here for review. Nothing changes
 * the draft, and if AI is unavailable the builder works as before.
 */
export function AiPanel({
  formPath,
  hasFields,
  readOnly,
  saveForPublish,
}: {
  formPath: string;
  hasFields: boolean;
  readOnly: boolean;
  saveForPublish: () => Promise<number | undefined>;
}) {
  const ids = { prompt: useId(), heading: useId() };
  const [prompt, setPrompt] = useState("");
  const [operation, setOperation] = useState<"create" | "edit">(hasFields ? "edit" : "create");
  const [generation, setGeneration] = useState<Generation | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // Generations live under the organization, not the form.
  const jobsPath = `${formPath.replace(/\/forms\/[^/]+$/, "")}/ai-jobs`;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Poll an active generation until it ends.
  useEffect(() => {
    if (!generation || !ACTIVE.includes(generation.status)) return;
    timer.current = setTimeout(() => {
      api<{ job: Generation }>(`${jobsPath}/${generation.id}`)
        .then((r) => setGeneration(r.job))
        .catch(() => setError("Lost track of the AI request. Reload to check on it."));
    }, 1500);
    return () => clearTimeout(timer.current);
  }, [generation, jobsPath]);

  async function submit() {
    setError(undefined);
    setBusy(true);
    try {
      const baseRevision = await saveForPublish();
      if (baseRevision === undefined) {
        setError("Save your changes first; the AI works from the saved draft.");
        return;
      }
      const res = await api<{ job: Generation }>(`${formPath}/ai-jobs`, { method: "POST", body: { prompt: prompt.trim(), operation, baseRevision } });
      setGeneration(res.job);
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!generation) return;
    const res = await api<{ job: Generation }>(`${jobsPath}/${generation.id}/cancel`, { method: "POST" });
    setGeneration(res.job);
  }

  const active = generation && ACTIVE.includes(generation.status);
  return (
    <section className="b-panel" aria-labelledby={ids.heading} style={{ maxWidth: 760, margin: "0 auto" }}>
      <h2 id={ids.heading}>Ask AI</h2>
      <p className="b-muted" style={{ marginTop: 0 }}>
        Describe the form you want. The AI suggests a form for you to review; it never changes your draft or publishes anything.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="b-field">
          <label htmlFor={ids.prompt}>What should the form do?</label>
          <textarea
            id={ids.prompt}
            rows={4}
            maxLength={8000}
            value={prompt}
            disabled={readOnly || busy || active}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="For example: a sign-up form for a charity run, with T-shirt size and emergency contact"
          />
        </div>
        <fieldset className="b-field" disabled={readOnly || busy || active}>
          <legend>Start from</legend>
          <label>
            <input type="radio" name="ai-operation" checked={operation === "create"} onChange={() => setOperation("create")} /> A new form (replaces everything)
          </label>
          <label>
            <input type="radio" name="ai-operation" checked={operation === "edit"} disabled={!hasFields} onChange={() => setOperation("edit")} /> This form (changes what is there)
          </label>
        </fieldset>
        <p className="b-row" style={{ gap: 8 }}>
          <button type="submit" className="b-btn b-primary" disabled={readOnly || busy || active || prompt.trim().length < 3}>
            Suggest a form
          </button>
          {active && (
            <button type="button" className="b-btn" onClick={() => void cancel()}>
              Cancel
            </button>
          )}
        </p>
      </form>
      {error && (
        <p role="alert" className="b-inline-error">
          {error}
        </p>
      )}
      <div role="status" aria-live="polite">
        {active && <p>Working on it… this usually takes under a minute.</p>}
        {generation?.status === "cancelled" && <p>Cancelled.</p>}
        {generation?.status === "failed" && <p>{FAILURES[generation.failureCode ?? ""] ?? "The AI request failed. Try again later."}</p>}
      </div>
      {generation?.status === "succeeded" && generation.proposal && (
        <div>
          <h3>Suggested: {generation.proposal.title}</h3>
          {(generation.summary?.warnings ?? []).length > 0 && (
            <ul>
              {generation.summary!.warnings!.map((w) => (
                <li key={w}>{WARNINGS[w] ?? w}</li>
              ))}
            </ul>
          )}
          <ol>
            {generation.proposal.fields.map((f) => (
              <li key={f.id}>
                {f.label} <span className="b-muted">({f.type.replace("_", " ")}{f.required ? ", required" : ""})</span>
              </li>
            ))}
          </ol>
          <p className="b-muted">Review the suggestion above. Applying it to your draft isn&apos;t available yet; you can build it yourself in the editor.</p>
        </div>
      )}
    </section>
  );
}
