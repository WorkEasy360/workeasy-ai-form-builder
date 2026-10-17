"use client";

import { diffDefinitions } from "@workeasy/builder";
import type { FormDefinition } from "@workeasy/form-schema";
import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError } from "../../../../../../lib/api";
import { describeChange } from "./conflict-panel";

type Status = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface Generation {
  id: string;
  status: Status;
  operation: "create" | "edit";
  baseRevision: number;
  proposal: FormDefinition | null;
  summary: { warnings?: string[]; removedFieldIds?: string[]; addedFieldIds?: string[]; typeChangedFieldIds?: string[] } | null;
  failureCode: string | null;
  decision: { kind: "applied" | "rejected"; appliedRevision: number | null } | null;
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
 * Ask AI for a proposal (AI-01) and decide on it (AI-02). The request goes
 * against the saved draft; the proposal is shown as changes to the current
 * draft. Applying saves it as the next draft revision (undoable, never
 * published) only if nobody saved the draft in the meantime; rejecting
 * leaves the draft alone. If AI is unavailable the builder works as before.
 */
export function AiPanel({
  initialJobId,
  formPath,
  definition,
  readOnly,
  saveForPublish,
  onApplied,
}: {
  /** A generation started elsewhere (the create page) to follow from the start. */
  initialJobId?: string;
  formPath: string;
  /** The draft as the editor has it now. */
  definition: FormDefinition;
  readOnly: boolean;
  saveForPublish: () => Promise<number | undefined>;
  onApplied: (definition: FormDefinition, revision: number) => void;
}) {
  const hasFields = definition.fields.length > 0;
  const ids = { prompt: useId(), heading: useId() };
  const [prompt, setPrompt] = useState("");
  const [operation, setOperation] = useState<"create" | "edit">(hasFields ? "edit" : "create");
  const [generation, setGeneration] = useState<Generation | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  // Generations live under the organization, not the form.
  const jobsPath = `${formPath.replace(/\/forms\/[^/]+$/, "")}/ai-jobs`;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Follow a generation that was started before the builder opened.
  useEffect(() => {
    if (!initialJobId) return;
    let cancelled = false;
    api<{ job: Generation }>(`${jobsPath}/${initialJobId}`)
      .then((r) => {
        if (!cancelled) setGeneration(r.job);
      })
      .catch(() => setError("The AI request couldn't be loaded. You can ask again below."));
    return () => {
      cancelled = true;
    };
  }, [initialJobId, jobsPath]);

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
    setStale(false);
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

  async function apply() {
    if (!generation?.proposal) return;
    setError(undefined);
    setBusy(true);
    try {
      const expectedRevision = await saveForPublish();
      if (expectedRevision === undefined) {
        setError("Save your changes first.");
        return;
      }
      const res = await api<{ job: Generation; draft: { revision: number } }>(`${jobsPath}/${generation.id}/apply`, {
        method: "POST",
        body: { expectedRevision },
      });
      setGeneration(res.job);
      onApplied(generation.proposal, res.draft.revision);
    } catch (err) {
      if (err instanceof ApiError && err.problem.code === "DRAFT_CONFLICT") setStale(true);
      else setError(err instanceof ApiError ? err.problem.title : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!generation) return;
    try {
      const res = await api<{ job: Generation }>(`${jobsPath}/${generation.id}/reject`, { method: "POST" });
      setGeneration(res.job);
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.title : "Something went wrong.");
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
      {generation?.status === "succeeded" && generation.proposal && <Proposal generation={generation} current={definition} />}
      {generation?.status === "succeeded" && generation.proposal && !generation.decision && (
        <div>
          {stale ? (
            <div role="alert" className="b-banner" data-kind="error">
              <p style={{ marginTop: 0 }}>The draft changed after this suggestion was made, so it wasn&apos;t applied. Nothing was overwritten.</p>
              <button type="button" className="b-btn" disabled={busy || prompt.trim().length < 3} onClick={() => void submit()}>
                Ask again with the current draft
              </button>
            </div>
          ) : (
            <p className="b-row" style={{ gap: 8 }}>
              <button type="button" className="b-btn b-primary" disabled={readOnly || busy} onClick={() => void apply()}>
                Apply to draft
              </button>
              <button type="button" className="b-btn" disabled={busy} onClick={() => void reject()}>
                Reject
              </button>
            </p>
          )}
          <p className="b-muted">Applying changes your draft only; respondents see it when you publish. You can undo it.</p>
        </div>
      )}
      {generation?.decision?.kind === "rejected" && <p>Rejected. Your draft is unchanged.</p>}
      {generation?.decision?.kind === "applied" && <p>Applied to your draft.</p>}
    </section>
  );
}

/** The proposal as changes to the current draft, with the AI's warnings. */
function Proposal({ generation, current }: { generation: Generation; current: FormDefinition }) {
  const proposal = generation.proposal!;
  const changes = diffDefinitions(current, proposal);
  const warnings = generation.summary?.warnings ?? [];
  return (
    <div>
      <h3>Suggested: {proposal.title}</h3>
      {warnings.length > 0 && (
        <ul>
          {warnings.map((w) => (
            <li key={w}>{WARNINGS[w] ?? w}</li>
          ))}
        </ul>
      )}
      <h4>Changes to your draft</h4>
      {changes.length === 0 ? (
        <p>No changes.</p>
      ) : (
        <ul>
          {changes.map((c) => (
            <li key={`${c.target}:${c.id}:${c.kind}`}>{describeChange(c)}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>All questions in the suggestion</summary>
        <ol>
          {proposal.fields.map((f) => (
            <li key={f.id}>
              {f.label}{" "}
              <span className="b-muted">
                ({f.type.replace("_", " ")}
                {f.required ? ", required" : ""})
              </span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
