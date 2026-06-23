"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
        // Leave pending=true: the navigation unmounts this component.
        router.replace("/");
        router.refresh();
      } else {
        setPending(false);
        setError("Invalid credentials");
      }
    } catch {
      setPending(false);
      setError("Network error — please try again");
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-app-bg">
      <form
        onSubmit={onSubmit}
        className="w-[320px] flex flex-col gap-3 border border-neutral-200 bg-panel p-6"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          AI Workflow — sign in
        </span>
        <input
          type="email"
          required
          autoFocus
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border border-neutral-300 px-3 py-2 text-[13px]"
        />
        <input
          type="password"
          required
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border border-neutral-300 px-3 py-2 text-[13px]"
        />
        {error ? (
          <span className="text-[12px] text-red-600">{error}</span>
        ) : null}
        <button
          type="submit"
          disabled={pending}
          className="bg-neutral-900 px-3 py-2 text-[13px] text-white disabled:opacity-50"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
