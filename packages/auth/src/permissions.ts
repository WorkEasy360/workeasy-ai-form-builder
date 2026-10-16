/**
 * Organization roles, permissions and per-form grants (docs/01 §4).
 * Pure functions: callers load membership and grants from the database and
 * the server enforces the result on every request, job and export.
 */

export const ORG_ROLES = ["owner", "admin", "creator", "analyst", "approver"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ORG_PERMISSIONS = [
  "organization.manage",
  "members.manage",
  "integrations.manage",
  "forms.create",
  "organization.usage.read",
  "organization.audit.read",
] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const FORM_PERMISSIONS = [
  "forms.read",
  "forms.edit",
  "forms.publish",
  "forms.delete",
  "forms.manage_access",
  // Answers to ordinary fields; personal and sensitive answers need the next two (docs/06 §3).
  "responses.read",
  "responses.read_personal",
  "responses.read_sensitive",
  "responses.export",
  "responses.edit",
  "responses.delete",
  "workflows.manage",
  "analytics.read",
] as const;
export type FormPermission = (typeof FORM_PERMISSIONS)[number];

export type MembershipStatus = "active" | "revoked";

export interface MembershipFacts {
  role: OrgRole;
  status: MembershipStatus;
}

/**
 * Organization-wide permissions per role. Billing/organization management is
 * owner-only ("delegated" for admins in the requirements means an explicit
 * future delegation, not a default).
 */
const ROLE_ORG_PERMISSIONS: Record<OrgRole, readonly OrgPermission[]> = {
  owner: ORG_PERMISSIONS,
  admin: ["members.manage", "integrations.manage", "forms.create", "organization.usage.read", "organization.audit.read"],
  creator: ["forms.create"],
  analyst: [],
  approver: [],
};

/**
 * Form permissions a role holds on every form in its organization. Deleting
 * forms or responses always needs an explicit grant for admins, and creators,
 * analysts and approvers act only through grants.
 */
const ROLE_FORM_PERMISSIONS: Record<OrgRole, readonly FormPermission[]> = {
  owner: FORM_PERMISSIONS,
  admin: FORM_PERMISSIONS.filter((p) => p !== "forms.delete" && p !== "responses.delete"),
  creator: [],
  analyst: [],
  approver: [],
};

export function isFormPermission(value: string): value is FormPermission {
  return (FORM_PERMISSIONS as readonly string[]).includes(value);
}

export function orgPermissions(membership: MembershipFacts | undefined): Set<OrgPermission> {
  if (!membership || membership.status !== "active") return new Set();
  return new Set(ROLE_ORG_PERMISSIONS[membership.role]);
}

/** True when the role alone (without grants) can read every form in the organization. */
export function readsAllForms(membership: MembershipFacts | undefined): boolean {
  return !!membership && membership.status === "active" && ROLE_FORM_PERMISSIONS[membership.role].includes("forms.read");
}

/**
 * Effective permissions on one form: role defaults plus the member's grants
 * for that form. Any grant on a form implies `forms.read` so the member can
 * find the form it was given access to. Inactive members get nothing.
 */
export function formPermissions(
  membership: MembershipFacts | undefined,
  grants: readonly FormPermission[],
): Set<FormPermission> {
  if (!membership || membership.status !== "active") return new Set();
  const result = new Set<FormPermission>(ROLE_FORM_PERMISSIONS[membership.role]);
  for (const grant of grants) result.add(grant);
  if (grants.length > 0) result.add("forms.read");
  return result;
}
