/**
 * Database roles (docs/02 §2, docs/04 §4). The owner role runs migrations and
 * owns every object; runtime roles never own tables and are created without
 * SUPERUSER or BYPASSRLS, so row-level security always applies to them.
 * Migrations grant privileges to these exact names.
 */
export const DB_ROLES = {
  owner: "workeasy_owner",
  api: "workeasy_api",
  worker: "workeasy_worker",
  public: "workeasy_public",
} as const;

export type DbRoleKey = keyof typeof DB_ROLES;

export const RUNTIME_ROLE_KEYS = ["api", "worker", "public"] as const satisfies readonly DbRoleKey[];

/** Schema holding every application object. Runtime roles get it as search_path. */
export const APP_SCHEMA = "app";
