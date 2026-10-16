"use client";

import { useEffect, useId, useState } from "react";
import { api, ApiError } from "../../../../../../../lib/api";

type Masked = { masked: true } | { masked: false; value: unknown; display: string };

interface Detail {
  id: string;
  receiptNumber: string;
  receivedAt: string;
  version: { id: string; versionNumber: number; active: boolean };
  respondent: { kind: "anonymous" } | { kind: "member"; masked: true } | { kind: "member"; masked: false; userId: string; displayName: string | null };
  fields: Array<{
    fieldId: string;
    label: string;
    type: string;
    privacy: "ordinary" | "personal" | "sensitive";
    masked: boolean;
    answer: Masked;
    files?: Array<{ uploadId: string; fileName: string; bytes: number | null; contentType: string | null }>;
  }>;
}

const PRIVACY_TEXT = { ordinary: "", personal: "personal data", sensitive: "sensitive data" } as const;

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.problem.title : "Something went wrong.";
}

/** One response, with its own version's questions; hidden answers say why. */
export function ResponseDetail({ orgId, formId, submissionId }: { orgId: string; formId: string; submissionId: string }) {
  const base = `/api/v1/organizations/${orgId}/forms/${formId}/submissions/${submissionId}`;
  const [detail, setDetail] = useState<Detail | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [downloadError, setDownloadError] = useState<string | undefined>();
  const [canDelete, setCanDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState("");
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const reasonId = useId();

  useEffect(() => {
    let cancelled = false;
    api<{ form: { permissions: string[] } }>(`/api/v1/organizations/${orgId}/forms/${formId}`)
      .then((f) => {
        if (!cancelled) setCanDelete(f.form.permissions.includes("responses.delete"));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orgId, formId]);

  async function remove() {
    setDeleteError(undefined);
    try {
      await api(base, { method: "DELETE", body: { reason: reason.trim() } });
      window.location.assign(`/o/${orgId}/forms/${formId}/responses`);
    } catch (err) {
      setDeleteError(errorText(err));
    }
  }

  useEffect(() => {
    let cancelled = false;
    api<Detail>(base)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  async function download(uploadId: string) {
    setDownloadError(undefined);
    try {
      // Links last a minute, so each click asks for a fresh one (and rechecks access).
      const link = await api<{ url: string }>(`${base}/files/${uploadId}`);
      window.location.assign(link.url);
    } catch (err) {
      setDownloadError(errorText(err));
    }
  }

  return (
    <div>
      <p style={{ margin: 0 }}>
        <a href={`/o/${orgId}/forms/${formId}/responses`}>← All responses</a>
      </p>
      {error && <p role="alert">{error}</p>}
      {!detail && !error && <p role="status">Loading the response…</p>}
      {detail && (
        <>
          <h1 style={{ margin: "8px 0 4px", fontSize: 24 }}>Response {detail.receiptNumber}</h1>
          <p style={{ marginTop: 0, color: "var(--we-color-textMuted)" }}>
            Received <time dateTime={detail.receivedAt}>{new Date(detail.receivedAt).toLocaleString()}</time> · version {detail.version.versionNumber}
            {detail.version.active ? " (live)" : " (an earlier version; questions are shown as respondents saw them)"} ·{" "}
            {detail.respondent.kind === "anonymous"
              ? "anonymous respondent"
              : detail.respondent.masked
                ? "a signed-in member (hidden: personal data)"
                : `submitted by ${detail.respondent.displayName ?? "a member"}`}
          </p>
          {downloadError && <p role="alert">{downloadError}</p>}
          <dl style={{ display: "grid", gap: 16, margin: "16px 0" }}>
            {detail.fields.map((f) => (
              <div key={f.fieldId} style={{ borderBottom: "1px solid var(--we-color-border)", paddingBottom: 12 }}>
                <dt style={{ fontWeight: 600 }}>
                  {f.label}
                  {f.privacy !== "ordinary" && <span style={{ fontWeight: 400, color: "var(--we-color-textMuted)" }}> · {PRIVACY_TEXT[f.privacy]}</span>}
                </dt>
                <dd style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {f.answer.masked ? (
                    <em style={{ color: "var(--we-color-textMuted)" }}>Hidden: you don&apos;t have permission to see {PRIVACY_TEXT[f.privacy] || "this answer"}.</em>
                  ) : f.files && f.files.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: 20 }}>
                      {f.files.map((file) => (
                        <li key={file.uploadId}>
                          {file.fileName}{" "}
                          <button type="button" onClick={() => void download(file.uploadId)} aria-label={`Download ${file.fileName}`}>
                            Download
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : f.answer.display ? (
                    f.answer.display
                  ) : (
                    <span style={{ color: "var(--we-color-textMuted)" }}>Not answered</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {canDelete && (
            <section aria-labelledby={`${reasonId}-heading`} style={{ marginTop: 24 }}>
              <h2 id={`${reasonId}-heading`} style={{ fontSize: 18 }}>
                Delete this response
              </h2>
              {!deleting ? (
                <button type="button" onClick={() => setDeleting(true)}>
                  Delete response…
                </button>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void remove();
                  }}
                >
                  <p>It disappears at once; its answers and files are erased shortly afterwards, along with any exports that include it. This can&apos;t be undone.</p>
                  <label htmlFor={reasonId} style={{ display: "block", fontWeight: 600 }}>
                    Reason (kept with the deletion record)
                  </label>
                  <textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required minLength={3} style={{ width: "100%" }} />
                  <p>
                    <button type="submit" disabled={reason.trim().length < 3}>
                      Delete permanently
                    </button>{" "}
                    <button type="button" onClick={() => setDeleting(false)}>
                      Cancel
                    </button>
                  </p>
                  {deleteError && <p role="alert">{deleteError}</p>}
                </form>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
