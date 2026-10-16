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

export type AccessMode = "public" | "organization";

export interface FormAccessPoliciesTable {
  tenant_id: string;
  form_id: string;
  mode: AccessMode;
  max_responses: Generated<number | null>;
  open_at: Generated<Date | null>;
  close_at: Generated<Date | null>;
  updated_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface RespondentSessionsTable {
  id: Generated<string>;
  tenant_id: string;
  form_id: string;
  form_version_id: string;
  token_hash: Buffer;
  actor_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  accepted_submission_id: string | null;
  created_at: CreatedAt;
}

export interface SubmissionsTable {
  id: string;
  tenant_id: string;
  form_id: string;
  form_version_id: string;
  session_id: string;
  answers: Record<string, unknown>;
  consents: Generated<unknown[]>;
  revision: Generated<number>;
  intake_state: Generated<"accepted">;
  receipt_id: string;
  received_at: ColumnType<Date, Date | undefined, never>;
  deleted_at: Date | null;
}

export interface SubmissionRequestsTable {
  tenant_id: string;
  session_id: string;
  key_hash: Buffer;
  request_hash: Buffer;
  submission_id: string;
  response_code: number;
  receipt: Record<string, unknown>;
  created_at: CreatedAt;
}

export interface FormResponseCountersTable {
  tenant_id: string;
  form_id: string;
  accepted: number;
  updated_at: UpdatedAt;
}

export interface UsageBucketsTable {
  tenant_id: string;
  metric: "responses";
  period_start: Date;
  consumed: number;
  reserved: number;
  limit_value: number | null;
  updated_at: UpdatedAt;
}

export type UploadState = "awaiting_upload" | "pending_scan" | "scanning" | "clean" | "infected" | "rejected" | "expired";

export interface FileUploadsTable {
  id: string;
  tenant_id: string;
  form_id: string;
  form_version_id: string;
  session_id: string;
  field_id: string;
  file_name: string;
  declared_type: string;
  declared_bytes: number;
  storage_key: string;
  state: Generated<UploadState>;
  detected_type: Generated<string | null>;
  rejection_reason: Generated<string | null>;
  bytes: Generated<number | null>;
  scan_attempts: Generated<number>;
  lease_until: Generated<Date | null>;
  claimed_submission_id: Generated<string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  expires_at: Generated<Date>;
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
  form_access_policies: FormAccessPoliciesTable;
  respondent_sessions: RespondentSessionsTable;
  submissions: SubmissionsTable;
  submission_requests: SubmissionRequestsTable;
  form_response_counters: FormResponseCountersTable;
  usage_buckets: UsageBucketsTable;
  file_uploads: FileUploadsTable;
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
