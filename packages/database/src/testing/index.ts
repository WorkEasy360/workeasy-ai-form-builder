import type { TenantFixture } from "@workeasy/test-fixtures";
import type { Db } from "../client.js";
import { withContext, withTenant } from "../context.js";

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
    }
  });
}
