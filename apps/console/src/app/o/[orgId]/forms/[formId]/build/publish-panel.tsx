"use client";

import { diffDefinitions } from "@workeasy/builder";
import type { DefinitionIssue, FormDefinition } from "@workeasy/form-schema";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type FormSummary, type PublishResponse, type VersionSummary } from "../../../../../../lib/api";
import { describeChange } from "./conflict-panel";
import { PreviewPane } from "./preview";

interface Checklist {
  revision: number;
  publishable: boolean;
  issues: DefinitionIssue[];
  warnings: Array<{ code: string; message: string }>;
}

type Check = { kind: "checking" } | { kind: "ready"; result: Checklist } | { kind: "failed"; message: string };

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.problem.title : "Something went wrong.";
}

function issueText(issue: DefinitionIssue): string {
  return issue.code === "SCHEMA_MINITEMS" && issue.path === "/fields" ? "Add at least one question." : issue.message;
}

/**
 * Publishing (docs/01 §3 "see publish checklist → publish immutable
 * version"): the same checks the server runs, what changed since the live
 * version, the publish action itself, and the version history with rollback.
 */
export function PublishPanel({
  formPath,
  form,
  definition,
  live,
  readOnly,
  saveForPublish,
  onFormChange,
  announce,
}: {
  formPath: string;
  form: FormSummary;
  definition: FormDefinition;
  /** The live version's definition, once loaded. */
  live: { id: string; definition: FormDefinition } | undefined;
  readOnly: boolean;
  saveForPublish: () => Promise<number | undefined>;
  onFormChange: (form: FormSummary) => void;
  announce: (message: string) => void;
}) {
  const canPublish = form.permissions.includes("forms.publish") && !readOnly;
  const [check, setCheck] = useState<Check>({ kind: "checking" });
  const [versions, setVersions] = useState<VersionSummary[] | undefined>();
  const [historyError, setHistoryError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string; errors?: string[] } | undefined>();
  const [previewing, setPreviewing] = useState<{ version: VersionSummary; definition: FormDefinition } | undefined>();
  // One key per publish attempt of a revision, so a retried click cannot publish twice.
  const attempt = useRef<{ revision: number; key: string } | undefined>(undefined);
  const resultRef = useRef<HTMLDivElement>(null);

  /** Saves pending edits, then asks the server for the checklist. */
  const fetchCheck = useCallback(async (): Promise<Check> => {
    const revision = await saveForPublish();
    if (revision === undefined) {
      return { kind: "failed", message: "Your latest changes aren't saved yet, so they can't be checked. Resolve the save problem shown above and check again." };
    }
    try {
      return { kind: "ready", result: await api<Checklist>(`${formPath}/validate`, { method: "POST" }) };
    } catch (err) {
      return { kind: "failed", message: errorText(err) };
    }
  }, [formPath, saveForPublish]);

  const fetchHistory = useCallback(async (): Promise<{ items?: VersionSummary[]; error?: string }> => {
    try {
      return { items: (await api<{ items: VersionSummary[] }>(`${formPath}/versions`)).items };
    } catch (err) {
      return { error: errorText(err) };
    }
  }, [formPath]);

  function showHistory(history: { items?: VersionSummary[]; error?: string }) {
    if (history.items) setVersions(history.items);
    setHistoryError(history.error);
  }

  // Initial load when the panel opens.
  useEffect(() => {
    let cancelled = false;
    void fetchCheck().then((c) => {
      if (!cancelled) setCheck(c);
    });
    void fetchHistory().then((h) => {
      if (cancelled) return;
      if (h.items) setVersions(h.items);
      setHistoryError(h.error);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchCheck, fetchHistory]);

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  const activeVersion = versions?.find((v) => v.active);
  const nextNumber = (versions?.[0]?.versionNumber ?? 0) + 1;
  const changes = live && live.id === form.activeVersionId ? diffDefinitions(live.definition, definition) : undefined;

  async function recheck() {
    setCheck({ kind: "checking" });
    setCheck(await fetchCheck());
  }

  async function loadHistory() {
    showHistory(await fetchHistory());
  }

  async function publish() {
    setBusy(true);
    setResult(undefined);
    try {
      const revision = await saveForPublish();
      if (revision === undefined) {
        setResult({ kind: "error", text: "Your latest changes couldn't be saved, so nothing was published." });
        return;
      }
      if (attempt.current?.revision !== revision) attempt.current = { revision, key: crypto.randomUUID() };
      const published = await api<PublishResponse>(`${formPath}/publish`, {
        method: "POST",
        headers: { "If-Match": `"draft-${revision}"`, "Idempotency-Key": attempt.current.key },
      });
      attempt.current = undefined;
      onFormChange(published.form);
      setResult({
        kind: "ok",
        text:
          published.form.state === "closed"
            ? `Version ${published.version.versionNumber} is saved as the live version. The form is closed, so respondents can't submit until it is reopened.`
            : `Version ${published.version.versionNumber} is live. New respondents get it from now on.`,
      });
      announce(`Published version ${published.version.versionNumber}.`);
      await Promise.all([loadHistory(), recheck()]);
    } catch (err) {
      const problem = err instanceof ApiError ? err.problem : undefined;
      if (problem?.code === "DRAFT_CONFLICT") {
        attempt.current = undefined;
        setResult({ kind: "error", text: "The draft changed while you were publishing (perhaps someone else edited it). Check the draft again before publishing." });
        void recheck();
      } else if (problem?.code === "NOT_PUBLISHABLE") {
        setResult({ kind: "error", text: problem.title, errors: problem.errors?.map((e) => e.message) ?? [] });
      } else {
        // Network or server failure: the same key is reused on retry, so it can't publish twice.
        setResult({ kind: "error", text: `${errorText(err)} Nothing was published twice; you can try again.` });
      }
    } finally {
      setBusy(false);
    }
  }

  async function makeLive(version: VersionSummary) {
    const ok = window.confirm(
      `Make version ${version.versionNumber} live?\n\nNew respondents will get version ${version.versionNumber}. People already filling in the form keep the version they started with. Your draft doesn't change.`,
    );
    if (!ok) return;
    setBusy(true);
    setResult(undefined);
    try {
      const activated = await api<PublishResponse>(`${formPath}/activate-version`, { method: "POST", body: { versionId: version.id } });
      onFormChange(activated.form);
      setResult({ kind: "ok", text: `Version ${version.versionNumber} is live again.` });
      announce(`Version ${version.versionNumber} is live.`);
      await Promise.all([loadHistory(), recheck()]);
    } catch (err) {
      setResult({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function preview(version: VersionSummary) {
    try {
      const loaded = await api<{ definition: FormDefinition }>(`${formPath}/versions/${version.id}`);
      setPreviewing({ version, definition: loaded.definition });
    } catch (err) {
      setResult({ kind: "error", text: errorText(err) });
    }
  }

  const checklist = check.kind === "ready" ? check.result : undefined;
  const publishDisabled = !canPublish || busy || check.kind !== "ready" || !checklist?.publishable;

  return (
    <div className="b-publish">
      <section aria-labelledby="publish-heading">
        <h2 id="publish-heading">Publish</h2>
        <p style={{ marginTop: 0 }}>
          {activeVersion
            ? `Version ${activeVersion.versionNumber} is live${form.state === "closed" ? " (form closed)" : ""}. Publishing saves the current draft as version ${nextNumber} and makes it live; earlier versions stay available.`
            : "This form hasn't been published yet. Publishing saves the current draft as version 1, which can't be changed afterwards."}
        </p>

        <h3>Checklist</h3>
        <div role="status" aria-live="polite">
          {check.kind === "checking" && <p className="b-muted">Checking the draft…</p>}
          {check.kind === "failed" && <p className="b-inline-error">{check.message}</p>}
          {checklist && (
            <>
              {checklist.publishable ? (
                <p className="b-ok">✓ The draft passes every check.</p>
              ) : (
                <>
                  <p className="b-inline-error">Fix {checklist.issues.length === 1 ? "this problem" : `these ${checklist.issues.length} problems`} before publishing:</p>
                  <ul className="b-issues">
                    {checklist.issues.map((i) => (
                      <li key={`${i.path}:${i.code}`}>{issueText(i)}</li>
                    ))}
                  </ul>
                </>
              )}
              {checklist.warnings.map((w) => (
                <p key={w.code} className="b-muted">
                  Note: {w.message}
                </p>
              ))}
            </>
          )}
        </div>

        {changes && activeVersion && (
          <>
            <h3>Changes since version {activeVersion.versionNumber}</h3>
            {changes.length === 0 ? (
              <p className="b-muted">None.</p>
            ) : (
              <ul className="b-issues">
                {changes.map((c) => (
                  <li key={`${c.target}:${c.id}:${c.kind}`}>{describeChange(c)}</li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="b-row" style={{ flexWrap: "wrap", gap: 8, marginTop: 16 }}>
          <button type="button" className="b-btn b-primary" disabled={publishDisabled} onClick={() => void publish()}>
            {busy ? "Working…" : `Publish version ${nextNumber}`}
          </button>
          <button type="button" className="b-btn" disabled={busy} onClick={() => void recheck()}>
            Check again
          </button>
        </div>
        {!canPublish && (
          <p className="b-muted">{readOnly ? "Restore the form from the forms list to publish it." : "You can check this form, but publishing needs the publish permission on it."}</p>
        )}
        {result && (
          <div ref={resultRef} tabIndex={-1} role={result.kind === "error" ? "alert" : "status"} className="b-result" data-kind={result.kind}>
            <p style={{ margin: 0 }}>{result.text}</p>
            {result.errors && result.errors.length > 0 && (
              <ul className="b-issues">
                {result.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="history-heading">
        <h2 id="history-heading">Version history</h2>
        {historyError && <p role="alert" className="b-inline-error">{historyError}</p>}
        {versions === undefined && !historyError && <p className="b-muted">Loading versions…</p>}
        {versions?.length === 0 && <p className="b-muted">No versions yet. Each publication adds one here.</p>}
        {versions && versions.length > 0 && (
          <ol className="b-versions" reversed>
            {versions.map((v) => (
              <li key={v.id} data-active={v.active ? "true" : undefined}>
                <div>
                  <strong>Version {v.versionNumber}</strong>
                  {v.active && <span className="b-live"> Live</span>}
                  <br />
                  <span className="b-muted">
                    Published {DATE_FORMAT.format(new Date(v.publishedAt))} by {v.publishedBy.displayName ?? "a former member"}
                  </span>
                </div>
                <div className="b-row" style={{ gap: 4 }}>
                  <button type="button" className="b-btn" aria-label={`Preview version ${v.versionNumber}`} onClick={() => void preview(v)}>
                    Preview
                  </button>
                  {!v.active && (
                    <button type="button" className="b-btn" disabled={!canPublish || busy} aria-label={`Make version ${v.versionNumber} live`} onClick={() => void makeLive(v)}>
                      Make live
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        {previewing && (
          <div style={{ marginTop: 16 }}>
            <div className="b-row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>Version {previewing.version.versionNumber} as respondents saw it</h3>
              <button type="button" className="b-btn" onClick={() => setPreviewing(undefined)}>
                Close preview
              </button>
            </div>
            <PreviewPane key={previewing.version.id} definition={previewing.definition} />
          </div>
        )}
      </section>
    </div>
  );
}
