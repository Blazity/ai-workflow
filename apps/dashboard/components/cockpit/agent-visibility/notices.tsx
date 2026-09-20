"use client";

import React from "react";

import { Button } from "@/components/ui";
import type { CaptureCounts } from "@/lib/agent-visibility/contract";
import { failureSentence, type LoadFailure } from "@/lib/agent-visibility/load";
import { captureLine, missingBriefingSentence, type MissingSentence } from "@/lib/agent-visibility/wording";
import type { MissingBriefingReason } from "@shared/agent-visibility";

type NoticeTone = "neutral" | "waiting" | "lost" | "failure";

const TONES: Record<NoticeTone, string> = {
  neutral: "border-neutral-200 bg-app-bg text-neutral-800",
  waiting: "border-mariner-200 bg-mariner-100 text-coal",
  lost: "border-fail-bg bg-fail-bg text-coal",
  failure: "border-fail-bg bg-panel text-fail-fg",
};

/** A sentence about why something is, or is not, on the screen. */
export function Notice({
  tone = "neutral",
  title,
  children,
  action,
  role,
}: {
  tone?: NoticeTone;
  title?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div
      role={role}
      className={`flex flex-col gap-2 rounded-[3px] border px-3 py-2.5 font-body text-[13px] leading-[1.5] sm:flex-row sm:items-start sm:justify-between ${TONES[tone]}`}
    >
      <div className="min-w-0">
        {title ? <div className="font-display text-[14px] font-semibold text-coal">{title}</div> : null}
        <div className="min-w-0 break-words">{children}</div>
      </div>
      {action ? <div className="flex shrink-0 gap-2">{action}</div> : null}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="py-4 font-body text-[13px] text-neutral-600">
      {label}
    </div>
  );
}

/**
 * A load that failed: what could not be loaded, and the way forward (retry,
 * or sign in again). Whatever was loaded before stays where it is; this sits
 * beside it.
 */
export function LoadFailureNotice({
  failure,
  what,
  onRetry,
}: {
  failure: LoadFailure;
  what: string;
  onRetry?: () => void;
}) {
  const action =
    failure.kind === "unauthorized" ? (
      <Button variant="secondary" size="sm" href="/login">
        Sign in again
      </Button>
    ) : failure.kind === "unavailable" && onRetry ? (
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Retry
      </Button>
    ) : null;
  return (
    <Notice tone="failure" role="alert" action={action}>
      {failureSentence(failure, what)}
    </Notice>
  );
}

/**
 * What capture did with the whole run's sends, in one line.
 *
 * A run where every send was recorded says so quietly, in the grey the rest of
 * the metadata is in. A run where one was not gets the "lost" tone, because a
 * refused capture is the one thing on this screen a person cannot discover by
 * reading further: the briefing it would have been is simply not in the list.
 */
export function CaptureLine({ capture }: { capture: CaptureCounts }) {
  const line = captureLine(capture);
  return line.whole ? (
    <p className="m-0 font-mono text-[10px] text-neutral-600">{line.text}</p>
  ) : (
    <Notice tone="lost" title="Not every send of this run was recorded">
      {line.text}
    </Notice>
  );
}

/** When sends are already on the screen, the reason is about the send that
 *  did not follow them, and is titled as that rather than as the attempt. */
const NEXT_SEND_TITLES: Record<MissingSentence["tone"], string> = {
  waiting: "The next send has not gone out yet",
  lost: "The next send never went out",
  not_kept: "The next send was not kept",
  settled: "No further send was needed",
};

/** Why a briefing a person expected is not here, in the worker's words. */
export function MissingReason({ reason, afterSends }: { reason: MissingBriefingReason; afterSends: boolean }) {
  const sentence = missingBriefingSentence(reason);
  const tone: NoticeTone = sentence.tone === "waiting" ? "waiting" : sentence.tone === "lost" ? "lost" : "neutral";
  return (
    <Notice tone={tone} title={afterSends ? NEXT_SEND_TITLES[sentence.tone] : sentence.title}>
      <p className="m-0">{sentence.body}</p>
      {sentence.failure ? (
        <p className="m-0 mt-1.5 break-words font-mono text-[11px] text-fail-fg">Recorded failure: {sentence.failure}</p>
      ) : null}
    </Notice>
  );
}
