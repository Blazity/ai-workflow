"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  AuthBanner,
  AuthButton,
  AuthDivider,
  AuthField,
  AuthFormShell,
  AuthLinkButton,
  AuthShell,
} from "@/components/auth/auth-shell";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/sso/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { enabled?: unknown } | null) => {
        if (!cancelled) {
          setSsoEnabled(typeof body?.enabled === "boolean" ? body.enabled : null);
        }
      })
      .catch(() => {
        if (!cancelled) setSsoEnabled(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      setPending(false);
      if (res.status === 401 || res.status === 403) {
        setError("Your email or password is incorrect.");
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? "Sign in is temporarily unavailable.");
    } catch {
      setPending(false);
      setError("Sign in is temporarily unavailable.");
    }
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit}>
        <AuthFormShell title="Sign in" subtitle="Welcome back to AI Workflow.">
          {error ? <AuthBanner tone="error">{error}</AuthBanner> : null}

          {ssoEnabled !== false ? (
            <>
              <AuthButton
                type="button"
                onClick={() => {
                  window.location.assign("/api/auth/sso/start");
                }}
              >
                Continue with SSO
              </AuthButton>
              <AuthDivider label="or sign in with email" />
            </>
          ) : null}

          <AuthField
            label="Email"
            type="email"
            required
            autoFocus
            autoComplete="username"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (!e.currentTarget.checkValidity()) return;
              e.preventDefault();
              document.getElementById("login-password")?.focus();
            }}
          />

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-700">
                Password
              </span>
              <AuthLinkButton
                type="button"
                onClick={() => router.push("/forgot-password")}
              >
                Forgot password?
              </AuthLinkButton>
            </div>
            <AuthField
              id="login-password"
              label=""
              aria-label="Password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <AuthButton type="submit" variant="secondary" disabled={pending}>
            {pending ? "Signing in..." : "Sign in"}
          </AuthButton>
          <p className="m-0 text-center text-[12.5px] leading-5 text-neutral-500">
            Don't have access? Ask a workspace admin for an invite.
          </p>
        </AuthFormShell>
      </form>
    </AuthShell>
  );
}
