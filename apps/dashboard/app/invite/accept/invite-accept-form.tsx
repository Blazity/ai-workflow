"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  AuthBanner,
  AuthButton,
  AuthField,
  AuthFormShell,
  AuthLinkButton,
  AuthShell,
  BlazityLogo,
  PasswordRule,
} from "@/components/auth/auth-shell";

type InviteState = {
  email: string;
  organizationName: string;
  role: "owner" | "admin" | "member";
  mode: "new_user" | "existing_password" | "sso_only";
};

const ROLE_LABELS: Record<InviteState["role"], string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export default function InviteAcceptForm({ inviteId }: { inviteId: string }) {
  const router = useRouter();
  const [invite, setInvite] = useState<InviteState | null>(null);
  const [loading, setLoading] = useState(Boolean(inviteId));
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const longEnough = password.length >= 8;
  const matches = confirm.length > 0 && password === confirm;
  const isNewUser = invite?.mode === "new_user";
  const isExistingPasswordUser = invite?.mode === "existing_password";
  const valid =
    Boolean(inviteId) &&
    (isNewUser ? longEnough && matches : isExistingPasswordUser && password.length > 0);

  useEffect(() => {
    if (!inviteId) return;

    let active = true;
    setLoading(true);
    setError(null);
    fetch(`/api/auth/invite/${encodeURIComponent(inviteId)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as InviteState & {
          error?: string;
          message?: string;
        };
        if (!res.ok) {
          throw new Error(body.error ?? body.message ?? "This invitation is unavailable.");
        }
        if (active) setInvite(body);
      })
      .catch((err) => {
        if (active) {
          setInvite(null);
          setError(err instanceof Error ? err.message : "This invitation is unavailable.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [inviteId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/invite/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteId,
          name: isNewUser ? name : undefined,
          password,
        }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "This invitation is unavailable.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (!inviteId) {
    return (
      <AuthShell>
        <AuthFormShell title="Invitation unavailable">
          <AuthBanner tone="error">
            This invitation link is missing an invite id.
          </AuthBanner>
          <AuthButton type="button" onClick={() => router.push("/login")}>
            Back to sign in
          </AuthButton>
        </AuthFormShell>
      </AuthShell>
    );
  }

  if (loading) {
    return (
      <AuthShell>
        <AuthFormShell title="Loading invitation">
          <AuthBanner tone="info">Checking your invitation link.</AuthBanner>
        </AuthFormShell>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit}>
        <AuthFormShell
          title="Join AI Workflow"
          subtitle={
            isExistingPasswordUser
              ? "Confirm your password to join this workspace."
              : invite?.mode === "sso_only"
                ? "Use SSO to finish joining this workspace."
                : "Create a password to accept your workspace invitation."
          }
        >
          {error ? <AuthBanner tone="error">{error}</AuthBanner> : null}

          <div className="flex flex-col gap-2 rounded-[3px] border border-neutral-200 bg-neutral-100 px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
                Invitation
              </span>
              <span className="truncate font-mono text-[13px] font-medium text-neutral-900">
                {invite?.email ?? "Unavailable"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
                Workspace
              </span>
              <span className="inline-flex items-center gap-1.5 text-[13px] text-neutral-900">
                <BlazityLogo size={14} color="#FD6027" showWord={false} />
                {invite?.organizationName ?? "AI Workflow"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
                Role
              </span>
              <span className="rounded-pill border border-neutral-200 bg-white px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] text-neutral-700">
                {invite ? ROLE_LABELS[invite.role] : "Member"}
              </span>
            </div>
          </div>

          {isNewUser ? (
            <>
              <AuthField
                label="Name"
                type="text"
                autoFocus
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <AuthField
                label="Create password"
                type="password"
                required
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <AuthField
                label="Confirm password"
                type="password"
                required
                placeholder="Password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              <div className="-mt-0.5 flex flex-col gap-1.5">
                <PasswordRule ok={longEnough}>At least 8 characters</PasswordRule>
                <PasswordRule ok={matches}>Passwords match</PasswordRule>
              </div>
              <AuthButton type="submit" disabled={!valid || pending}>
                {pending ? "Accepting..." : "Accept invite and create account"}
              </AuthButton>
            </>
          ) : null}

          {isExistingPasswordUser ? (
            <>
              <AuthField
                label="Current password"
                type="password"
                required
                autoFocus
                placeholder="Password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <AuthButton type="submit" disabled={!valid || pending}>
                {pending ? "Accepting..." : "Accept invite"}
              </AuthButton>
            </>
          ) : null}

          {invite?.mode === "sso_only" ? (
            <>
              <AuthBanner tone="info">
                This email uses SSO. Continue with your identity provider to join.
              </AuthBanner>
              <AuthButton
                type="button"
                onClick={() => {
                  window.location.assign("/api/auth/sso/start");
                }}
              >
                Continue with SSO
              </AuthButton>
            </>
          ) : null}

          <AuthLinkButton
            type="button"
            className="self-center"
            onClick={() => router.push("/login")}
          >
            Back to sign in
          </AuthLinkButton>
        </AuthFormShell>
      </form>
    </AuthShell>
  );
}
