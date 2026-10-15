"use client";

import { RENDERER_CSS } from "@workeasy/form-renderer";
import { useEffect, useState } from "react";
import { api, ApiError, type FormResponse } from "../../../../../../lib/api";
import { PreviewPane } from "../build/preview";
import { BUILDER_CSS } from "../build/styles";
import type { DraftBody } from "../build/use-editor";

type Load =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "unavailable"; message: string }
  | { kind: "ready"; formName: string; draft: DraftBody };

/** Full-page preview of the last saved draft, for checking a form outside the builder. */
export function PreviewApp({ orgId, formId }: { orgId: string; formId: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const formPath = `/api/v1/organizations/${orgId}/forms/${formId}`;
  const buildHref = `/o/${orgId}/forms/${formId}/build`;

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<FormResponse>(formPath), api<DraftBody>(`${formPath}/draft`)])
      .then(([form, draft]) => {
        if (!cancelled) setLoad({ kind: "ready", formName: form.form.name, draft });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = err instanceof ApiError ? err.problem.status : 0;
        if (status === 401) setLoad({ kind: "signed-out" });
        else if (status === 404 || status === 403) setLoad({ kind: "unavailable", message: "This form doesn't exist or you don't have access to it." });
        else setLoad({ kind: "unavailable", message: err instanceof ApiError ? err.problem.title : "Something went wrong." });
      });
    return () => {
      cancelled = true;
    };
  }, [formPath]);

  if (load.kind === "loading") return <p role="status" style={{ padding: 16 }}>Loading the preview…</p>;
  if (load.kind === "signed-out") {
    return (
      <p style={{ padding: 16 }}>
        Your session has ended. <a href="/auth/login">Sign in</a> to continue.
      </p>
    );
  }
  if (load.kind === "unavailable") {
    return (
      <main style={{ padding: 16 }}>
        <p role="alert">{load.message}</p>
        <p>
          <a href={`/o/${orgId}/forms`}>Back to forms</a>
        </p>
      </main>
    );
  }
  return (
    <div className="b-shell">
      <style>{BUILDER_CSS + RENDERER_CSS}</style>
      <header className="b-topbar">
        <div style={{ display: "grid", gap: 2 }}>
          <a href={buildHref}>← Back to the builder</a>
          <h1>{load.formName}</h1>
        </div>
        <span className="b-muted">Last saved draft (revision {load.draft.revision})</span>
      </header>
      <main>
        <PreviewPane definition={load.draft.definition} />
      </main>
    </div>
  );
}
