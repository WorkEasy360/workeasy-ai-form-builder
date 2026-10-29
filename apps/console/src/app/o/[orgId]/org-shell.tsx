"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Me } from "../../../lib/api";
import { AuditIcon, FormsIcon, HelpIcon, JobsIcon, LogoutIcon, SparkleIcon, UsersIcon } from "../../icons";

export interface OrgContextValue {
  orgId: string;
  orgName: string;
  role: string;
  /** Organization-level permissions, e.g. forms.create, integrations.manage. */
  permissions: string[];
  userName: string;
  userId: string;
}

const OrgContext = createContext<OrgContextValue | undefined>(undefined);

/** The current organization and user, for pages inside the shell; undefined while loading. */
export function useOrg(): OrgContextValue | undefined {
  return useContext(OrgContext);
}

/** The WorkEasy360 lockup: the mark, the suite name and this product's name. */
export function Brand({ href }: { href: string }) {
  return (
    <a className="c-brand" href={href}>
      <span className="c-brand-mark" aria-hidden="true">
        W
      </span>
      <span className="c-brand-name">
        WorkEasy360
        <small>Forms</small>
      </span>
    </a>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

type State = { kind: "loading" } | { kind: "signed-out" } | { kind: "not-found" } | { kind: "error" } | { kind: "ready"; me: Me; org: OrgContextValue };

/**
 * The console frame for one organization: a top bar (organization, switcher,
 * account, sign out) and a sidebar of sections the user may open. Pages
 * render inside it; sections the user cannot use are not shown.
 */
export function OrgShell({ orgId, children }: { orgId: string; children: ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    api<Me>("/api/v1/me")
      .then((me) => {
        if (cancelled) return;
        const org = me.organizations.find((o) => o.id === orgId);
        if (!org) {
          setState({ kind: "not-found" });
          return;
        }
        setState({
          kind: "ready",
          me,
          org: { orgId, orgName: org.name, role: org.role, permissions: org.permissions, userName: me.user.displayName ?? "Your account", userId: me.user.id },
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState(err instanceof ApiError && err.problem.status === 401 ? { kind: "signed-out" } : { kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (state.kind === "signed-out") {
    return (
      <main className="c-page">
        <div className="c-empty">
          <h2>Your session has ended</h2>
          <p>Sign in again to continue where you left off.</p>
          <a className="c-btn c-btn-primary" href="/">
            Sign in
          </a>
        </div>
      </main>
    );
  }
  if (state.kind === "not-found") {
    return (
      <main className="c-page">
        <div className="c-empty">
          <h2>Organization not found</h2>
          <p>It doesn&apos;t exist or you don&apos;t have access to it.</p>
          <a className="c-btn" href="/">
            Your organizations
          </a>
        </div>
      </main>
    );
  }
  if (state.kind === "error") {
    return (
      <main className="c-page">
        <p role="alert" className="c-alert" data-tone="danger">
          We couldn&apos;t reach WorkEasy360 Forms. Check your connection and <a href={pathname}>try again</a>.
        </p>
      </main>
    );
  }

  const org = state.kind === "ready" ? state.org : undefined;
  const can = (p: string) => org?.permissions.includes(p) ?? false;
  const base = `/o/${orgId}`;
  const nav = [
    { href: `${base}/forms`, label: "Forms", icon: <FormsIcon />, show: true, match: `${base}/forms` },
    { href: `${base}/members`, label: "Members", icon: <UsersIcon />, show: can("members.manage"), match: `${base}/members` },
    { href: `${base}/ai`, label: "AI settings", icon: <SparkleIcon />, show: can("organization.audit.read"), match: `${base}/ai` },
    { href: `${base}/audit`, label: "Audit log", icon: <AuditIcon />, show: can("organization.audit.read"), match: `${base}/audit` },
    { href: `${base}/jobs`, label: "Background jobs", icon: <JobsIcon />, show: can("organization.audit.read"), match: `${base}/jobs` },
    { href: `${base}/help`, label: "Help", icon: <HelpIcon />, show: true, match: `${base}/help` },
  ];
  const others = state.kind === "ready" ? state.me.organizations.filter((o) => o.id !== orgId) : [];
  // The form builder needs the whole width: the sidebar steps aside ("← Forms" leads back).
  const focus = /\/forms\/[^/]+\/build$/.test(pathname);

  return (
    <div className="c-app" data-focus={focus ? "true" : undefined}>
      <a className="c-skip" href="#main">
        Skip to main content
      </a>
      {!focus && (
        <nav className="c-sidebar" aria-label="Organization">
          <Brand href={`${base}/forms`} />
          <div className="c-sidebar-body">
            <p className="c-nav-label">Workspace</p>
            <ul className="c-nav">
              {nav
                .filter((n) => n.show)
                .map((n) => (
                  <li key={n.href}>
                    <a href={n.href} aria-current={pathname === n.match || pathname.startsWith(`${n.match}/`) ? "page" : undefined}>
                      {n.icon}
                      {n.label}
                    </a>
                  </li>
                ))}
            </ul>
          </div>
        </nav>
      )}
      <header className="c-topbar">
        <Brand href={`${base}/forms`} />
        {org && (
          <span className="c-org" title={org.orgName}>
            {org.orgName}
          </span>
        )}
        <div className="c-topbar-end">
          {others.length > 0 && (
            <details className="c-menu">
              <summary className="c-btn c-btn-sm c-btn-ghost">Switch organization</summary>
              <div className="c-menu-list">
                {others.map((o) => (
                  <a key={o.id} href={`/o/${o.id}/forms`}>
                    {o.name}
                  </a>
                ))}
              </div>
            </details>
          )}
          {org && (
            <details className="c-menu">
              <summary className="c-btn c-btn-sm c-btn-ghost" aria-label={`Account: ${org.userName}`}>
                <span className="c-avatar" aria-hidden="true">
                  {initials(org.userName)}
                </span>
                {org.userName}
              </summary>
              <div className="c-menu-list">
                <span className="c-menu-meta">Role: {org.role}</span>
                <hr />
                <form method="post" action="/auth/logout">
                  <button type="submit">
                    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                      <LogoutIcon size={16} /> Sign out
                    </span>
                  </button>
                </form>
              </div>
            </details>
          )}
        </div>
      </header>
      <main className="c-main" id="main" tabIndex={-1}>
        <OrgContext.Provider value={org}>{children}</OrgContext.Provider>
      </main>
    </div>
  );
}
