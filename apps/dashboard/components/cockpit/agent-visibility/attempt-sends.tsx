"use client";

/**
 * Every send of one Block Attempt, in order, and the chosen one opened below.
 *
 * ONE RENDERER FOR TWO SCREENS. The run replay reaches an attempt through a
 * run, and the flow editor reaches the same attempt through the block being
 * edited, but a person reading either is reading the same thing: what went to
 * a model, in what order, with what missing. Anything that renders sends a
 * second way is a second idea of what a prompt is, and the two drift.
 *
 * What is NOT here is what differs between the two: how the attempt was found,
 * whether the run is live, and the run's own state. Those belong to the caller.
 */
import React from "react";

import { Button } from "@/components/ui";
import type { AttemptBriefings } from "@/lib/agent-visibility/contract";
import { formatMoment } from "@/lib/agent-visibility/format";
import { iterationLine, sendTitle } from "@/lib/agent-visibility/wording";

import { MissingReason, Notice } from "./notices";
import { SendView } from "./send-view";

export function AttemptSends({
  runId,
  attempt,
  send,
  section,
  onLinkChange,
  runExplained,
}: {
  runId: string;
  attempt: AttemptBriefings;
  /** The send named in the link, by its briefing id; null follows the latest. */
  send: string | null;
  section: string | null;
  onLinkChange: (patch: { send?: string | null; section?: string | null }) => void;
  /** True when the run itself has already said why there is nothing here, so
   *  the per-attempt sentence would only repeat it. */
  runExplained: boolean;
}) {
  const sends = attempt.briefings;
  const named = send === null ? null : (sends.find((entry) => entry.briefingId === send) ?? null);
  const selected = named ?? sends.at(-1) ?? null;
  // A link outlives a briefing: they are kept as long as the run's replay is.
  const linkIsDead = send !== null && named === null && sends.length > 0;

  return (
    <>
      {/* Which turn of a loop this is, and when it began: fifty rows of one
          loop body are otherwise told apart only by an opaque scope id. */}
      {attempt.iteration || attempt.startedAt ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[10px] text-neutral-600">
          {attempt.iteration ? <span className="text-coal">{iterationLine(attempt.iteration)}</span> : null}
          {attempt.startedAt ? <span>started {formatMoment(attempt.startedAt)}</span> : null}
        </div>
      ) : null}
      {attempt.sendsPrompts === null ? (
        <Notice title="Whether this block sends a prompt is no longer known">
          The stored definition this run executed is gone, so the worker cannot say whether this block ever sends a
          prompt. Anything recorded for it is below; nothing below means nothing was kept, not that nothing was sent.
        </Notice>
      ) : null}
      {sends.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-600">
            Sends of this attempt, in order
          </span>
          <div className="flex flex-wrap gap-1.5">
            {sends.map((entry) => {
              const active = entry === selected;
              const overview = entry.overview;
              return (
                <Button
                  key={entry.briefingId}
                  variant={active ? "selected" : "secondary"}
                  size="sm"
                  aria-pressed={active}
                  onClick={() => onLinkChange({ send: entry.briefingId, section: null })}
                  className="h-auto py-1.5 text-left"
                >
                  <span className="flex flex-col gap-0.5">
                    {/* Numbered by the worker's own send number, the same one
                        the panel below prints as "send N". A record this build
                        cannot read has none, and gets no number rather than a
                        made-up one. */}
                    <span className="font-mono text-[10px]">
                      {overview.ok
                        ? `${overview.value.identity.sequence}. ${sendTitle(overview.value.identity)}`
                        : "Could not be read"}
                    </span>
                    <span className="font-mono text-[9px] font-normal text-neutral-600">
                      {overview.ok
                        ? formatMoment(overview.value.identity.capturedAt)
                        : overview.reason === "newer_version"
                          ? "written by a newer AI Workflow"
                          : "this record is broken"}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}

      {linkIsDead ? (
        <Notice title="The send this link names is gone">
          Briefings are kept as long as the run's replay is. Showing the latest send of this attempt instead, which is
          not the one the link was made for.
        </Notice>
      ) : null}

      {/* When the run itself has already said why there is nothing here, the
          same sentence per attempt is noise. */}
      {attempt.missing?.ok && !(runExplained && sends.length === 0) ? (
        <MissingReason reason={attempt.missing.value} afterSends={sends.length > 0} />
      ) : attempt.missing && !attempt.missing.ok ? (
        <Notice title="Why there is no briefing could not be read">{attempt.missing.message}</Notice>
      ) : null}

      {sends.length === 0 && !attempt.missing ? (
        <Notice title="No briefing, and no reason given">
          The worker recorded no send for this attempt and gave no reason. Its logs for this run and block are the
          next place to look.
        </Notice>
      ) : null}

      {selected ? (
        selected.overview.ok ? (
          <SendView
            key={selected.briefingId}
            runId={runId}
            briefingId={selected.briefingId}
            overview={selected.overview.value}
            section={section}
            onSectionChange={(next) => onLinkChange({ section: next })}
          />
        ) : (
          <Notice title="This send was written by a version this dashboard does not read">
            <p className="m-0">{selected.overview.message}</p>
            <p className="m-0 mt-1 font-mono text-[11px] text-neutral-700">briefing {selected.briefingId}</p>
          </Notice>
        )
      ) : null}
    </>
  );
}
