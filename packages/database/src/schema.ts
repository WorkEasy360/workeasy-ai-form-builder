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
  retention_days: Generated<number>;
  deleted_at: Date | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface Database {
  tenants: TenantsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  forms: FormsTable;
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
