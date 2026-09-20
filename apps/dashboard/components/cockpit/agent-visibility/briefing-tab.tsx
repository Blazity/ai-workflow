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

import { CkChip } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import {
  readAttemptBriefingsPage,
  type AttemptBriefings,
  type CaptureCounts,
} from "@/lib/agent-visibility/contract";
import { loadVisibility, type LoadFailure } from "@/lib/agent-visibility/load";
import { runStateSentence } from "@/lib/agent-visibility/wording";
import { LIVE_POLL_MS, useLivePoll } from "@/lib/use-live-poll";

import { AttemptSends } from "./attempt-sends";
import { CaptureLine, LoadFailureNotice, Loading, Notice } from "./notices";
import { useOnScreen } from "./on-screen";

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
  /** What capture did with the whole run's sends: a refusal is invisible until
   *  somebody opens the one briefing that is missing, so it is counted here. */
  capture: CaptureCounts | null;
  failure: LoadFailure | null;
  loading: boolean;
}

const EMPTY: TabState = {
  data: null,
  absent: false,
  runState: null,
  capture: null,
  failure: null,
  loading: true,
};

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
      let capture: CaptureCounts | null = null;
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
        capture = page.value.capture;
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
      setState({ data: found, absent: found === null, runState, capture, failure: null, loading: false });
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

  // Above everything, because it is about the whole run: a person reading one
  // attempt still needs to know that two of the run's sends were refused.
  const captureNotice = state.capture ? <CaptureLine capture={state.capture} /> : null;

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
        {captureNotice}
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
        {captureNotice}
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
      {captureNotice}
      {runNotice}
      <AttemptSends
        runId={runId}
        attempt={state.data}
        send={send}
        section={section}
        onLinkChange={onLinkChange}
        runExplained={runSentence !== null}
      />
      {attempt.live && runIsLive ? (
        <div>
          <CkChip tone="running">Watching for later sends</CkChip>
        </div>
      ) : null}
    </>,
  );
}
