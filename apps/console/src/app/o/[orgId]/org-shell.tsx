"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { BrandMark, CloseIcon, MenuIcon, PRODUCT_LINE } from "@workeasy/ui/react";
import { ThemeToggle } from "@workeasy/ui/theme-toggle";
import { api, ApiError, type Me } from "../../../lib/api";
import { MODULE_GROUPS, MODULES } from "../../../lib/modules";
import { LogoutIcon, UsersIcon } from "../../icons";
import { GlobalSearch, Notifications } from "./shell-tools";

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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

type State = { kind: "loading" } | { kind: "signed-out" } | { kind: "not-found" } | { kind: "error" } | { kind: "ready"; me: Me; org: OrgContextValue };

/**
 * The console frame for one organization, the WorkEasy360 application
 * shell: a navy sidebar of the modules the user may open (lib/modules.tsx),
 * and a top bar with the organization switcher, search, notifications, the
 * theme toggle and the account menu. In the form builder the sidebar steps
 * aside into a drawer so the form gets the whole width.
 */
export function OrgShell({ orgId, children }: { orgId: string; children: ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<State>({ kind: "loading" });
  // The drawer belongs to the page it was opened on, so navigating closes it.
  const [navOpenOn, setNavOpenOn] = useState<string | null>(null);
  const navOpen = navOpenOn === pathname;

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

  if (state.kind === "signed-out" || state.kind === "not-found" || state.kind === "error") {
    const copy = {
      "signed-out": { title: "Your session has ended", text: "Sign in again to continue where you left off.", action: "Sign in", href: "/" },
      "not-found": { title: "Organization not found", text: "It doesn't exist or you don't have access to it.", action: "Your organizations", href: "/" },
      error: { title: "We couldn't reach Workeasy", text: "Check your connection and try again.", action: "Try again", href: pathname },
    }[state.kind];
    return (
      <main className="c-center-page">
        <div className="c-empty" style={{ maxWidth: 440 }}>
          <span className="c-icon-tile c-icon-tile-lg">
            <BrandMark size={34} />
          </span>
          <h2>{copy.title}</h2>
          <p>{copy.text}</p>
          <a className="c-btn c-btn-primary" href={copy.href}>
            {copy.action}
          </a>
        </div>
      </main>
    );
  }

  const base = `/o/${orgId}`;
  const ready = state.kind === "ready" ? state : undefined;
  const org = ready?.org;
  const can = (p: string) => org?.permissions.includes(p) ?? false;
  const visible = MODULES.filter((m) => !m.permission || can(m.permission));
  const isCurrent = (path: string) => pathname === `${base}${path}` || pathname.startsWith(`${base}${path}/`);
  const others = ready?.me.organizations.filter((o) => o.id !== orgId) ?? [];
  const focus = /\/forms\/[^/]+\/build$/.test(pathname);

  return (
    <div className="c-app" data-focus={focus ? "true" : undefined} data-nav-open={navOpen ? "true" : undefined}>
      <a className="c-skip" href="#main">
        Skip to main content
      </a>
      <nav className="c-sidebar" aria-label="Organization">
        <a className="c-sidebar-brand" href={`${base}/forms`}>
          <BrandMark size={30} />
          <span>
            Workeasy
            <small>{PRODUCT_LINE}</small>
          </span>
        </a>
        {ready &&
          MODULE_GROUPS.map((group) => {
            const items = visible.filter((m) => m.group === group);
            if (items.length === 0) return null;
            return (
              <div className="c-nav-group" key={group} style={group === "Support" ? { marginTop: "auto", paddingTop: 16 } : undefined}>
                {group !== "Build" && group !== "Support" && <p className="c-nav-label">{group}</p>}
                <ul className="c-nav">
                  {items.map((m) => (
                    <li key={m.key}>
                      <a href={`${base}${m.path}`} aria-current={isCurrent(m.path) ? "page" : undefined}>
                        {m.icon(18)}
                        {m.label}
                        {m.key === "ai" && <span className="c-nav-tag">AI</span>}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
      </nav>

      <header className="c-topbar">
        <div className="c-topbar-start">
          <button
            type="button"
            className="c-btn c-btn-ghost c-btn-icon c-menu-toggle"
            aria-label={navOpen ? "Close menu" : "Open menu"}
            aria-expanded={navOpen}
            onClick={() => setNavOpenOn(navOpen ? null : pathname)}
          >
            {navOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
          {org ? (
            <details className="c-menu">
              <summary className="c-btn c-btn-ghost" style={{ maxWidth: "52vw" }}>
                <span className="c-store-chip">
                  <span className="c-store-initial" aria-hidden="true">
                    {org.orgName.slice(0, 1).toUpperCase()}
                  </span>
                  <span>{org.orgName}</span>
                </span>
              </summary>
              <div className="c-menu-list" style={{ left: 0, right: "auto" }}>
                <span className="c-menu-note">Your role: {org.role}</span>
                {others.length > 0 && <hr />}
                {others.map((o) => (
                  <a key={o.id} href={`/o/${o.id}/forms`}>
                    <UsersIcon size={16} /> {o.name}
                  </a>
                ))}
              </div>
            </details>
          ) : (
            <div className="c-skeleton" style={{ width: 160 }} />
          )}
          {org && <GlobalSearch orgId={orgId} base={base} can={can} organizations={others} />}
        </div>
        <div className="c-topbar-end">
          {org && <Notifications orgId={orgId} base={base} can={can} />}
          <ThemeToggle />
          {org && (
            <details className="c-menu">
              <summary className="c-btn c-btn-ghost c-btn-icon" aria-label={`Account: ${org.userName}`}>
                <span className="c-avatar" aria-hidden="true">
                  {initials(org.userName)}
                </span>
              </summary>
              <div className="c-menu-list">
                <span className="c-menu-note">
                  Signed in as <strong>{org.userName}</strong>
                </span>
                <hr />
                <form method="post" action="/auth/logout">
                  <button type="submit">
                    <LogoutIcon size={16} /> Sign out
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
