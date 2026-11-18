"use client";

import { useEffect, useState } from "react";
import { CreateOrganization } from "./create-organization";
import { SignIn } from "./sign-in";
import { NoAccess, SignOutButtons } from "./workeasy360";

interface Organization {
  id: string;
  name: string;
  role: string;
  permissions: string[];
}

interface Me {
  user: { id: string; displayName: string | null };
  organizations: Organization[];
  session?: { provider: "local" | "workeasy360"; workeasy360SignOut: boolean };
}

type State = { kind: "loading" } | { kind: "signed-out" } | { kind: "error" } | { kind: "signed-in"; me: Me };

/**
 * The landing page: sign in, then pick an organization. Someone in exactly
 * one organization goes straight to its forms.
 */
export function SessionPanel({ signInFailed, returnTo, ssoError, reason }: { signInFailed: boolean; returnTo?: string; ssoError?: string; reason?: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const denied = ssoError === "not_entitled";

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
        We couldn&apos;t reach Workeasy. Check your connection and <a href="/">try again</a>.
      </p>
    );
  }

  if (state.kind === "signed-out") {
    // WorkEasy360 said this organization (or person) has no access: a purchase path, not a sign-in error.
    if (denied) return <NoAccess reason={reason} signedIn={false} />;
    return <SignIn signInFailed={signInFailed} {...(returnTo ? { returnTo } : {})} {...(ssoError ? { ssoError } : {})} />;
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <SignOutButtons workeasy360={me.session?.workeasy360SignOut ?? false} />
      </div>
    </div>
  );
}
