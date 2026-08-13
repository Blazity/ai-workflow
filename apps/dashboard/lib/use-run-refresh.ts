"use client";

import { useCallback, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  useCockpit,
  type RunRefreshCadence,
} from "@/components/cockpit/context";

/**
 * A run is live until it reaches one of these durable outcomes. `awaiting` counts
 * as live on purpose: a run parked on a question to a human is exactly when
 * someone is watching the screen, waiting to see their answer restart it.
 */
export function hasActiveRun(status: string): boolean {
  return status === "running" || status === "awaiting";
}

/**
 * Declares how often this surface needs refreshing and hands back the manual
 * refresh affordance. The automatic loop itself lives once in CockpitShell.
 */
export function useRunRefresh({
  key,
  cadence,
}: {
  key: string;
  cadence: RunRefreshCadence;
}): { isRefreshing: boolean; refresh: () => void } {
  const router = useRouter();
  const { registerRunRefresh } = useCockpit();
  const [isRefreshing, startTransition] = useTransition();

  useEffect(
    () => registerRunRefresh(key, cadence),
    [cadence, key, registerRunRefresh],
  );

  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  return { isRefreshing, refresh };
}
