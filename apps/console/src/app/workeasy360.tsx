"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * WorkEasy360 Accounts in the console (docs/workeasy360-sso.md): the messages
 * for a sign-in that did not complete (`/?sso_error=<code>`), the "no access"
 * page and the two sign-outs.
 */

/** What the person is told for each `sso_error` the API sends back. Never anything the provider wrote. */
export const SSO_ERROR_MESSAGES: Record<string, string> = {
  expired: "That sign-in took too long or was already used. Please try again.",
  unavailable: "WorkEasy360 sign-in is not available right now. Please try again in a few minutes.",
  rate_limited: "Too many sign-ins right now. Please try again in a minute.",
  cancelled: "Sign-in was cancelled. You can try again whenever you are ready.",
  refused: "WorkEasy360 did not complete the sign-in. Please try again.",
  invalid_token: "The sign-in could not be verified. Please try again; if it keeps happening, contact support.",
  wrong_product: "This sign-in was meant for another WorkEasy360 product.",
  no_organization: "Choose an organization in WorkEasy360, then open Workeasy Forms again.",
  email_unverified: "Verify your email address in WorkEasy360, then sign in again.",
  wrong_organization: "You signed in to a different organization than the one you opened. Open Workeasy Forms from that organization again.",
  membership_inactive: "Your access to this organization has ended. Ask one of its administrators.",
  organization_inactive: "This organization cannot be signed in to. Contact your administrator.",
  integration_suspended: "Workeasy Forms is not available through WorkEasy360 at the moment. Contact WorkEasy360 support.",
  access_policy_denied: "Your organization's sign-in policy did not allow this sign-in. Open WorkEasy360 to see what it needs.",
  access_unverified: "Workeasy Forms cannot confirm your access with WorkEasy360 right now. Please try again in a few minutes.",
  tenant_suspended: "This organization's Workeasy Forms workspace is suspended. Contact support.",
  membership_revoked: "An administrator removed you from this organization in Workeasy Forms. Ask them to add you again.",
  no_tenant: "This organization is not set up in Workeasy Forms yet. Ask your administrator to contact support.",
  identity_conflict: "Your account needs a quick fix by support before you can sign in (identity move pending).",
};

/** The entitlement reasons with a page of their own, and what each offers. */
const ACCESS_PAGES: Record<string, { title: string; text: string; purchase: boolean }> = {
  not_entitled: { title: "Your organization doesn't have Workeasy Forms yet", text: "An owner can add it to your organization in WorkEasy360.", purchase: true },
  expired: { title: "Your organization's Workeasy Forms subscription has ended", text: "An owner can renew it in WorkEasy360.", purchase: true },
  suspended: { title: "Your organization's access to Workeasy Forms is suspended", text: "Contact your administrator.", purchase: false },
  read_only: { title: "Workeasy Forms is read-only for your organization", text: "You can still view and export; an owner can renew to make changes again.", purchase: true },
  membership_inactive: { title: "Your access has ended", text: "Ask an administrator of your organization in WorkEasy360.", purchase: false },
  no_seat: { title: "You don't have a Workeasy Forms seat", text: "Ask an administrator of your organization for a seat.", purchase: false },
};

const FALLBACK_PAGE = { title: "Your access to Workeasy Forms has ended", text: "An owner of your organization can renew it in WorkEasy360.", purchase: true };

/** "No access": a denial at sign-in (`sso_error=not_entitled`) or later (403 WORKEASY360_ACCESS_ENDED). */
export function NoAccess({ reason, signedIn }: { reason?: string | undefined; signedIn: boolean }) {
  const page = (reason && ACCESS_PAGES[reason]) || FALLBACK_PAGE;
  const [purchaseUrl, setPurchaseUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!page.purchase) return;
    fetch("/auth/methods", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(async (res) => setPurchaseUrl(((await res.json()) as { workeasy360PurchaseUrl?: string }).workeasy360PurchaseUrl))
      .catch(() => setPurchaseUrl(undefined));
  }, [page.purchase]);
  return (
    <div className="c-empty" style={{ maxWidth: 480 }} role="alert">
      <h2>{page.title}</h2>
      <p>{page.text}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
        {page.purchase && purchaseUrl && (
          <a className="c-btn c-btn-primary" href={purchaseUrl} rel="noopener">
            Get Workeasy Forms in WorkEasy360
          </a>
        )}
        {signedIn ? <SignOutButtons workeasy360 /> : <a className="c-btn" href="/">Back to sign-in</a>}
      </div>
    </div>
  );
}

/**
 * Sign-out ends the Workeasy Forms session only. For a WorkEasy360 session the
 * second button also sends the browser to WorkEasy360, which asks the person
 * to confirm before it signs them out there too.
 */
export function SignOutButtons({ workeasy360, children }: { workeasy360: boolean; children?: ReactNode }) {
  return (
    <>
      <form method="post" action="/auth/logout">
        <button type="submit" className="c-btn">
          {children ?? "Sign out"}
        </button>
      </form>
      {workeasy360 && (
        <form method="post" action="/auth/logout?workeasy360=1">
          <button type="submit" className="c-btn">
            Sign out of WorkEasy360 too
          </button>
        </form>
      )}
    </>
  );
}
