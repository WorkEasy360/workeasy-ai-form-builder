import { randomUUID } from "node:crypto";

/**
 * Plain-data fixtures for tenants, users, memberships and forms. Seeding lives
 * in `@workeasy/database/testing` so this package stays dependency-free.
 */

/** Issuer used for fixture identities; never a real identity provider. */
export const FIXTURE_ISSUER = "https://idp.workeasy.test/fixtures";

export type FixtureRole = "owner" | "admin" | "creator" | "analyst" | "approver";

export interface UserFixture {
  id: string;
  issuer: string;
  subject: string;
  displayName: string;
}

export interface MemberFixture {
  user: UserFixture;
  role: FixtureRole;
}

export interface FormFixture {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
}

export interface TenantFixture {
  id: string;
  name: string;
  homeRegion: string;
  members: MemberFixture[];
  forms: FormFixture[];
}

function user(id: string, displayName: string): UserFixture {
  return { id, issuer: FIXTURE_ISSUER, subject: `fixture-${id}`, displayName };
}

/**
 * A tenant with unique random IDs (owner, analyst and two forms owned by the
 * owner), so concurrent test files never collide.
 */
export function createTenantFixture(label: string): TenantFixture {
  const owner = user(randomUUID(), `${label} owner`);
  const analyst = user(randomUUID(), `${label} analyst`);
  const form = (name: string): FormFixture => ({
    id: randomUUID(),
    slug: `t-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    name: `${label} ${name}`,
    ownerId: owner.id,
  });
  return {
    id: randomUUID(),
    name: `${label} (fixture)`,
    homeRegion: "local",
    members: [
      { user: owner, role: "owner" },
      { user: analyst, role: "analyst" },
    ],
    forms: [form("support request"), form("feedback")],
  };
}

/** Two fixed tenants for local development (`pnpm db:seed`); IDs are stable so seeding is idempotent. */
export const LOCAL_SEED_TENANTS: readonly TenantFixture[] = (() => {
  const acmeOwner = user("00000000-0000-4000-8000-00000000a001", "Asha Owner (Acme)");
  const acmeCreator = user("00000000-0000-4000-8000-00000000a002", "Carlos Creator (Acme)");
  const globexOwner = user("00000000-0000-4000-8000-00000000b001", "Grace Owner (Globex)");
  const globexAnalyst = user("00000000-0000-4000-8000-00000000b002", "Ana Analyst (Globex)");
  return [
    {
      id: "00000000-0000-4000-8000-0000000000a0",
      name: "Acme Support (local seed)",
      homeRegion: "local",
      members: [
        { user: acmeOwner, role: "owner" },
        { user: acmeCreator, role: "creator" },
      ],
      forms: [
        { id: "00000000-0000-4000-8000-00000000af01", slug: "acme-support-request", name: "Support request", ownerId: acmeCreator.id },
        { id: "00000000-0000-4000-8000-00000000af02", slug: "acme-product-feedback", name: "Product feedback", ownerId: acmeOwner.id },
      ],
    },
    {
      id: "00000000-0000-4000-8000-0000000000b0",
      name: "Globex HR (local seed)",
      homeRegion: "local",
      members: [
        { user: globexOwner, role: "owner" },
        { user: globexAnalyst, role: "analyst" },
      ],
      forms: [
        { id: "00000000-0000-4000-8000-00000000bf01", slug: "globex-leave-request", name: "Leave request", ownerId: globexOwner.id },
      ],
    },
  ];
})();
