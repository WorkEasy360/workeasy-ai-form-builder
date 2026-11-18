import { workeasy360Repo, type Db, type MembershipRole } from "@workeasy/database";
import type { Logger } from "@workeasy/observability";
import { Workeasy360Client, type Workeasy360ClientOptions } from "./client.js";
import { EntitlementCache, type AnswerStore } from "./entitlements.js";

/** What the routes need to know about this deployment's WorkEasy360 integration. */
export interface Workeasy360Settings {
  /** Exactly the issuer the product trusts (WORKEASY360_ISSUER). */
  issuer: string;
  productCode: string;
  /** WORKEASY360_REDIRECT_URI: <console>/auth/workeasy360/callback. */
  redirectUri: string;
  /** WORKEASY360_POST_LOGOUT_REDIRECT_URI, registered with the provider. */
  postLogoutRedirectUri: string;
  /** WORKEASY360_SSO_ONLY: password and generic single sign-on are off, and their sessions are refused. */
  ssoOnly: boolean;
  /** The role someone gets on joining an existing tenant (WORKEASY360_DEFAULT_ROLE). */
  defaultRole: MembershipRole;
  /** Whether an organization's first sign-in creates its tenant (WORKEASY360_PROVISION_TENANTS). */
  provisionTenants: boolean;
  /** Shown on the "no access" page as the way to get the product. */
  purchaseUrl: string;
}

export interface Workeasy360Runtime {
  client: Workeasy360Client;
  entitlements: EntitlementCache;
  settings: Workeasy360Settings;
}

/** Entitlement answers shared by every API instance, in PostgreSQL (migration 0029). */
export function postgresAnswerStore(db: Db): AnswerStore {
  return {
    get: (key) => workeasy360Repo.getEntitlementAnswer(db, key),
    set: (key, value, ttlSeconds) => workeasy360Repo.putEntitlementAnswer(db, key, value, ttlSeconds),
  };
}

export function createWorkeasy360Runtime(
  db: Db,
  clientOptions: Workeasy360ClientOptions,
  settings: Omit<Workeasy360Settings, "issuer" | "productCode" | "redirectUri">,
  extras: {
    logger?: Logger | undefined;
    /** Where entitlement answers are shared; PostgreSQL unless a test gives its own. */
    store?: AnswerStore | undefined;
    /** The entitlement cache's clock (tests); tokens are always checked against the real one. */
    cacheNow?: (() => number) | undefined;
  } = {},
): Workeasy360Runtime {
  const client = new Workeasy360Client(clientOptions);
  return {
    client,
    entitlements: new EntitlementCache(client, extras.store ?? postgresAnswerStore(db), extras.logger, extras.cacheNow),
    settings: { ...settings, issuer: clientOptions.issuer, productCode: clientOptions.productCode, redirectUri: clientOptions.redirectUri },
  };
}
