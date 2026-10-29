"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { api, ApiError } from "../../../../lib/api";
import { PlusIcon } from "../../../icons";
import { useOrg } from "../org-shell";

type Role = "owner" | "admin" | "creator" | "analyst" | "approver";

interface Member {
  userId: string;
  displayName: string | null;
  role: Role;
  status: "active" | "revoked";
  joinedAt: string;
}

interface Invitation {
  id: string;
  email: string | null;
  role: Role;
  status: "pending" | "accepted" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

const ROLES: Array<{ value: Role; label: string; help: string }> = [
  { value: "owner", label: "Owner", help: "Everything, including organization settings and other owners" },
  { value: "admin", label: "Admin", help: "Manages members, integrations and every form" },
  { value: "creator", label: "Creator", help: "Creates forms and works on forms shared with them" },
  { value: "analyst", label: "Analyst", help: "Reads responses on forms shared with them" },
  { value: "approver", label: "Approver", help: "Reviews responses on forms shared with them" },
];
const RANK: Record<Role, number> = { owner: 4, admin: 3, creator: 2, analyst: 1, approver: 1 };
const roleLabel = (r: Role) => ROLES.find((x) => x.value === r)!.label;

const INVITE_BADGE: Record<Invitation["status"], { label: string; tone?: string }> = {
  pending: { label: "Waiting", tone: "live" },
  accepted: { label: "Joined" },
  revoked: { label: "Revoked", tone: "danger" },
  expired: { label: "Expired", tone: "closed" },
};

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const message = (err: unknown) => (err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : "Something went wrong.");

/**
 * Users (PAR-05): who is in the organization, their roles, and invitation
 * links. Owners and admins manage members; only owners change owners, and
 * the organization always keeps an owner.
 */
export function MembersPanel({ orgId }: { orgId: string }) {
  const org = useOrg();
  const ids = { role: useId(), email: useId(), link: useId() };
  const base = `/api/v1/organizations/${orgId}`;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteRole, setInviteRole] = useState<Role>("creator");
  const [inviteEmail, setInviteEmail] = useState("");
  const [link, setLink] = useState<string | undefined>();

  const fetchAll = useCallback(
    () => Promise.all([api<{ members: Member[] }>(`${base}/members`), api<{ invitations: Invitation[] }>(`${base}/invitations`)]),
    [base],
  );
  const load = useCallback(async () => {
    const [m, i] = await fetchAll();
    setMembers(m.members);
    setInvitations(i.invitations);
  }, [fetchAll]);

  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then(([m, i]) => {
        if (cancelled) return;
        setMembers(m.members);
        setInvitations(i.invitations);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(message(err));
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAll]);

  if (org && !org.permissions.includes("members.manage")) {
    return (
      <div className="c-empty">
        <h2>Members</h2>
        <p>Only organization owners and admins can manage members.</p>
      </div>
    );
  }

  const myRole = (org?.role ?? "approver") as Role;
  const isOwner = myRole === "owner";
  const assignable = ROLES.filter((r) => RANK[r.value] <= RANK[myRole]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      await action();
      await load();
      setNotice(done);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const change = (m: Member, body: Partial<Pick<Member, "role" | "status">>, done: string) =>
    run(() => api(`${base}/members/${m.userId}`, { method: "PATCH", body }), done);

  async function createInvite() {
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      const res = await api<{ url: string }>(`${base}/invitations`, {
        method: "POST",
        body: { role: inviteRole, ...(inviteEmail.trim() ? { email: inviteEmail.trim() } : {}) },
      });
      setLink(res.url);
      setInviteEmail("");
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setNotice("Link copied.");
    } catch {
      setNotice("Select the link and copy it.");
    }
  }

  const pending = invitations.filter((i) => i.status === "pending");
  const past = invitations.filter((i) => i.status !== "pending").slice(0, 10);
  const nameOf = (m: Member) => m.displayName ?? "Unnamed user";

  return (
    <div>
      <div className="c-page-head">
        <div>
          <h1>Members</h1>
          <p className="c-subtitle">{org ? `People who can sign in to ${org.orgName}, and what they can do.` : " "}</p>
        </div>
        <button
          type="button"
          className="c-btn c-btn-primary"
          onClick={() => {
            setInviting(true);
            setLink(undefined);
          }}
        >
          <PlusIcon size={16} /> Invite people
        </button>
      </div>

      {error && (
        <p role="alert" className="c-error">
          {error}
        </p>
      )}
      <p role="status" className="c-hint">
        {notice}
      </p>

      {inviting && (
        <section className="c-card" aria-labelledby={`${ids.role}-h`} style={{ marginBottom: 20, display: "grid", gap: 12 }}>
          <h2 id={`${ids.role}-h`} style={{ margin: 0 }}>
            Invite people
          </h2>
          {link ? (
            <>
              <p style={{ margin: 0 }}>Send this link to the person you&apos;re inviting. It works once, for 7 days, and you won&apos;t see it again.</p>
              <div className="c-toolbar">
                <label htmlFor={ids.link} className="c-visually-hidden">
                  Invitation link
                </label>
                <input id={ids.link} className="c-input" readOnly value={link} onFocus={(e) => e.target.select()} style={{ flex: "1 1 320px" }} />
                <button type="button" className="c-btn" onClick={() => void copyLink()}>
                  Copy link
                </button>
              </div>
              <div className="c-toolbar">
                <button type="button" className="c-btn c-btn-sm" onClick={() => setLink(undefined)}>
                  Create another
                </button>
                <button type="button" className="c-btn c-btn-sm c-btn-ghost" onClick={() => setInviting(false)}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void createInvite();
              }}
              style={{ display: "grid", gap: 12 }}
            >
              <div className="c-field">
                <label className="c-label" htmlFor={ids.role}>
                  Role
                </label>
                <select id={ids.role} className="c-select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} style={{ maxWidth: 260 }}>
                  {assignable.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <span className="c-hint">{ROLES.find((r) => r.value === inviteRole)?.help}</span>
              </div>
              <div className="c-field">
                <label className="c-label" htmlFor={ids.email}>
                  Who it&apos;s for (optional)
                </label>
                <input
                  id={ids.email}
                  className="c-input"
                  type="email"
                  maxLength={254}
                  placeholder="name@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  style={{ maxWidth: 360 }}
                />
                <span className="c-hint">A note for your list of invitations. We don&apos;t send anything to this address.</span>
              </div>
              <div className="c-toolbar">
                <button type="submit" className="c-btn c-btn-primary" disabled={busy}>
                  Create invitation link
                </button>
                <button type="button" className="c-btn c-btn-ghost" onClick={() => setInviting(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {members === null && !error && <p className="c-skeleton" aria-busy="true" style={{ height: 120 }} />}
      {members && (
        <div className="c-table-wrap">
          <table className="c-table c-table-stack">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Joined</th>
                <th scope="col">
                  <span className="c-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const self = m.userId === org?.userId;
                const editable = !self && (isOwner || (m.role !== "owner" && RANK[m.role] <= RANK[myRole]));
                const active = m.status === "active";
                return (
                  <tr key={m.userId}>
                    <td data-label="Name">
                      <span className="c-cell-title">
                        {nameOf(m)}
                        {self && <span className="c-hint"> (you)</span>}
                      </span>
                    </td>
                    <td data-label="Role">
                      {editable && active ? (
                        <select
                          className="c-select"
                          aria-label={`Role for ${nameOf(m)}`}
                          style={{ maxWidth: 180 }}
                          value={m.role}
                          disabled={busy}
                          onChange={(e) => {
                            const role = e.target.value as Role;
                            void change(m, { role }, `${nameOf(m)} is now ${roleLabel(role).toLowerCase()}.`);
                          }}
                        >
                          {ROLES.filter((r) => isOwner || RANK[r.value] <= RANK[myRole]).map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        roleLabel(m.role)
                      )}
                    </td>
                    <td data-label="Status">
                      <span className="c-badge" data-tone={active ? "live" : "danger"}>
                        {active ? "Active" : "Removed"}
                      </span>
                    </td>
                    <td data-label="Joined">
                      <time dateTime={m.joinedAt}>{date.format(new Date(m.joinedAt))}</time>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {editable &&
                        (active ? (
                          <button
                            type="button"
                            className="c-btn c-btn-sm c-btn-danger"
                            disabled={busy}
                            onClick={() => {
                              if (window.confirm(`Remove ${nameOf(m)}? They lose access right away. You can add them back later.`)) {
                                void change(m, { status: "revoked" }, `${nameOf(m)} was removed.`);
                              }
                            }}
                          >
                            Remove
                          </button>
                        ) : (
                          <button type="button" className="c-btn c-btn-sm" disabled={busy} onClick={() => void change(m, { status: "active" }, `${nameOf(m)} is back.`)}>
                            Restore
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ margin: "28px 0 8px" }}>Invitations</h2>
      {pending.length === 0 && past.length === 0 ? (
        <p className="c-hint">No invitations yet.</p>
      ) : (
        <div className="c-table-wrap">
          <table className="c-table c-table-stack">
            <thead>
              <tr>
                <th scope="col">For</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="c-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...pending, ...past].map((i) => {
                const badge = INVITE_BADGE[i.status];
                return (
                  <tr key={i.id}>
                    <td data-label="For">{i.email ?? "Anyone with the link"}</td>
                    <td data-label="Role">{roleLabel(i.role)}</td>
                    <td data-label="Status">
                      <span className="c-badge" data-tone={badge.tone}>
                        {badge.label}
                      </span>
                    </td>
                    <td data-label="Expires">{i.status === "pending" ? <time dateTime={i.expiresAt}>{date.format(new Date(i.expiresAt))}</time> : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      {i.status === "pending" && (
                        <button
                          type="button"
                          className="c-btn c-btn-sm"
                          disabled={busy}
                          onClick={() => void run(() => api(`${base}/invitations/${i.id}/revoke`, { method: "POST" }), "Invitation revoked; its link no longer works.")}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
