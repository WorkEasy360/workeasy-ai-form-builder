"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type Me } from "../../../lib/api";

type State =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "ready"; name: string }
  | { kind: "joined"; orgId: string }
  | { kind: "failed"; title: string; orgId?: string };

/**
 * Joining an organization from an invitation link (PAR-05). People sign in
 * first (and come back here), then choose to join; nothing happens until
 * they do.
 */
export function AcceptInvitation({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const here = `/invite/${token}`;

  useEffect(() => {
    let cancelled = false;
    api<Me>("/api/v1/me")
      .then((me) => {
        if (!cancelled) setState({ kind: "ready", name: me.user.displayName ?? "your account" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState(err instanceof ApiError && err.problem.status === 401 ? { kind: "signed-out" } : { kind: "failed", title: "We couldn't reach WorkEasy360 Forms. Try again." });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function join() {
    setBusy(true);
    try {
      const res = await api<{ organization: { id: string } }>("/api/v1/invitations/accept", { method: "POST", body: { token } });
      setState({ kind: "joined", orgId: res.organization.id });
    } catch (err) {
      setState({ kind: "failed", title: err instanceof ApiError ? err.problem.title : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") return <p aria-busy="true">Loading…</p>;
  if (state.kind === "signed-out") {
    return (
      <div className="c-card" style={{ display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0 }}>You&apos;ve been invited</h2>
        <p style={{ margin: 0 }}>Sign in to join the organization that invited you.</p>
        <p style={{ margin: 0 }}>
          <a className="c-btn c-btn-primary" href={`/?returnTo=${encodeURIComponent(here)}`}>
            Sign in to continue
          </a>
        </p>
      </div>
    );
  }
  if (state.kind === "joined") {
    return (
      <div className="c-card" style={{ display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0 }}>You&apos;re in</h2>
        <p style={{ margin: 0 }}>You can now work on forms in this organization.</p>
        <p style={{ margin: 0 }}>
          <a className="c-btn c-btn-primary" href={`/o/${state.orgId}/forms`}>
            Go to forms
          </a>
        </p>
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className="c-card" role="alert" style={{ display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0 }}>This invitation can&apos;t be used</h2>
        <p style={{ margin: 0 }}>{state.title}</p>
        <p style={{ margin: 0 }}>
          <a className="c-btn" href="/">
            Your organizations
          </a>
        </p>
      </div>
    );
  }
  return (
    <div className="c-card" style={{ display: "grid", gap: 12 }}>
      <h2 style={{ margin: 0 }}>You&apos;ve been invited</h2>
      <p style={{ margin: 0 }}>Join the organization that invited you as {state.name}?</p>
      <p style={{ margin: 0 }}>
        <button type="button" className="c-btn c-btn-primary" disabled={busy} onClick={() => void join()}>
          Join organization
        </button>
      </p>
    </div>
  );
}
