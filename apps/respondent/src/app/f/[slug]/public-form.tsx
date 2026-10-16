"use client";

import { canonicalJson, type AnswerValue } from "@workeasy/form-engine";
import { FormRenderer, RENDERER_CSS } from "@workeasy/form-renderer";
import type { FormDefinition } from "@workeasy/form-schema";
import { useEffect, useRef, useState } from "react";

/** Message an embedded form sends its host page. It carries a height and nothing else (docs/06 §3). */
const HEIGHT_MESSAGE = "workeasy:form-height";

interface Session {
  sessionId: string;
  /** Kept in memory only (docs/05 §3); a reload starts a new session. */
  capability: string;
  versionId: string;
  definition: FormDefinition;
}

interface Receipt {
  submissionId: string;
  receiptId: string;
  receivedAt: string;
}

type SessionState = { kind: "starting" } | { kind: "ready"; session: Session } | { kind: "failed"; message: string };

async function startSession(slug: string, embed: boolean): Promise<SessionState> {
  let res: Response;
  try {
    res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}/sessions${embed ? "?embed=1" : ""}`, { method: "POST", cache: "no-store" });
  } catch {
    return { kind: "failed", message: "We couldn't reach Workeasy Forms. Check your connection and reload the page." };
  }
  if (res.status === 201) return { kind: "ready", session: (await res.json()) as Session };
  if (res.status === 410) return { kind: "failed", message: (await isFull(res)) ? "This form is full and isn't accepting more responses." : "This form has closed and isn't accepting responses any more." };
  if (res.status === 409) return { kind: "failed", message: "This form isn't open yet. Reload the page when it opens." };
  if (res.status === 429) return { kind: "failed", message: "This form can't take responses right now. Please try again later." };
  if (res.status === 401) return { kind: "failed", message: "Your sign-in has ended. Reload the page to sign in again." };
  if (res.status === 403) return { kind: "failed", message: "You don't have access to this form." };
  return { kind: "failed", message: "Something went wrong. Please reload the page." };
}

async function isFull(res: Response): Promise<boolean> {
  const problem = (await res.json().catch(() => ({}))) as { code?: string };
  return problem.code === "FORM_FULL";
}

/** Problem messages for refusals; the respondent's answers always stay on screen. */
function refusal(status: number, body: { code?: string; errors?: Array<{ message: string }> }): string {
  if (status === 410 && body.code === "FORM_FULL") return "Sorry, this form filled up before your answers arrived. They weren't sent.";
  if (status === 410) return "This form has closed and isn't accepting responses any more. Your answers weren't sent.";
  if (status === 409 && body.code === "FORM_NOT_OPEN") return "This form isn't open yet. Your answers weren't sent; try again when it opens.";
  if (status === 429 && body.code === "RESPONSE_QUOTA_REACHED") return "This form can't take more responses right now. Your answers weren't sent; please try again later.";
  if (status === 401) return "This form session has expired. Copy anything you need, then reload the page to start again; your answers weren't sent.";
  if (status === 403) return "You no longer have access to this form. Your answers weren't sent.";
  if (status === 404) return "This form is no longer available. Your answers weren't sent.";
  if (status === 409) return "This form changed after you opened it. Reload the page to continue; your answers weren't sent.";
  if (status === 413) return "Your answers are too long to send. Shorten them and try again.";
  if (status === 422) return `Some answers need attention: ${(body.errors ?? []).map((e) => e.message).join(" ") || "please check them."}`;
  if (status === 429) return "Too many attempts. Wait a moment and try again; your answers are still here.";
  return "Something went wrong. Please try again; your answers are still here.";
}

export function PublicForm({ slug, versionId, definition, embed }: { slug: string; versionId: string; definition: FormDefinition; embed: boolean }) {
  const main = useRef<HTMLElement>(null);
  const [state, setState] = useState<SessionState>({ kind: "starting" });
  const [receipt, setReceipt] = useState<Receipt | undefined>();
  const started = useRef(false);
  // One Idempotency-Key per set of answers: a retry after a lost response reuses it and can never submit twice.
  const attempt = useRef<{ digest: string; key: string } | undefined>(undefined);

  // One session per page load. The ref survives React's development double-mount.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void startSession(slug, embed).then(setState);
  }, [slug, embed]);

  // Embedded: report the content height so the host page can size the iframe.
  // The form's own box is measured, not the document, whose height never drops
  // below the frame's, so the frame can shrink again (e.g. on a shorter page).
  useEffect(() => {
    const content = main.current;
    if (!embed || !content || window.parent === window) return;
    let last = 0;
    const report = () => {
      const height = Math.ceil(content.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      // Any origin may host the form; the message reveals only a height.
      window.parent.postMessage({ type: HEIGHT_MESSAGE, height }, "*");
    };
    const observer = new ResizeObserver(report);
    observer.observe(content);
    report();
    return () => observer.disconnect();
  }, [embed]);

  async function submit(answers: Record<string, AnswerValue>): Promise<string | undefined> {
    if (state.kind !== "ready") return state.kind === "failed" ? state.message : "The form is still getting ready. Try again in a moment.";
    const { sessionId, capability, versionId: sessionVersion } = state.session;
    const digest = canonicalJson(answers);
    if (attempt.current?.digest !== digest) attempt.current = { digest, key: crypto.randomUUID() };
    let res: Response;
    try {
      res = await fetch(`/public/v1/sessions/${encodeURIComponent(sessionId)}/submissions`, {
        method: "POST",
        cache: "no-store",
        headers: { authorization: `Bearer ${capability}`, "content-type": "application/json", "idempotency-key": attempt.current.key },
        body: JSON.stringify({ formVersionId: sessionVersion, answers }),
      });
    } catch {
      return "We couldn't reach Workeasy Forms. Check your connection and try again; your answers are still here and won't be sent twice.";
    }
    if (res.ok) {
      setReceipt((await res.json()) as Receipt);
      return undefined;
    }
    return refusal(res.status, (await res.json().catch(() => ({}))) as { code?: string; errors?: Array<{ message: string }> });
  }

  // The session decides the version; it matches the page unless a new version went live in between.
  const shown = state.kind === "ready" && state.session.versionId !== versionId ? state.session.definition : definition;
  return (
    <main ref={main} className={embed ? "r-embed" : "r-page"}>
      <style>{RENDERER_CSS}</style>
      {state.kind === "failed" && (
        <p role="alert" className="r-alert">
          {state.message}
        </p>
      )}
      <FormRenderer
        key={state.kind === "ready" ? state.session.versionId : versionId}
        definition={shown}
        idPrefix="form"
        onSubmit={submit}
        successDetail={receipt ? `Your receipt number is ${receipt.receiptId.slice(0, 8).toUpperCase()}. Keep it if you need to refer to this response.` : undefined}
      />
    </main>
  );
}
