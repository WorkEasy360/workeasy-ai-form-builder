import type { ReactNode } from "react";
import { AuditIcon, FormsIcon, HelpIcon, JobsIcon, SparkleIcon, UsersIcon } from "../app/icons";

/**
 * The console's modules, in sidebar order. The sidebar, the top-bar search
 * and each module's page header all read from this one list, so a module's
 * name, icon, permission and description never drift apart. The API checks
 * the same permissions again on every request.
 */
export type ModuleKey = "forms" | "members" | "ai" | "audit" | "jobs" | "help";

/** Sidebar groups, in order. "Build" opens the list unlabelled; "Support" is pinned to the bottom. */
export type ModuleGroup = "Build" | "Organization" | "Activity" | "Support";
export const MODULE_GROUPS: readonly ModuleGroup[] = ["Build", "Organization", "Activity", "Support"];

export interface ConsoleModule {
  key: ModuleKey;
  label: string;
  /** Path under /o/<orgId>. */
  path: string;
  group: ModuleGroup;
  icon: (size?: number) => ReactNode;
  /** Shown only to roles holding this organization permission. */
  permission?: string;
  /** One line under the page title. */
  summary: string;
  /** The primary action in the page header, if the module has one. */
  primaryAction?: string;
  /** What the module does, for search keywords and empty states. */
  features: readonly string[];
}

export const MODULES: readonly ConsoleModule[] = [
  {
    key: "forms",
    label: "Forms",
    path: "/forms",
    group: "Build",
    icon: (s) => <FormsIcon size={s} />,
    summary: "Everything your team collects, from draft to published link.",
    primaryAction: "Create form",
    features: ["Drag-and-drop builder with pages and logic", "AI drafts you review before applying", "Publish, share and embed", "Responses, exports and analytics"],
  },
  {
    key: "members",
    label: "Members",
    path: "/members",
    group: "Organization",
    icon: (s) => <UsersIcon size={s} />,
    permission: "members.manage",
    summary: "People who can sign in to this organization, and what they can do.",
    primaryAction: "Invite people",
    features: ["Invite by link", "Owner, admin, creator and analyst roles", "Remove access, and add people back later"],
  },
  {
    key: "ai",
    label: "AI settings",
    path: "/ai",
    group: "Organization",
    icon: (s) => <SparkleIcon size={s} />,
    permission: "organization.audit.read",
    summary: "AI can suggest forms for people who edit them. Suggestions never change a form until someone applies them, and prompts are not kept after a request ends.",
    features: ["Daily token limit for AI drafting and the assistant", "Today's AI use", "Prompts are not kept after a request"],
  },
  {
    key: "audit",
    label: "Audit log",
    path: "/audit",
    group: "Activity",
    icon: (s) => <AuditIcon size={s} />,
    permission: "organization.audit.read",
    summary: "Who changed what, and when. Entries never contain answers.",
    features: ["Publishing, closing and archiving forms", "Access, retention and integration changes", "Exports, deletions and AI use"],
  },
  {
    key: "jobs",
    label: "Background jobs",
    path: "/jobs",
    group: "Activity",
    icon: (s) => <JobsIcon size={s} />,
    permission: "organization.audit.read",
    summary: "Work done after a change is saved, such as deliveries. Failed attempts are retried automatically; a job that keeps failing stops and waits here.",
    features: ["Webhook and email deliveries", "Exports", "Retry a job that gave up"],
  },
  {
    key: "help",
    label: "Help",
    path: "/help",
    group: "Support",
    icon: (s) => <HelpIcon size={s} />,
    summary: "From a new form to a shared link, and what happens with responses.",
    features: ["Building and publishing", "Sharing and embedding", "Responses and privacy"],
  },
];

export function moduleByKey(key: ModuleKey): ConsoleModule {
  const found = MODULES.find((m) => m.key === key);
  if (!found) throw new Error(`Unknown module ${key}`);
  return found;
}
