"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TraceDetailSkeleton } from "@/app/ticket-skeleton";

interface TicketSelection {
  /** Run the user just clicked — shown active immediately, before the URL commits. */
  pendingRun: string | null;
  /** The committed `?run=` from the URL. */
  urlRun: string | null;
  /** A run switch is navigating — render the trace skeleton meanwhile. */
  isPending: boolean;
  select: (runId: string) => void;
}

const Ctx = createContext<TicketSelection | null>(null);

/**
 * Owns run selection for the desktop split view. The rail triggers `select`,
 * which moves the highlight instantly (urgent state) and navigates inside a
 * transition; `isPending` stays true for the whole navigation so the detail
 * panel can show its skeleton itself. We drive the loading state off
 * `isPending` rather than the detail Suspense boundary because an App Router
 * navigation is a transition — it intentionally keeps the previous trace on
 * screen and won't reliably surface the boundary's fallback on a `?run=` change.
 */
export function TicketSelectionProvider({
  ticketKey,
  children,
}: {
  ticketKey: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const urlRun = useSearchParams().get("run");
  const [pendingRun, setPendingRun] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Drop the optimistic highlight once the URL commits to it.
  useEffect(() => {
    setPendingRun(null);
  }, [urlRun]);

  const select = (runId: string) => {
    setPendingRun(runId);
    startTransition(() => {
      router.push(
        `/ticket/${encodeURIComponent(ticketKey)}?run=${encodeURIComponent(runId)}`,
      );
    });
  };

  return (
    <Ctx.Provider value={{ pendingRun, urlRun, isPending, select }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTicketSelection(): TicketSelection {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useTicketSelection must be used within TicketSelectionProvider");
  }
  return ctx;
}

/**
 * Desktop detail slot. `children` (the trace's Suspense boundary) is always
 * rendered so the new run fetches in parallel; while a switch is pending we lay
 * the skeleton over it, so you see the skeleton — not the previous run's trace —
 * until the new one is ready. On first load `isPending` is false and the
 * boundary streams its own skeleton normally.
 */
export function DetailArea({ children }: { children: ReactNode }) {
  const { isPending } = useTicketSelection();
  return (
    <div style={{ gridArea: "detail" }} className="relative min-h-0 min-w-0">
      <div className="h-full overflow-y-auto p-4 lg:p-6">{children}</div>
      {isPending && (
        <div className="absolute inset-0 overflow-hidden bg-app-bg p-4 lg:p-6">
          <TraceDetailSkeleton />
        </div>
      )}
    </div>
  );
}
