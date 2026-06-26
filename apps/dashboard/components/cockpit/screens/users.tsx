"use client";

import { useEffect, useId, useState } from "react";

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
  emailStatus: "queued" | "sent" | "failed" | "bounced" | null;
  expiresAt: string | null;
  sentAt: string;
  actions: {
    canResend: boolean;
    canCancel: boolean;
  };
};

export function UsersScreen({
  initialUsers,
  initialInvites,
}: {
  initialUsers: DashboardUserRow[];
  initialInvites: DashboardInviteRow[];
}) {
  const [tab, setTab] = useState<"members" | "invites">("members");
  const [users, setUsers] = useState(initialUsers);
  const [invites, setInvites] = useState(initialInvites);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleChange, setRoleChange] = useState<{
    user: DashboardUserRow;
    nextRole: "admin" | "member";
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const updated = (await res.json()) as DashboardInviteRow;
      setInvites((current) =>
        current.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to cancel invite");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 px-4 pb-8 pt-5 lg:px-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
            Workspace
          </div>
          <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
            Users
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="inline-flex h-9 items-center justify-center rounded-[3px] border border-neutral-900 bg-neutral-900 px-3 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-white transition hover:bg-neutral-800"
        >
          Invite user
        </button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <CkTabs
          active={tab}
          onChange={(id) => setTab(id as "members" | "invites")}
          tabs={[
            { id: "members", label: `Members ${users.length}` },
            { id: "invites", label: `Invites ${invites.length}` },
          ]}
        />
        {error ? (
          <span className="rounded-[3px] border border-fail-bg bg-fail-bg px-2.5 py-1.5 text-[12px] text-fail-fg">
            {error}
          </span>
        ) : null}
      </div>

      {tab === "members" ? (
        <MembersTable
          users={users}
          busyId={busyId}
          onRoleChange={setRoleChange}
        />
      ) : (
        <InvitesTable
          invites={invites}
          busyId={busyId}
          onResend={resendInvite}
          onCancel={cancelInvite}
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
        />
      ) : null}

      {roleChange ? (
        <RoleChangeModal
          target={roleChange}
          pending={busyId === roleChange.user.id}
          onClose={() => setRoleChange(null)}
          onConfirm={() => changeRole(roleChange.user, roleChange.nextRole)}
        />
      ) : null}
    </div>
  );
}

export function NotAuthorizedScreen() {
  return (
    <div className="flex min-h-[calc(100dvh-44px)] items-center justify-center px-4">
      <section className="w-full max-w-[420px] rounded-sm border border-neutral-200 bg-panel p-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          403
        </div>
        <h2 className="m-0 mt-2 font-display text-2xl font-medium text-neutral-900">
          Not authorized
        </h2>
        <p className="m-0 mt-2 text-[14px] leading-6 text-neutral-700">
          You do not have permission to view Users.
        </p>
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
  return (
    <div className="overflow-x-auto rounded-sm border border-neutral-200 bg-panel">
      <table className="w-full min-w-[780px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-neutral-100 font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
            {["Name", "Email", "Role", "Auth method", "Joined", "Actions"].map((head) => (
              <th key={head} className="border-b border-neutral-200 px-4 py-2.5 text-left font-medium">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((user, index) => (
            <tr
              key={user.id}
              className={index < users.length - 1 ? "border-b border-neutral-200" : ""}
            >
              <td className="px-4 py-3 font-semibold text-neutral-900">{user.name}</td>
              <td className="px-4 py-3 font-mono text-[12px] text-neutral-700">{user.email}</td>
              <td className="px-4 py-3"><RoleChip role={user.role} /></td>
              <td className="px-4 py-3"><AuthMethod method={user.authMethod} /></td>
              <td className="px-4 py-3 font-mono text-[12px] text-neutral-700">{formatDate(user.joinedAt)}</td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  {user.actions.canPromote ? (
                    <ActionButton
                      disabled={busyId === user.id}
                      onClick={() => onRoleChange({ user, nextRole: "admin" })}
                    >
                      Make admin
                    </ActionButton>
                  ) : null}
                  {user.actions.canDemote ? (
                    <ActionButton
                      disabled={busyId === user.id}
                      onClick={() => onRoleChange({ user, nextRole: "member" })}
                    >
                      Make member
                    </ActionButton>
                  ) : null}
                  {!user.actions.canPromote && !user.actions.canDemote ? (
                    <span className="font-mono text-[11px] text-neutral-400">None</span>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvitesTable({
  invites,
  busyId,
  onResend,
  onCancel,
}: {
  invites: DashboardInviteRow[];
  busyId: string | null;
  onResend: (invite: DashboardInviteRow) => void;
  onCancel: (invite: DashboardInviteRow) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-sm border border-neutral-200 bg-panel">
      <table className="w-full min-w-[760px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-neutral-100 font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
            {["Email", "Invited by", "Status / expiry", "Sent", "Actions"].map((head) => (
              <th key={head} className="border-b border-neutral-200 px-4 py-2.5 text-left font-medium">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {invites.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-[13px] text-neutral-500">
                No pending or historical invites.
              </td>
            </tr>
          ) : (
            invites.map((invite, index) => (
              <tr
                key={invite.id}
                className={index < invites.length - 1 ? "border-b border-neutral-200" : ""}
              >
                <td className="px-4 py-3 font-mono text-[12px] text-neutral-900">{invite.email}</td>
                <td className="px-4 py-3 text-neutral-700">{invite.invitedBy}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <InviteStatus invite={invite} />
                    {invite.expiresAt ? (
                      <span className="font-mono text-[11px] text-neutral-500">
                        Expires {formatDate(invite.expiresAt)}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-neutral-700">{formatDate(invite.sentAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {invite.actions.canResend ? (
                      <ActionButton disabled={busyId === invite.id} onClick={() => onResend(invite)}>
                        Resend
                      </ActionButton>
                    ) : null}
                    {invite.actions.canCancel ? (
                      <ActionButton disabled={busyId === invite.id} onClick={() => onCancel(invite)}>
                        Cancel
                      </ActionButton>
                    ) : null}
                    {!invite.actions.canResend && !invite.actions.canCancel ? (
                      <span className="font-mono text-[11px] text-neutral-400">None</span>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function InviteModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (invite: DashboardInviteRow) => void;
}) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
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
    <Modal onClose={onClose} title="Invite user">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error ? <InlineError>{error}</InlineError> : null}
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
            Email
          </span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            autoFocus
            required
            placeholder="teammate@company.com"
            className="h-10 rounded-[3px] border border-neutral-200 px-3 text-[14px] outline-none focus:border-mariner focus:shadow-[0_0_0_3px_rgba(60,67,231,0.18)]"
          />
        </label>
        <div className="flex items-center justify-between rounded-[3px] border border-neutral-200 bg-neutral-100 px-3 py-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
            Role
          </span>
          <RoleChip role="member" />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <ActionButton type="button" onClick={onClose}>Cancel</ActionButton>
          <button
            type="submit"
            disabled={!valid || pending}
            className="h-9 rounded-[3px] border border-neutral-900 bg-neutral-900 px-3 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-white disabled:opacity-40"
          >
            {pending ? "Creating..." : "Create invite"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RoleChangeModal({
  target,
  pending,
  onClose,
  onConfirm,
}: {
  target: { user: DashboardUserRow; nextRole: "admin" | "member" };
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal onClose={onClose} title="Change role">
      <div className="flex flex-col gap-4">
        <p className="m-0 text-[14px] leading-6 text-neutral-700">
          Change {target.user.email} to {target.nextRole}?
        </p>
        <div className="flex justify-end gap-2">
          <ActionButton type="button" onClick={onClose}>Cancel</ActionButton>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="h-9 rounded-[3px] border border-neutral-900 bg-neutral-900 px-3 font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-white disabled:opacity-40"
          >
            {pending ? "Saving..." : "Confirm"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        role="dialog"
        className="w-full max-w-[420px] rounded-sm border border-neutral-200 bg-panel shadow-[0_18px_60px_rgba(24,27,32,0.18)]"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-4">
          <h3 id={titleId} className="m-0 font-display text-[18px] font-medium text-neutral-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-[3px] border border-neutral-200 bg-white font-mono text-[14px] text-neutral-700"
          >
            x
          </button>
        </header>
        <div className="p-5">{children}</div>
      </section>
    </div>
  );
}

function RoleChip({ role }: { role: DashboardRole }) {
  const tone = role === "owner" ? "orange" : role === "admin" ? "mariner" : "neutral";
  return <CkChip tone={tone}>{role}</CkChip>;
}

function AuthMethod({ method }: { method: DashboardAuthMethod }) {
  const parts =
    method === "Password + SSO"
      ? ["PW", "SSO"]
      : method === "Password"
        ? ["PW"]
        : method === "SSO"
          ? ["SSO"]
          : ["Unknown"];
  return (
    <span className="inline-flex items-center gap-1.5">
      {parts.map((part) => (
        <span
          key={part}
          className="rounded-[3px] border border-neutral-200 bg-neutral-100 px-1.5 py-1 font-mono text-[10px] font-medium text-neutral-700"
        >
          {part}
        </span>
      ))}
    </span>
  );
}

function InviteStatus({ invite }: { invite: DashboardInviteRow }) {
  const failed = invite.emailStatus === "failed" || invite.emailStatus === "bounced";
  if (failed) return <CkChip tone="failed">Email failed</CkChip>;
  if (invite.status === "pending" && invite.emailStatus === "queued") return <CkChip tone="running">Queued</CkChip>;
  if (invite.status === "pending") return <CkChip tone="success">Pending</CkChip>;
  if (invite.status === "expired") return <CkChip tone="warn">Expired</CkChip>;
  if (invite.status === "accepted") return <CkChip tone="success">Accepted</CkChip>;
  return <CkChip tone="neutral">Canceled</CkChip>;
}

function ActionButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={[
        "h-8 rounded-[3px] border border-neutral-200 bg-white px-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.04em] text-neutral-800",
        "transition hover:bg-app-bg disabled:opacity-40",
        props.className ?? "",
      ].join(" ")}
    >
      {children}
    </button>
  );
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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
