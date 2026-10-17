"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, type FormResponse, type FormSummary } from "../../../../../lib/api";
import { ChartIcon, EditIcon, GearIcon, InboxIcon, PlugIcon } from "../../../../icons";
import { useOrg } from "../../org-shell";

export const STATE_BADGE: Record<FormSummary["state"], { label: string; tone?: string }> = {
  draft: { label: "Draft" },
  published: { label: "Live", tone: "live" },
  closed: { label: "Closed", tone: "closed" },
  archived: { label: "Archived" },
};

/**
 * The header every form page shares: the form's name and state, and tabs
 * for the parts of the form the user may open (build, responses, analytics,
 * integrations), like the form-level navigation in other form builders.
 */
export function FormFrame({ orgId, formId, children }: { orgId: string; formId: string; children: ReactNode }) {
  const pathname = usePathname();
  const org = useOrg();
  const [form, setForm] = useState<FormSummary | undefined>();

  useEffect(() => {
    let cancelled = false;
    api<FormResponse>(`/api/v1/organizations/${orgId}/forms/${formId}`)
      .then((r) => {
        if (!cancelled) setForm(r.form);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orgId, formId]);

  const base = `/o/${orgId}/forms/${formId}`;
  const can = (p: string) => form?.permissions.includes(p as FormSummary["permissions"][number]) ?? false;
  const tabs = [
    { href: `${base}/build`, label: "Build", icon: <EditIcon size={16} />, show: can("forms.edit") },
    { href: `${base}/responses`, label: "Responses", icon: <InboxIcon size={16} />, show: can("responses.read") },
    { href: `${base}/analytics`, label: "Analytics", icon: <ChartIcon size={16} />, show: can("analytics.read") },
    { href: `${base}/integrations`, label: "Integrations", icon: <PlugIcon size={16} />, show: org?.permissions.includes("integrations.manage") ?? false },
    { href: `${base}/settings`, label: "Settings", icon: <GearIcon size={16} />, show: can("forms.edit") || can("forms.publish") },
  ].filter((t) => t.show);
  const badge = form ? STATE_BADGE[form.state] : undefined;

  return (
    <>
      <div className="c-formbar">
        <div className="c-formbar-top">
          <a href={`/o/${orgId}/forms`} className="c-btn c-btn-sm c-btn-ghost" aria-label="Back to all forms">
            ← Forms
          </a>
          <h1 title={form?.name}>{form?.name ?? " "}</h1>
          {badge && (
            <span className="c-badge" data-tone={badge.tone}>
              {badge.label}
            </span>
          )}
        </div>
        {tabs.length > 0 && (
          <nav className="c-tabs" aria-label="Form">
            {tabs.map((t) => (
              <a key={t.href} href={t.href} aria-current={pathname === t.href || pathname.startsWith(`${t.href}/`) ? "page" : undefined}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {t.icon}
                  {t.label}
                </span>
              </a>
            ))}
          </nav>
        )}
      </div>
      {children}
    </>
  );
}
