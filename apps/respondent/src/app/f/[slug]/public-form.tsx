"use client";

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

type SessionState = { kind: "starting" } | { kind: "ready"; session: Session } | { kind: "failed"; message: string };

async function startSession(slug: string, embed: boolean): Promise<SessionState> {
  let res: Response;
  try {
    res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}/sessions${embed ? "?embed=1" : ""}`, { method: "POST", cache: "no-store" });
  } catch {
    return { kind: "failed", message: "We couldn't reach Workeasy Forms. Check your connection and reload the page." };
  }
  if (res.status === 201) return { kind: "ready", session: (await res.json()) as Session };
  if (res.status === 410) return { kind: "failed", message: "This form has closed and isn't accepting responses any more." };
  if (res.status === 401) return { kind: "failed", message: "Your sign-in has ended. Reload the page to sign in again." };
  if (res.status === 403) return { kind: "failed", message: "You don't have access to this form." };
  return { kind: "failed", message: "Something went wrong. Please reload the page." };
}

/**
 * Before anything is sent, asks the API whether this session may still
 * submit. A page left open (or served from a cache) after the form was
 * closed, or after the respondent lost access, finds out here.
 *
 * Storing responses arrives with RUN-02, which repeats this check inside its
 * intake transaction; until then an accepting form says so plainly.
 */
async function submit(state: SessionState): Promise<string | undefined> {
  if (state.kind !== "ready") return state.kind === "failed" ? state.message : "The form is still getting ready. Try again in a moment.";
  const { sessionId, capability } = state.session;
  let res: Response;
  try {
    res = await fetch(`/public/v1/sessions/${encodeURIComponent(sessionId)}/acceptance`, {
      cache: "no-store",
      headers: { authorization: `Bearer ${capability}` },
    });
  } catch {
    return "We couldn't reach Workeasy Forms. Check your connection and try again; your answers are still here.";
  }
  if (res.status === 410) return "This form has closed and isn't accepting responses any more. Your answers weren't sent.";
  if (res.status === 401) return "This form session has expired. Copy anything you need, then reload the page to start again; your answers weren't sent.";
  if (res.status === 403) return "You no longer have access to this form. Your answers weren't sent.";
  if (res.status === 404) return "This form is no longer available. Your answers weren't sent.";
  if (!res.ok) return "Something went wrong. Please try again; your answers are still here.";
  return "This form isn't collecting responses yet. Your answers weren't sent.";
}

export function PublicForm({ slug, versionId, definition, embed }: { slug: string; versionId: string; definition: FormDefinition; embed: boolean }) {
  const main = useRef<HTMLElement>(null);
  const [state, setState] = useState<SessionState>({ kind: "starting" });
  const started = useRef(false);

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
      <FormRenderer key={state.kind === "ready" ? state.session.versionId : versionId} definition={shown} idPrefix="form" onSubmit={() => submit(state)} />
    </main>
  );
}
