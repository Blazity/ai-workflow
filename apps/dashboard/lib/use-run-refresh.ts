"use client";

import { useCallback, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

import { useCockpit } from "@/components/cockpit/context";

/** A run is live until it reaches one of these durable outcomes. */
export function hasActiveRun(status: string): boolean {
  return status === "running" || status === "awaiting";
}

export function useRunRefresh({
  key,
  active,
}: {
  key: string;
  active: boolean;
}): { isRefreshing: boolean; refresh: () => void } {
  const router = useRouter();
  const { registerRunRefresh } = useCockpit();
  const [isRefreshing, startTransition] = useTransition();

  useEffect(
    () => registerRunRefresh(key, active),
    [active, key, registerRunRefresh],
  );

  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  return { isRefreshing, refresh };
}

