"use client";

import { useEffect, useState } from "react";
import { CreateOrganization } from "./create-organization";
import { SignIn } from "./sign-in";

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

/**
 * The landing page: sign in, then pick an organization. Someone in exactly
 * one organization goes straight to its forms.
 */
export function SessionPanel({ signInFailed, returnTo }: { signInFailed: boolean; returnTo?: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/me", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) setState({ kind: "signed-out" });
        else if (res.ok) {
          const me = (await res.json()) as Me;
          if (returnTo) window.location.replace(returnTo);
          else if (me.organizations.length === 1) window.location.replace(`/o/${me.organizations[0]!.id}/forms`);
          else setState({ kind: "signed-in", me });
        } else setState({ kind: "error" });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [returnTo]);

  if (state.kind === "loading") {
    return <p role="status">Checking your session…</p>;
  }

  if (state.kind === "error") {
    return (
      <p role="alert">
        We couldn&apos;t reach WorkEasy360 Forms. Check your connection and <a href="/">try again</a>.
      </p>
    );
  }

  if (state.kind === "signed-out") {
    return <SignIn signInFailed={signInFailed} {...(returnTo ? { returnTo } : {})} />;
  }

  const { me } = state;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ margin: 0 }}>
        Signed in as <strong>{me.user.displayName ?? "your account"}</strong>.
      </p>
      {me.organizations.length === 0 ? (
        <CreateOrganization first />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0 }}>Choose an organization</h2>
          {me.organizations.map((org) => (
            <a key={org.id} href={`/o/${org.id}/forms`} className="c-card c-choice" style={{ textDecoration: "none" }}>
              <h3>{org.name}</h3>
              <p>Your role: {org.role}</p>
            </a>
          ))}
        </div>
      )}
      <form method="post" action="/auth/logout">
        <button type="submit" className="c-btn">
          Sign out
        </button>
      </form>
    </div>
  );
}
