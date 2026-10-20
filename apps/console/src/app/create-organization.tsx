"use client";

import { useId, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";

/**
 * First step after signing up: name an organization. Its creator becomes the
 * owner and can invite everyone else from Members.
 */
export function CreateOrganization({ first }: { first: boolean }) {
  const id = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const org = await api<{ id: string }>("/api/v1/organizations", { method: "POST", body: { name } });
      window.location.assign(`/o/${org.id}/forms`);
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <form className="c-card" style={{ display: "grid", gap: 12 }} onSubmit={submit}>
      <h2 style={{ margin: 0, fontSize: 20 }}>{first ? "Create your organization" : "Create another organization"}</h2>
      {first && (
        <p style={{ margin: 0, color: "var(--we-color-textMuted)" }}>
          Your forms and responses live in an organization. You&apos;ll be its owner and can invite others later. If someone invited you, open the link from their invitation instead.
        </p>
      )}
      <div className="c-field" style={{ maxWidth: 420 }}>
        <label className="c-label" htmlFor={id}>
          Organization name
        </label>
        <input id={id} className="c-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required placeholder="For example: Acme Ltd" />
      </div>
      {error && (
        <p role="alert" className="c-error" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      <p style={{ margin: 0 }}>
        <button type="submit" className="c-btn c-btn-primary" disabled={busy || name.trim() === ""}>
          {busy ? "Creating…" : "Create organization"}
        </button>
      </p>
    </form>
  );
}
