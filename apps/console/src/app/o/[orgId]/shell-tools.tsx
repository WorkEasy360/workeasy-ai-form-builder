"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BellIcon, SearchIcon } from "@workeasy/ui/react";
import { api } from "../../../lib/api";
import { MODULES } from "../../../lib/modules";
import { FormsIcon, PlusIcon, UsersIcon } from "../../icons";

interface Destination {
  key: string;
  label: string;
  href: string;
  /** Where it lives, shown on the right. */
  where: string;
  icon: ReactNode;
  /** Extra words that should find it. */
  keywords?: string | undefined;
}

/** Actions inside a module worth jumping to directly, each with the permission that opens it. */
const SHORTCUTS: ReadonlyArray<{ path: string; label: string; where: string; permission: string; icon: ReactNode; keywords?: string }> = [
  { path: "/forms/new", label: "Create form", where: "Forms", permission: "forms.create", icon: <PlusIcon size={16} />, keywords: "new template blank ai" },
  { path: "/members", label: "Invite people", where: "Members", permission: "members.manage", icon: <UsersIcon size={16} />, keywords: "team invitation link role" },
];

/**
 * Search in the top bar: a combobox that jumps to any module the role can
 * open, a few direct actions, the organization's forms by name, and the
 * user's other organizations. "/" or Ctrl+K focuses it.
 */
export function GlobalSearch({
  orgId,
  base,
  can,
  organizations,
}: {
  orgId: string;
  base: string;
  can: (permission: string) => boolean;
  organizations: ReadonlyArray<{ id: string; name: string }>;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Loaded the first time search opens, so pages that never search don't pay for it.
  const [forms, setForms] = useState<ReadonlyArray<{ id: string; name: string; state: string }> | undefined>();

  function loadForms() {
    if (forms !== undefined) return;
    setForms([]);
    api<{ items: Array<{ id: string; name: string; state: string }> }>(`/api/v1/organizations/${orgId}/forms?limit=100`)
      .then((page) => setForms(page.items))
      .catch(() => setForms([]));
  }

  const all: Destination[] = [
    ...MODULES.filter((m) => !m.permission || can(m.permission)).map((m) => ({
      key: m.key,
      label: m.label,
      href: `${base}${m.path}`,
      where: m.group,
      icon: m.icon(16),
      keywords: `${m.summary} ${m.features.join(" ")}`,
    })),
    ...SHORTCUTS.filter((s) => can(s.permission)).map((s) => ({ key: s.path, label: s.label, href: `${base}${s.path}`, where: s.where, icon: s.icon, keywords: s.keywords })),
    ...(forms ?? []).map((f) => ({ key: f.id, label: f.name, href: `${base}/forms/${f.id}/build`, where: f.state === "archived" ? "Archived form" : "Form", icon: <FormsIcon size={16} /> })),
    ...organizations.map((o) => ({ key: o.id, label: o.name, href: `/o/${o.id}/forms`, where: "Switch organization", icon: <UsersIcon size={16} /> })),
  ];
  const q = query.trim().toLowerCase();
  const results = q ? all.filter((d) => `${d.label} ${d.where} ${d.keywords ?? ""}`.toLowerCase().includes(q)).slice(0, 8) : all.slice(0, 8);
  const current = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (d: Destination | undefined) => {
    if (d) window.location.assign(d.href);
  };

  return (
    <div className="c-topsearch">
      <SearchIcon size={16} />
      <input
        ref={inputRef}
        className="c-input"
        type="text"
        role="combobox"
        aria-label="Search forms and pages"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[current] ? `${listId}-${current}` : undefined}
        placeholder="Search forms and pages"
        value={query}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          loadForms();
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            if (results.length) setActive((current + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
          } else if (e.key === "Enter" && open) {
            e.preventDefault();
            go(results[current]);
          } else if (e.key === "Escape") {
            if (open) setOpen(false);
            else setQuery("");
          }
        }}
      />
      {!open && (
        <kbd className="c-kbd" aria-hidden="true">
          /
        </kbd>
      )}
      {open && (
        <ul className="c-listbox" id={listId} role="listbox" aria-label="Results">
          {results.length === 0 && <li className="c-listbox-empty">Nothing matches “{query.trim()}”.</li>}
          {results.map((d, i) => (
            <li
              key={d.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === current}
              // Pressing keeps focus in the input, so the list stays open until the page changes.
              onMouseDown={(e) => {
                e.preventDefault();
                go(d);
              }}
              onMouseMove={() => setActive(i)}
            >
              {d.icon}
              {d.label}
              <small>{d.where}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Notice {
  key: string;
  title: string;
  detail: string;
  href: string;
  tone: "warning" | "error" | "info";
}

/**
 * What needs attention in this organization, from the list the Background
 * jobs page shows: jobs that stopped retrying, such as a webhook delivery or
 * an export. Only roles that can retry them (integrations.manage) see it.
 * The count refreshes whenever the menu opens.
 */
export function Notifications({ orgId, base, can }: { orgId: string; base: string; can: (permission: string) => boolean }) {
  const [notices, setNotices] = useState<Notice[] | undefined>();
  const canAct = can("organization.audit.read") && can("integrations.manage");

  const load = useCallback(async (): Promise<Notice[]> => {
    if (!canAct) return [];
    const dead = await api<{ items: unknown[]; nextCursor?: string }>(`/api/v1/organizations/${orgId}/jobs?status=dead&limit=100`).catch(() => undefined);
    if (!dead?.items.length) return [];
    const one = dead.items.length === 1 && !dead.nextCursor;
    return [
      {
        key: "dead-jobs",
        tone: "error",
        href: `${base}/jobs`,
        title: `${dead.nextCursor ? "100+" : dead.items.length} ${one ? "job stopped retrying" : "jobs stopped retrying"}`,
        detail: "A delivery or export kept failing. Fix the cause, then retry it.",
      },
    ];
  }, [orgId, base, canAct]);

  useEffect(() => {
    let cancelled = false;
    void load().then((list) => {
      if (!cancelled) setNotices(list);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (!canAct) return null;
  const count = notices?.length ?? 0;
  return (
    <details
      className="c-menu"
      onToggle={(e) => {
        if (e.currentTarget.open) void load().then(setNotices);
      }}
    >
      <summary className="c-btn c-btn-ghost c-btn-icon c-icon-count" aria-label={count ? `Notifications: ${count} need attention` : "Notifications"}>
        <BellIcon />
        {count > 0 && (
          <span className="c-count" aria-hidden="true">
            {count}
          </span>
        )}
      </summary>
      <div className="c-menu-list c-notices">
        <span className="c-menu-title">Needs attention</span>
        {notices === undefined && <span className="c-menu-note">Checking…</span>}
        {notices?.length === 0 && <span className="c-menu-note">You&apos;re all caught up.</span>}
        {notices?.map((n) => (
          <a key={n.key} href={n.href}>
            <i className="c-notice-dot" data-tone={n.tone} aria-hidden="true" />
            <span>
              {n.title}
              <small>{n.detail}</small>
            </span>
          </a>
        ))}
      </div>
    </details>
  );
}
