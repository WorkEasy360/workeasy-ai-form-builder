import { blankDefinition } from "@workeasy/form-engine";
import type { TenantFixture } from "@workeasy/test-fixtures";
import type { Db } from "../client.js";
import { withContext, withTenant } from "../context.js";

export type { TestDatabaseUrls, TestOidcSettings } from "./provided.js";

/**
 * Inserts a tenant fixture through the normal row-security path: each user in
 * its own user context, then tenant rows in the tenant context. Existing rows
 * are left untouched, so seeding is idempotent.
 */
export async function seedTenantFixture(db: Db, fixture: TenantFixture): Promise<void> {
  for (const { user } of fixture.members) {
    await withContext(db, { userId: user.id }, (trx) =>
      trx
        .insertInto("users")
        .values({ id: user.id, issuer: user.issuer, subject: user.subject, display_name: user.displayName })
        .onConflict((oc) => oc.doNothing())
        .execute(),
    );
  }

  await withTenant(db, fixture.id, async (trx) => {
    await trx
      .insertInto("tenants")
      .values({ id: fixture.id, name: fixture.name, home_region: fixture.homeRegion })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await trx
      .insertInto("memberships")
      .values(fixture.members.map((m) => ({ tenant_id: fixture.id, user_id: m.user.id, role: m.role })))
      .onConflict((oc) => oc.doNothing())
      .execute();
    if (fixture.forms.length > 0) {
      await trx
        .insertInto("forms")
        .values(
          fixture.forms.map((f) => ({ id: f.id, tenant_id: fixture.id, slug: f.slug, name: f.name, owner_id: f.ownerId })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
      // Every form has a draft; fixtures start from a blank definition.
      await trx
        .insertInto("form_drafts")
        .values(
          fixture.forms.map((f) => ({
            tenant_id: fixture.id,
            form_id: f.id,
            definition: blankDefinition(f.name) as unknown as Record<string, unknown>,
            updated_by: f.ownerId,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
      // Match the API's create behaviour: a form's owner holds these grants.
      await trx
        .insertInto("form_grants")
        .values(
          fixture.forms.flatMap((f) =>
            OWNER_GRANTS.map((permission) => ({
              tenant_id: fixture.id,
              form_id: f.id,
              principal_type: "user" as const,
              principal_id: f.ownerId,
              permission,
              created_by: f.ownerId,
            })),
          ),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  });
}

/** Same as the API's creator grants (apps/api/src/routes/api-v1.ts). */
const OWNER_GRANTS = ["forms.edit", "forms.publish", "forms.manage_access"] as const;
