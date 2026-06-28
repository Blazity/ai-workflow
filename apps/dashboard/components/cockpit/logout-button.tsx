"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      {error ? (
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-fail-fg">
          {error}
        </span>
      ) : null}
      <button
        type="button"
        onClick={async () => {
          setError(null);
          try {
            const res = await fetch("/api/auth/logout", { method: "POST" });
            if (!res.ok) {
              setError("Sign out failed");
              return;
            }
          } catch {
            setError("Sign out failed");
            return;
          }
          router.replace("/login");
          router.refresh();
        }}
        className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500 hover:text-neutral-800"
      >
        Sign out
      </button>
    </span>
  );
}
