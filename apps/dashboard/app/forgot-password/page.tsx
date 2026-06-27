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
} from "@/components/auth/auth-shell";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailLooksValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setSent(true);
      } else {
        setError("Unable to send a reset link right now.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <AuthShell>
        <AuthFormShell title="Check your email">
          <AuthBanner tone="success">
            If an account exists for {email} and can sign in with a password,
            we've sent a reset link. The link expires in 1 hour.
          </AuthBanner>
          <p className="m-0 text-[13px] leading-6 text-neutral-700">
            Accounts that sign in through SSO recover access through their SSO
            provider.
          </p>
          <AuthButton
            type="button"
            variant="secondary"
            onClick={() => router.push("/login")}
          >
            Back to sign in
          </AuthButton>
        </AuthFormShell>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit}>
        <AuthFormShell
          title="Reset your password"
          subtitle="Enter your email and we'll send a reset link."
        >
          {error ? <AuthBanner tone="error">{error}</AuthBanner> : null}
          <AuthField
            label="Email"
            type="email"
            required
            autoFocus
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <AuthButton type="submit" disabled={!emailLooksValid || pending}>
            {pending ? "Sending..." : "Send reset link"}
          </AuthButton>
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
