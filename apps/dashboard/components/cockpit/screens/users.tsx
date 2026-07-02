"use client";

import { useEffect, useId, useRef, useState } from "react";

import { CkChip, CkTabs } from "@/components/ui";

export type DashboardRole = "owner" | "admin" | "member";
export type DashboardAuthMethod = "Password" | "SSO" | "Password + SSO" | "Unknown";

export type DashboardUserRow = {
  id: string;
  name: string;
  email: string;
  role: DashboardRole;
  authMethod: DashboardAuthMethod;
  joinedAt: string;
  actions: {
    canPromote: boolean;
    canDemote: boolean;
  };
};

export type DashboardInviteRow = {
  id: string;
  email: string;
  invitedBy: string;
  role: "member";
  status: "pending" | "accepted" | "canceled" | "expired";
  emailStatus: "pending_send" | "queued" | "sent" | "failed" | "bounced" | null;
  expiresAt: string | null;
  sentAt: string;
  actions: {
    canResend: boolean;
    canCancel: boolean;
  };
};

const AVATAR_COLORS = ["#3C43E7", "#FD6027", "#181B20", "#5BB04A", "#7A5AE0", "#A2351C"];

export function UsersScreen({
  initialUsers,
  initialInvites,
  workspaceName,
}: {
  initialUsers: DashboardUserRow[];
  initialInvites: DashboardInviteRow[];
  workspaceName: string;
}) {
  const initialUsersKey = snapshotKey(initialUsers);
  const initialInvitesKey = snapshotKey(initialInvites);
  const [tab, setTab] = useState<"members" | "invites">("members");
  const [users, setUsers] = useState(initialUsers);
  const [invites, setInvites] = useState(initialInvites);
  const [appliedUsersKey, setAppliedUsersKey] = useState(initialUsersKey);
  const [appliedInvitesKey, setAppliedInvitesKey] = useState(initialInvitesKey);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleChange, setRoleChange] = useState<{
    user: DashboardUserRow;
    nextRole: "admin" | "member";
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [justResentId, setJustResentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialUsersKey === appliedUsersKey) return;
    setUsers(initialUsers);
    setAppliedUsersKey(initialUsersKey);
  }, [initialUsers, initialUsersKey, appliedUsersKey]);

  useEffect(() => {
    if (initialInvitesKey === appliedInvitesKey) return;
    setInvites(initialInvites);
    setAppliedInvitesKey(initialInvitesKey);
  }, [initialInvites, initialInvitesKey, appliedInvitesKey]);

  async function changeRole(user: DashboardUserRow, nextRole: "admin" | "member") {
    setBusyId(user.id);
    setError(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(user.id)}/role`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setUsers((current) =>
        current.map((row) =>
          row.id === user.id
            ? {
                ...row,
                role: nextRole,
                actions: {
                  canPromote: nextRole === "member",
                  canDemote: nextRole === "admin",
                },
              }
            : row,
        ),
      );
      setRoleChange(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update role");
    } finally {
      setBusyId(null);
    }
  }

  async function resendInvite(invite: DashboardInviteRow) {
    setBusyId(invite.id);
    setError(null);
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(invite.id)}/resend`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readError(res));
      const updated = (await res.json()) as DashboardInviteRow;
      setInvites((current) =>
        current.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)),
      );
      setJustResentId(updated.id);
      window.setTimeout(() => {
        setJustResentId((current) => (current === updated.id ? null : current));
      }, 2200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to resend invite");
    } finally {
      setBusyId(null);
    }
  }

  async function cancelInvite(invite: DashboardInviteRow) {
    setBusyId(invite.id);
    setError(null);
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(invite.id)}/cancel`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readError(res));
      setInvites((current) => current.filter((row) => row.id !== invite.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to cancel invite");
    } finally {
      setBusyId(null);
    }
  }

  const pendingCount = invites.filter((invite) => getInviteState(invite) === "pending").length;

  return (
    <div className="flex flex-col gap-4 px-4 pb-8 pt-5 lg:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            {workspaceName} · access
          </div>
          <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
            Users
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CkTabs
            active={tab}
            onChange={(id) => setTab(id as "members" | "invites")}
            tabs={[
              { id: "members", label: `Members · ${users.length}` },
              { id: "invites", label: `Invites · ${pendingCount}` },
            ]}
          />
          <DarkButton type="button" onClick={() => setInviteOpen(true)}>
            + Invite member
          </DarkButton>
        </div>
      </div>

      {error ? <InlineError>{error}</InlineError> : null}

      {tab === "members" ? (
        <MembersTable
          busyId={busyId}
          onRoleChange={setRoleChange}
          users={users}
        />
      ) : (
        <InvitesTable
          busyId={busyId}
          invites={invites}
          justResentId={justResentId}
          onCancel={cancelInvite}
          onResend={resendInvite}
        />
      )}

      {inviteOpen ? (
        <InviteModal
          onClose={() => setInviteOpen(false)}
          onCreated={(invite) => {
            setInvites((current) => [invite, ...current]);
            setTab("invites");
            setInviteOpen(false);
          }}
          workspaceName={workspaceName}
        />
      ) : null}

      {roleChange ? (
        <RoleChangeModal
          onClose={() => setRoleChange(null)}
          onConfirm={() => changeRole(roleChange.user, roleChange.nextRole)}
          pending={busyId === roleChange.user.id}
          target={roleChange}
          workspaceName={workspaceName}
        />
      ) : null}
    </div>
  );
}

function snapshotKey(rows: unknown[]): string {
  return JSON.stringify(rows);
}

export function NotAuthorizedScreen() {
  return (
    <div className="flex min-h-[calc(100dvh-44px)] items-center justify-center px-6 py-8">
      <section className="max-w-[420px] text-center">
        <div className="mx-auto mb-[22px] flex h-16 w-16 items-center justify-center rounded-sm border border-neutral-200 bg-app-bg font-mono text-[26px] text-neutral-700">
          ⌧
        </div>
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-fail-fg">
          403 · Not authorized
        </div>
        <h2 className="m-0 mb-2.5 font-display text-[26px] font-medium leading-[1.2] text-neutral-900">
          You don't have access to this page
        </h2>
        <p className="m-0 mb-[22px] text-[14px] leading-[1.6] text-neutral-700">
          This area is restricted. Head back to your dashboard to keep working.
        </p>
        <a
          href="/"
          className="inline-flex h-10 items-center justify-center rounded-[3px] border border-neutral-900 bg-neutral-900 px-[18px] font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-white transition hover:bg-neutral-800"
        >
          ← Back to dashboard
        </a>
      </section>
    </div>
  );
}

function MembersTable({
  users,
  busyId,
  onRoleChange,
}: {
  users: DashboardUserRow[];
  busyId: string | null;
  onRoleChange: (target: { user: DashboardUserRow; nextRole: "admin" | "member" }) => void;
}) {
  const elevatedCount = users.filter((user) => user.role !== "member").length;

  return (
    <div className="overflow-x-auto rounded-sm border border-neutral-200 bg-panel">
      <table className="w-full min-w-[940px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-neutral-100 font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
            {[
              ["Name", "left"],
              ["Email", "left"],
              ["Role", "left"],
              ["Auth method", "left"],
              ["Joined", "left"],
              ["Actions", "right"],
            ].map(([head, align]) => (
              <th
                className={[
                  "border-b border-neutral-200 px-4 py-[11px] font-medium whitespace-nowrap",
                  align === "right" ? "text-right" : "text-left",
                ].join(" ")}
                key={head}
              >
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((user, index) => (
            <tr
              className={[
                "transition-colors hover:bg-neutral-100",
                index < users.length - 1 ? "border-b border-neutral-200" : "",
              ].join(" ")}
              key={user.id}
            >
              <td className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <Avatar user={user} />
                  <span className="font-semibold text-neutral-900">{user.name}</span>
                </div>
              </td>
              <td className="px-4 py-3 font-mono text-[12px] text-neutral-700">{user.email}</td>
              <td className="px-4 py-3">
                <RoleChip role={user.role} />
              </td>
              <td className="px-4 py-3">
                <AuthMethod method={user.authMethod} />
              </td>
              <td className="px-4 py-3 font-mono text-[12px] text-neutral-500">
                {formatMonthYear(user.joinedAt)}
              </td>
              <td className="px-4 py-3 text-right">
                {user.actions.canPromote ? (
                  <GhostButton
                    disabled={busyId === user.id}
                    onClick={() => onRoleChange({ user, nextRole: "admin" })}
                    type="button"
                  >
                    ↑ Promote to admin
                  </GhostButton>
                ) : null}
                {user.actions.canDemote ? (
                  <GhostButton
                    disabled={busyId === user.id}
                    onClick={() => onRoleChange({ user, nextRole: "member" })}
                    type="button"
                  >
                    ↓ Demote to member
                  </GhostButton>
                ) : null}
                {!user.actions.canPromote && !user.actions.canDemote ? <NoAction /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-neutral-200 bg-[#FBFBFC] px-4 py-[11px] font-mono text-[11px] tracking-[0.02em] text-neutral-700">
        {users.length} members · {elevatedCount} with elevated access
      </div>
    </div>
  );
}

function InvitesTable({
  invites,
  busyId,
  justResentId,
  onResend,
  onCancel,
}: {
  invites: DashboardInviteRow[];
  busyId: string | null;
  justResentId: string | null;
  onResend: (invite: DashboardInviteRow) => void;
  onCancel: (invite: DashboardInviteRow) => void;
}) {
  const pendingCount = invites.filter((invite) => getInviteState(invite) === "pending").length;
  const failedCount = invites.filter((invite) => getInviteState(invite) === "failed").length;
  const expiredCount = invites.filter((invite) => getInviteState(invite) === "expired").length;

  return (
    <div className="overflow-x-auto rounded-sm border border-neutral-200 bg-panel">
      <table className="w-full min-w-[840px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-neutral-100 font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
            {[
              ["Email", "left"],
              ["Invited by", "left"],
              ["Status · expiry", "left"],
              ["Sent", "left"],
              ["Actions", "right"],
            ].map(([head, align]) => (
              <th
                className={[
                  "border-b border-neutral-200 px-4 py-[11px] font-medium whitespace-nowrap",
                  align === "right" ? "text-right" : "text-left",
                ].join(" ")}
                key={head}
              >
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {invites.length === 0 ? (
            <tr>
              <td className="px-4 py-8 text-center text-[13px] text-neutral-500" colSpan={5}>
                No pending invites.
              </td>
            </tr>
          ) : (
            invites.map((invite, index) => {
              const state = getInviteState(invite);
              const hasActions = invite.actions.canResend || invite.actions.canCancel;

              return (
                <tr
                  className={[
                    "transition-colors",
                    state === "failed" ? "bg-[#FFFCFA]" : "hover:bg-neutral-100",
                    index < invites.length - 1 ? "border-b border-neutral-200" : "",
                  ].join(" ")}
                  key={invite.id}
                >
                  <td className="px-4 py-[13px]">
                    <div className="flex items-center gap-2.5">
                      <span className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full border border-dashed border-[#C7CBD0] font-mono text-[12px] text-neutral-500">
                        ✉
                      </span>
                      <span className="font-mono text-[13px] font-medium text-neutral-900">
                        {invite.email}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-[13px] font-mono text-[12px] text-neutral-700">
                    {invite.invitedBy}
                  </td>
                  <td className="px-4 py-[13px]">
                    <InviteStatus invite={invite} />
                  </td>
                  <td className="px-4 py-[13px] font-mono text-[12px] text-neutral-500">
                    {formatRelativeTime(invite.sentAt)}
                  </td>
                  <td className="px-4 py-[13px] text-right">
                    <div className="inline-flex items-center gap-1.5">
                      {justResentId === invite.id ? (
                        <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-success-fg">
                          ✓ Resent
                        </span>
                      ) : null}
                      {invite.actions.canResend ? (
                        <GhostButton
                          disabled={busyId === invite.id}
                          onClick={() => onResend(invite)}
                          type="button"
                        >
                          ↻ Resend
                        </GhostButton>
                      ) : null}
                      {invite.actions.canCancel ? (
                        <GhostButton
                          danger
                          disabled={busyId === invite.id}
                          onClick={() => onCancel(invite)}
                          type="button"
                        >
                          Cancel
                        </GhostButton>
                      ) : null}
                      {!hasActions ? <NoAction /> : null}
                    </div>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      <div className="flex gap-4 border-t border-neutral-200 bg-[#FBFBFC] px-4 py-[11px] font-mono text-[11px] tracking-[0.02em] text-neutral-700">
        <span>{pendingCount} pending</span>
        {failedCount > 0 ? <span className="text-fail-fg">{failedCount} delivery failed</span> : null}
        {expiredCount > 0 ? <span>{expiredCount} expired</span> : null}
      </div>
    </div>
  );
}

function InviteModal({
  onClose,
  onCreated,
  workspaceName,
}: {
  onClose: () => void;
  onCreated: (invite: DashboardInviteRow) => void;
  workspaceName: string;
}) {
  const titleId = useId();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: "member" }),
      });
      if (!res.ok) throw new Error(await readError(res));
      onCreated((await res.json()) as DashboardInviteRow);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create invite");
    } finally {
      setPending(false);
    }
  }

  return (
    <ModalFrame labelledBy={titleId} onClose={onClose}>
      <form onSubmit={onSubmit}>
        <div className="px-[22px] pt-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
            {workspaceName} · invite
          </div>
          <h3
            className="m-0 mt-1.5 font-display text-xl font-medium leading-[1.3] text-neutral-900"
            id={titleId}
          >
            Invite a member
          </h3>
          <p className="m-0 mt-1 text-[13px] leading-[1.5] text-neutral-700">
            They'll get an email to set a password and join {workspaceName}.
          </p>
        </div>

        <div className="flex flex-col gap-3.5 px-[22px] pt-[18px]">
          {error ? <InlineError>{error}</InlineError> : null}
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
              Email address
            </span>
            <input
              autoFocus
              className="h-[38px] rounded-[3px] border border-neutral-200 bg-white px-3 font-body text-sm text-neutral-900 outline-none focus:shadow-[0_0_0_3px_rgba(60,67,231,0.18)]"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              required
              type="email"
              value={email}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
              Role
            </span>
            <div className="flex h-[38px] items-center justify-between rounded-[3px] border border-neutral-200 bg-neutral-100 px-3">
              <RoleChip role="member" />
              <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-neutral-500">
                Fixed
              </span>
            </div>
            <span className="text-[12px] text-neutral-500">
              New members join as Member. Promote to admin later from the table.
            </span>
          </label>
        </div>

        <div className="mt-2 flex justify-end gap-2 px-[22px] pb-[22px] pt-5">
          <GhostButton onClick={onClose} type="button">
            Cancel
          </GhostButton>
          <DarkButton disabled={!valid || pending} type="submit">
            Send invite →
          </DarkButton>
        </div>
      </form>
    </ModalFrame>
  );
}

function RoleChangeModal({
  target,
  pending,
  onClose,
  onConfirm,
  workspaceName,
}: {
  target: { user: DashboardUserRow; nextRole: "admin" | "member" };
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
  workspaceName: string;
}) {
  const titleId = useId();
  const promoting = target.nextRole === "admin";
  const confirmLabel = promoting ? "Promote to admin" : "Demote to member";

  return (
    <ModalFrame labelledBy={titleId} onClose={onClose}>
      <div className="px-[22px] pt-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
          {workspaceName} · role change
        </div>
        <h3
          className="m-0 mt-1.5 font-display text-xl font-medium leading-[1.3] text-neutral-900"
          id={titleId}
        >
          {promoting ? "Promote to admin?" : "Demote to member?"}
        </h3>
      </div>
      <div className="px-[22px] pt-3.5">
        <div className="flex items-center gap-2.5 rounded-[3px] border border-neutral-200 bg-neutral-100 px-3.5 py-3">
          <Avatar user={target.user} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold text-neutral-900">{target.user.name}</span>
            <span className="truncate font-mono text-[11px] text-neutral-700">
              {target.user.email}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <RoleChip role={target.user.role} />
            <span className="font-mono text-[13px] text-neutral-500">→</span>
            <RoleChip role={target.nextRole} />
          </div>
        </div>
        <p className="m-0 mt-3.5 text-[13px] leading-[1.6] text-neutral-700">
          {promoting
            ? "Admins can invite, resend, and cancel invites, and view the full Users page. They can't change the owner."
            : "They'll lose access to user management and the Users page. They'll keep their account and sign-in method."}
        </p>
      </div>
      <div className="mt-2 flex justify-end gap-2 px-[22px] pb-[22px] pt-5">
        <GhostButton onClick={onClose} type="button">
          Cancel
        </GhostButton>
        <DarkButton disabled={pending} onClick={onConfirm} type="button">
          {confirmLabel}
        </DarkButton>
      </div>
    </ModalFrame>
  );
}

function ModalFrame({
  children,
  labelledBy,
  onClose,
}: {
  children: React.ReactNode;
  labelledBy: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const firstFocusable = getFocusableElements(dialog)[0];
    (firstFocusable ?? dialog)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const previous = previousFocusRef.current;
      if (previous && document.contains(previous)) {
        previous.focus();
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[rgba(24,27,32,0.32)]"
        onClick={onClose}
      />
      <section
        aria-labelledby={labelledBy}
        aria-modal="true"
        className="relative w-[440px] max-w-[92vw] overflow-hidden rounded-md border border-neutral-200 bg-panel shadow-[0_24px_56px_rgba(24,27,32,0.16)]"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      [
        "a[href]",
        "button:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        '[tabindex]:not([tabindex="-1"])',
      ].join(","),
    ),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");
}

function Avatar({ user }: { user: DashboardUserRow }) {
  const seed = user.id || user.email || user.name;
  const color = AVATAR_COLORS[Math.abs(hashString(seed)) % AVATAR_COLORS.length];

  return (
    <span
      className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full font-mono text-[11px] font-medium tracking-[0.02em] text-white"
      style={{ backgroundColor: color }}
    >
      {getInitials(user)}
    </span>
  );
}

function RoleChip({ role }: { role: DashboardRole }) {
  const styles: Record<DashboardRole, { bg: string; fg: string; border: string; label: string }> = {
    owner: { bg: "#181B20", fg: "#FFFFFF", border: "#181B20", label: "Owner" },
    admin: { bg: "#ECECFD", fg: "#3C43E7", border: "#ECECFD", label: "Admin" },
    member: { bg: "#F2F4F6", fg: "#5F666F", border: "#E6E8EB", label: "Member" },
  };
  const roleStyle = styles[role];

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[2px] border px-[9px] py-[3px] font-mono text-[10px] font-medium uppercase tracking-[0.04em]"
      style={{
        backgroundColor: roleStyle.bg,
        borderColor: roleStyle.border,
        color: roleStyle.fg,
      }}
    >
      {roleStyle.label}
    </span>
  );
}

function AuthMethod({ method }: { method: DashboardAuthMethod }) {
  const map: Record<DashboardAuthMethod, { label: string; dots: string[]; fg: string }> = {
    Password: { label: "Password", dots: ["#9EA3AA"], fg: "#5F666F" },
    SSO: { label: "SSO", dots: ["#3C43E7"], fg: "#3C43E7" },
    "Password + SSO": { label: "Password + SSO", dots: ["#9EA3AA", "#3C43E7"], fg: "#3E444C" },
    Unknown: { label: "Unknown", dots: ["#9EA3AA"], fg: "#5F666F" },
  };
  const auth = map[method] ?? map.Unknown;

  return (
    <span
      className="inline-flex items-center gap-[7px] font-mono text-[11px]"
      style={{ color: auth.fg }}
    >
      <span className="inline-flex gap-[3px]">
        {auth.dots.map((dot, index) => (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            key={`${dot}-${index}`}
            style={{ backgroundColor: dot }}
          />
        ))}
      </span>
      {auth.label}
    </span>
  );
}

function InviteStatus({ invite }: { invite: DashboardInviteRow }) {
  const state = getInviteState(invite);

  if (state === "failed") {
    return (
      <InviteStatusStack helper="Email bounced" helperClassName="text-fail-fg">
        <CkChip tone="failed">Delivery failed</CkChip>
      </InviteStatusStack>
    );
  }

  if (state === "expired") {
    return (
      <InviteStatusStack helper="Link no longer valid">
        <CkChip tone="blocked">Expired</CkChip>
      </InviteStatusStack>
    );
  }

  if (state === "accepted") {
    return (
      <InviteStatusStack helper="Invite completed">
        <CkChip tone="success">Accepted</CkChip>
      </InviteStatusStack>
    );
  }

  if (state === "canceled") {
    return (
      <InviteStatusStack helper="Invite canceled">
        <CkChip tone="neutral">Canceled</CkChip>
      </InviteStatusStack>
    );
  }

  return (
    <InviteStatusStack helper={formatExpiry(invite.expiresAt)}>
      <CkChip tone="running">Pending</CkChip>
    </InviteStatusStack>
  );
}

function InviteStatusStack({
  children,
  helper,
  helperClassName = "text-neutral-500",
}: {
  children: React.ReactNode;
  helper: string;
  helperClassName?: string;
}) {
  return (
    <div className="flex flex-col items-start gap-[3px]">
      {children}
      <span className={`font-mono text-[10px] ${helperClassName}`}>{helper}</span>
    </div>
  );
}

function GhostButton({
  children,
  danger = false,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...props}
      className={[
        "inline-flex h-[28px] items-center justify-center whitespace-nowrap rounded-[3px] border bg-white px-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.04em] transition disabled:cursor-default disabled:opacity-40",
        danger
          ? "border-[#F3CFC7] text-fail-fg hover:bg-fail-bg"
          : "border-neutral-200 text-neutral-900 hover:bg-app-bg",
        className ?? "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function DarkButton({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={[
        "inline-flex h-9 items-center justify-center whitespace-nowrap rounded-[3px] border border-neutral-900 bg-neutral-900 px-3.5 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-white transition hover:bg-neutral-800 disabled:cursor-default disabled:opacity-40",
        className ?? "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function NoAction() {
  return <span className="font-mono text-[11px] text-neutral-300">—</span>;
}

function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[3px] border border-fail-bg bg-fail-bg px-3 py-2 text-[13px] text-fail-fg">
      {children}
    </div>
  );
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    statusMessage?: string;
  };
  return body.error ?? body.message ?? body.statusMessage ?? "Request failed";
}

function getInviteState(
  invite: DashboardInviteRow,
): "pending" | "accepted" | "canceled" | "expired" | "failed" {
  if (invite.emailStatus === "failed" || invite.emailStatus === "bounced") return "failed";
  return invite.status;
}

function formatMonthYear(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 10) return `${days}d ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatExpiry(value: string | null): string {
  if (!value) return "Expires soon";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return `Expires ${value}`;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "Expires today";
  const days = Math.ceil(diffMs / 86_400_000);
  return `Expires in ${days}d`;
}

function getInitials(user: DashboardUserRow): string {
  const parts = user.name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  if (parts.length === 1 && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
  const emailName = user.email.split("@")[0] ?? "";
  return (emailName.slice(0, 2) || "U").toUpperCase();
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}
