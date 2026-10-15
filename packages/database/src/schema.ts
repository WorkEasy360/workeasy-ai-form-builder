import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/** Typed view of the `app` schema. Keep in step with migrations/. */
type CreatedAt = ColumnType<Date, never, never>;
type UpdatedAt = ColumnType<Date, never, never>;

export type TenantStatus = "active" | "suspended";
export type MembershipRole = "owner" | "admin" | "creator" | "analyst" | "approver";
export type MembershipStatus = "active" | "revoked";
export type FormState = "draft" | "published" | "closed" | "archived";

export interface TenantsTable {
  id: string;
  external_org_id: string | null;
  name: string;
  home_region: string;
  status: Generated<TenantStatus>;
  settings: Generated<Record<string, unknown>>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface UsersTable {
  id: string;
  issuer: string;
  subject: string;
  display_name: string | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface MembershipsTable {
  tenant_id: string;
  user_id: string;
  role: MembershipRole;
  status: Generated<MembershipStatus>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface FormsTable {
  id: Generated<string>;
  tenant_id: string;
  slug: string;
  name: string;
  owner_id: string;
  state: Generated<FormState>;
  active_version_id: Generated<string | null>;
  retention_days: Generated<number>;
  deleted_at: Date | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface AuthSessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: CreatedAt;
}

export type GrantPrincipalType = "user";

export interface FormGrantsTable {
  id: Generated<string>;
  tenant_id: string;
  form_id: string;
  principal_type: GrantPrincipalType;
  principal_id: string;
  permission: string;
  created_by: string;
  created_at: CreatedAt;
}

export interface FormDraftsTable {
  tenant_id: string;
  form_id: string;
  revision: Generated<number>;
  definition: Record<string, unknown>;
  workflow_draft: Generated<Record<string, unknown>>;
  updated_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface FormVersionsTable {
  id: Generated<string>;
  tenant_id: string;
  form_id: string;
  version_number: number;
  schema_version: string;
  definition: Record<string, unknown>;
  public_projection: Record<string, unknown>;
  content_hash: Buffer;
  workflow_snapshot: Generated<Record<string, unknown>>;
  draft_revision: number;
  publish_key_hash: Buffer;
  published_by: string;
  published_at: ColumnType<Date, never, never>;
}

export type AuditActorType = "user" | "system";

export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  request_id: string | null;
  metadata: Generated<Record<string, unknown>>;
  occurred_at: ColumnType<Date, never, never>;
}

export interface OutboxEventsTable {
  id: Generated<string>;
  tenant_id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  trace_id: string | null;
  occurred_at: ColumnType<Date, Date | undefined, never>;
  dispatched_at: Date | null;
}

export interface Database {
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  forms: FormsTable;
  form_drafts: FormDraftsTable;
  auth_sessions: AuthSessionsTable;
  form_grants: FormGrantsTable;
  form_versions: FormVersionsTable;
  audit_events: AuditEventsTable;
  outbox_events: OutboxEventsTable;
}

export type Tenant = Selectable<TenantsTable>;
export type NewTenant = Insertable<TenantsTable>;
export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type Membership = Selectable<MembershipsTable>;
export type NewMembership = Insertable<MembershipsTable>;
export type Form = Selectable<FormsTable>;
export type NewForm = Insertable<FormsTable>;
export type FormUpdate = Updateable<FormsTable>;
