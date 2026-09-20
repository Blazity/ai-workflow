"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TraceDetailSkeleton } from "@/app/ticket-skeleton";
import { useOnScreen } from "@/components/cockpit/agent-visibility/on-screen";
import { RepositoriesPanel } from "@/components/cockpit/agent-visibility/repositories-panel";
import { MobileBackToRuns } from "@/components/cockpit/mobile/screens/ticket-mobile";

interface TicketSelection {
  /** The ticket whose runs the rail lists. */
  ticketKey: string;
  /** Run the user just clicked, shown active immediately, before the URL commits. */
  pendingRun: string | null;
  /** The committed `?run=` from the URL. */
  urlRun: string | null;
  /** A run switch is navigating, render the trace skeleton meanwhile. */
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
 * navigation is a transition, it intentionally keeps the previous trace on
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
    <Ctx.Provider value={{ ticketKey, pendingRun, urlRun, isPending, select }}>
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
 * The detail column, at every width.
 *
 * ONE of these carries the trace for both layouts when the URL names a run:
 * the desktop is a grid area that scrolls inside itself, the phone is the
 * whole page in normal flow with its own way back to the runs list. What
 * differs between them is spacing and which piece of chrome shows, all of it
 * CSS, so crossing the breakpoint restyles the tree instead of building a
 * second one. A second tree is not free: it fetches, polls and keeps its own
 * caches while CSS hides it.
 *
 * `children` (the trace's Suspense boundary) is always rendered so the new run
 * fetches in parallel; while a switch is pending we lay the skeleton over it,
 * so you see the skeleton, not the previous run's trace, until the new one is
 * ready. On first load `isPending` is false and the boundary streams its own
 * skeleton normally.
 */
export function DetailArea({ children }: { children: ReactNode }) {
  const { isPending, ticketKey, urlRun } = useTicketSelection();
  // With no run named, this column is the desktop's alone: a phone shows the
  // runs list instead, and this one sits behind `display: none`. It used to
  // load the newest run's trace there and poll it every five seconds for as
  // long as the page stayed open, which is a cost every phone paid on every
  // ticket for something nobody can look at. A column nobody can see holds no
  // trace; when the width changes back, the trace comes back and rebuilds
  // itself from the URL, which already names the run, node, attempt, tab,
  // send and section.
  const frameRef = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(frameRef);
  return (
    <div ref={frameRef} style={{ gridArea: "detail" }} className="relative lg:min-h-0 lg:min-w-0">
      <div className="flex flex-col gap-3 px-4 pt-4 pb-6 lg:h-full lg:gap-4 lg:overflow-y-auto lg:p-6">
        {/* A phone has no rail beside the trace, so this is the way back to
            the runs list. The desktop rail is that way back already. */}
        {urlRun !== null ? (
          <div className="lg:hidden">
            <MobileBackToRuns ticketKey={ticketKey} />
          </div>
        ) : null}
        {onScreen === false ? null : children}
        {/* The repository record belongs to the ticket, not to the run the
            rail has selected, so it stays put when the selection moves. It
            sits BELOW the run: a person opening a ticket came for the run,
            and the record is what they consult about it. It only opens itself
            when the URL names no run, because a link to a run is a person
            asking for that run rather than for the record. */}
        <RepositoriesPanel ticketKey={ticketKey} autoOpen={urlRun === null} />
      </div>
      {isPending && (
        <div className="absolute inset-0 overflow-hidden bg-app-bg p-4 lg:p-6">
          <TraceDetailSkeleton />
        </div>
      )}
    </div>
  );
}
