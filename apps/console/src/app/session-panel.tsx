"use client";

import { useEffect, useState } from "react";

interface Organization {
  id: string;
  name: string;
  role: string;
  permissions: string[];
}

interface Me {
  user: { id: string; displayName: string | null };
  organizations: Organization[];
}

type State = { kind: "loading" } | { kind: "signed-out" } | { kind: "error" } | { kind: "signed-in"; me: Me };

const buttonStyle = {
  display: "inline-block",
  padding: "var(--we-space-1) var(--we-space-2)",
  borderRadius: "var(--we-radius-md)",
  border: "1px solid var(--we-color-accent)",
  background: "var(--we-color-accent)",
  color: "var(--we-color-accentText)",
  font: "inherit",
  textDecoration: "none",
  cursor: "pointer",
} as const;

export function SessionPanel({ signInFailed }: { signInFailed: boolean }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/me", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) setState({ kind: "signed-out" });
        else if (res.ok) setState({ kind: "signed-in", me: (await res.json()) as Me });
        else setState({ kind: "error" });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return <p role="status">Checking your session…</p>;
  }

  if (state.kind === "error") {
    return (
      <p role="alert">
        We couldn&apos;t reach Workeasy Forms. Check your connection and{" "}
        <a href="/">try again</a>.
      </p>
    );
  }

  if (state.kind === "signed-out") {
    return (
      <div>
        {signInFailed && (
          <p role="alert" style={{ color: "var(--we-color-danger)" }}>
            Sign-in didn&apos;t complete. Please try again.
          </p>
        )}
        <p>Sign in with your Workeasy account to build and manage forms.</p>
        <a href="/auth/login" style={buttonStyle}>
          Sign in
        </a>
      </div>
    );
  }

  const { me } = state;
  return (
    <div>
      <p>
        Signed in as <strong>{me.user.displayName ?? "your account"}</strong>.
      </p>
      <h2 style={{ fontSize: 20, marginBottom: "var(--we-space-1)" }}>Your organizations</h2>
      {me.organizations.length === 0 ? (
        <p>You aren&apos;t a member of any organization yet. Ask an organization owner to add you.</p>
      ) : (
        <ul style={{ paddingLeft: "var(--we-space-3)" }}>
          {me.organizations.map((org) => (
            <li key={org.id}>
              {org.name} <span style={{ color: "var(--we-color-textMuted)" }}>({org.role})</span>
            </li>
          ))}
        </ul>
      )}
      <form method="post" action="/auth/logout">
        <button type="submit" style={buttonStyle}>
          Sign out
        </button>
      </form>
    </div>
  );
}
