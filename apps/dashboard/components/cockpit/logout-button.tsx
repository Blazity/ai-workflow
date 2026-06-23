"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await fetch("/api/auth/logout", { method: "POST" });
        } catch {
          // best-effort: navigate to /login regardless of network failure
        }
        router.replace("/login");
        router.refresh();
      }}
      className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500 hover:text-neutral-800"
    >
      Sign out
    </button>
  );
}
