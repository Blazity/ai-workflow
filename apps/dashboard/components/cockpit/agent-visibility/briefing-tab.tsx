"use client";

/**
 * What one Block Attempt sent to a model: every send in order (repository
 * discovery first when there was one, then each pass), and, when a send a
 * person expects is not here, the worker's own reason for that.
 *
 * A read that fails is never told as a missing briefing: it says so, keeps
 * what was already on the screen, and offers a way forward.
 */
import React from "react";

import { Button, CkChip } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import { readAttemptBriefingsPage, type AttemptBriefings } from "@/lib/agent-visibility/contract";
import { formatMoment } from "@/lib/agent-visibility/format";
import { loadVisibility, type LoadFailure } from "@/lib/agent-visibility/load";
import { iterationLine, runStateSentence, sendTitle } from "@/lib/agent-visibility/wording";
import { LIVE_POLL_MS, useLivePoll } from "@/lib/use-live-poll";

import { LoadFailureNotice, Loading, MissingReason, Notice } from "./notices";
import { useOnScreen } from "./on-screen";
import { SendView } from "./send-view";

export interface BriefingAttempt {
  nodeId: string;
  attempt: number;
  activationScopeId: string;
  /** Whether this attempt can still record a send. */
  live: boolean;
}

interface TabState {
  data: AttemptBriefings | null;
  /** The worker answered and knows nothing about this attempt. */
  absent: boolean;
  /** What the run itself can still say, whether or not it has attempts. */
  runState: string | null;
  failure: LoadFailure | null;
  loading: boolean;
}

const EMPTY: TabState = { data: null, absent: false, runState: null, failure: null, loading: true };

export function BriefingTab({
  runId,
  attempt,
  runIsLive,
  send,
  section,
  onLinkChange,
}: {
  runId: string;
  attempt: BriefingAttempt;
  runIsLive: boolean;
  /** The send named in the link, by its briefing id; null follows the latest.
   *  The id and not the worker's sequence number: a record this build cannot
   *  read has no sequence, and a made-up one collides with a real send. */
  send: string | null;
  section: string | null;
  onLinkChange: (patch: { send?: string | null; section?: string | null }) => void;
}) {
  const key = `${runId}|${attempt.nodeId}|${attempt.attempt}|${attempt.activationScopeId}`;
  const [state, setState] = React.useState<TabState>(EMPTY);
  const keyRef = React.useRef(key);
  const inFlight = React.useRef(false);
  // Only the twin a person can see loads anything: the ticket page mounts this
  // tab twice, once per breakpoint.
  const frameRef = React.useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(frameRef);

  const load = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const requestKey = key;
    try {
      const items: AttemptBriefings[] = [];
      let runState: string | null = null;
      const filter = {
        nodeId: attempt.nodeId,
        attempt: attempt.attempt,
        activationScopeId: attempt.activationScopeId,
      };
      const fetchPage = (cursor: string | null) =>
        loadVisibility(
          () => apiClient.briefings.attempt(runId, filter, { cursor }, { cache: "no-store" }),
          readAttemptBriefingsPage,
        );
      let cursor: string | null = null;
      for (;;) {
        const page = await fetchPage(cursor);
        if (keyRef.current !== requestKey) return;
        if (!page.ok) {
          setState((current) => ({ ...current, loading: false, failure: page.failure }));
          return;
        }
        items.push(...page.value.items);
        runState = page.value.runState;
        cursor = page.value.nextCursor;
        if (cursor === null) break;
      }
      if (keyRef.current !== requestKey) return;
      const found =
        items.find(
          (item) =>
            item.nodeId === attempt.nodeId &&
            item.attempt === attempt.attempt &&
            item.activationScopeId === attempt.activationScopeId,
        ) ?? null;
      setState({ data: found, absent: found === null, runState, failure: null, loading: false });
    } finally {
      inFlight.current = false;
    }
  }, [key, runId, attempt.nodeId, attempt.attempt, attempt.activationScopeId]);

  React.useEffect(() => {
    keyRef.current = key;
    setState(EMPTY);
    if (onScreen) void load();
  }, [key, load, onScreen]);

  useLivePoll({
    enabled: onScreen === true && runIsLive && attempt.live,
    intervalMs: LIVE_POLL_MS,
    onTick: () => void load(),
  });

  const sends = state.data?.briefings ?? [];
  const named = send === null ? null : (sends.find((entry) => entry.briefingId === send) ?? null);
  const selected = named ?? sends.at(-1) ?? null;
  // A link outlives a briefing: they are kept as long as the run's replay is.
  const linkIsDead = send !== null && named === null && sends.length > 0;

  const failureNotice = state.failure ? (
    <LoadFailureNotice failure={state.failure} what="Briefings" onRetry={() => void load()} />
  ) : null;

  // The run's own state answers what no attempt can: after retention there are
  // no attempts to carry a reason.
  const runSentence = state.runState === null ? null : runStateSentence(state.runState);
  const runNotice = runSentence ? (
    <Notice tone={runSentence.tone === "lost" ? "lost" : "neutral"} title={runSentence.title}>
      {runSentence.body}
    </Notice>
  ) : null;

  const frame = (children: React.ReactNode) => (
    <div ref={frameRef} data-briefing-frame="true" className="flex min-w-0 flex-col gap-3">
      {children}
    </div>
  );

  if (onScreen === null || (state.loading && state.data === null && !state.failure)) {
    return frame(<Loading label="Loading what this attempt sent…" />);
  }
  if (state.data === null) {
    return frame(
      <>
        {failureNotice}
        {runNotice}
        {state.absent && runNotice === null ? (
          <Notice title="No record of this attempt">
            The worker keeps no record of what this attempt sent. It may have run before this run's briefings were
            kept, or belong to a run whose replay is gone.
          </Notice>
        ) : null}
      </>,
    );
  }
  if (state.data.sendsPrompts === false) {
    return frame(
      <>
        {failureNotice}
        {runNotice}
        <Notice title="No prompt goes out from this block">
          Briefings record what a model was sent. This block sends no prompt, so it has none.
        </Notice>
      </>,
    );
  }

  return frame(
    <>
      {failureNotice}
      {runNotice}
      {/* Which turn of a loop this is, and when it began: fifty rows of one
          loop body are otherwise told apart only by an opaque scope id. */}
      {state.data.iteration || state.data.startedAt ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[10px] text-neutral-600">
          {state.data.iteration ? <span className="text-coal">{iterationLine(state.data.iteration)}</span> : null}
          {state.data.startedAt ? <span>started {formatMoment(state.data.startedAt)}</span> : null}
        </div>
      ) : null}
      {state.data.sendsPrompts === null ? (
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
      {state.data.missing?.ok && !(runSentence && sends.length === 0) ? (
        <MissingReason reason={state.data.missing.value} afterSends={sends.length > 0} />
      ) : state.data.missing && !state.data.missing.ok ? (
        <Notice title="Why there is no briefing could not be read">{state.data.missing.message}</Notice>
      ) : null}

      {sends.length === 0 && !state.data.missing ? (
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
      {attempt.live && runIsLive ? (
        <div>
          <CkChip tone="running">Watching for later sends</CkChip>
        </div>
      ) : null}
    </>,
  );
}
