"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  AuthBanner,
  AuthButton,
  AuthField,
  AuthFormShell,
  AuthLinkButton,
  AuthShell,
  PasswordRule,
} from "@/components/auth/auth-shell";

export default function ResetPasswordForm({
  token,
  invalid,
}: {
  token: string;
  invalid: boolean;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const longEnough = password.length >= 8;
  const matches = confirm.length > 0 && password === confirm;
  const valid = longEnough && matches;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        setDone(true);
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Unable to reset password.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (invalid) {
    return (
      <AuthShell>
        <AuthFormShell title="Link expired">
          <AuthBanner tone="error">
            This password reset link has expired or is invalid. Request a new
            one to continue.
          </AuthBanner>
          <AuthButton type="button" onClick={() => router.push("/forgot-password")}>
            Request a new link
          </AuthButton>
          <AuthLinkButton
            type="button"
            className="self-center"
            onClick={() => router.push("/login")}
          >
            Back to sign in
          </AuthLinkButton>
        </AuthFormShell>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell>
        <AuthFormShell title="Password updated">
          <AuthBanner tone="success">
            Your password has been updated. You can now sign in.
          </AuthBanner>
          <AuthButton type="button" onClick={() => router.push("/login")}>
            Continue to sign in
          </AuthButton>
        </AuthFormShell>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit}>
        <AuthFormShell
          title="Set a new password"
          subtitle="Choose a new password for your account."
        >
          {error ? <AuthBanner tone="error">{error}</AuthBanner> : null}
          <AuthField
            label="New password"
            type="password"
            required
            autoFocus
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
            {pending ? "Updating..." : "Update password"}
          </AuthButton>
        </AuthFormShell>
      </form>
    </AuthShell>
  );
}
