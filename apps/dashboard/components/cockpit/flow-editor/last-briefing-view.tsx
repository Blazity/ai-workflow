"use client";

/**
 * What this block last put in front of a model, in the flow editor.
 *
 * THE PAST, NOT A PREVIEW. Everything here came out of one real run and is
 * rendered by the run replay's own component, from the run replay's own read.
 * Nothing on this screen re-reads the catalog, the prompt library or a profile
 * to decorate it: a briefing is what went out, and a fact about today would
 * quietly turn it into a guess about then.
 *
 * The run and the workflow version it ran are said out loud, because the
 * newest run of a block wins whatever version it ran: the prompt below may be
 * one a later edit has already changed, and the operator is the only one who
 * can tell whether that matters.
 */
import React from "react";
import Link from "next/link";

import { AttemptSends } from "@/components/cockpit/agent-visibility/attempt-sends";
import {
  CaptureLine,
  LoadFailureNotice,
  Loading,
  Notice,
} from "@/components/cockpit/agent-visibility/notices";
import { readNodeLastBriefing, type NodeLastBriefing } from "@/lib/agent-visibility/contract";
import { formatMoment } from "@/lib/agent-visibility/format";
import { loadVisibility, type LoadFailure } from "@/lib/agent-visibility/load";
import { nodeAbsenceSentence, runStateSentence } from "@/lib/agent-visibility/wording";
import { apiClient } from "@/lib/api/client";

interface ViewState {
  data: NodeLastBriefing | null;
  /** A read that failed, including an answer this build cannot read: never a
   *  reason a briefing is missing, which only the worker may say. */
  failure: LoadFailure | null;
  loading: boolean;
}

const EMPTY: ViewState = { data: null, failure: null, loading: true };

export function LastBriefingView({
  definitionId,
  nodeId,
  openVersion,
}: {
  definitionId: number;
  nodeId: string;
  /** The deployed version the canvas in front of the operator was opened from,
   *  so the notice below can name both numbers. Null when nothing of this
   *  workflow is deployed, which is also when there is nothing to compare. */
  openVersion?: number | null;
}) {
  const [state, setState] = React.useState<ViewState>(EMPTY);
  // Which send and which section are open. Local, not in the URL: the editor's
  // address bar belongs to the definition being edited, not to a past run.
  const [link, setLink] = React.useState<{ send: string | null; section: string | null }>({
    send: null,
    section: null,
  });
  const keyRef = React.useRef(`${definitionId}|${nodeId}`);

  const load = React.useCallback(async () => {
    const requestKey = `${definitionId}|${nodeId}`;
    const read = await loadVisibility(
      () => apiClient.workflowDefinitions.nodeLastBriefing(definitionId, nodeId),
      readNodeLastBriefing,
    );
    if (keyRef.current !== requestKey) return;
    setState(
      read.ok
        ? { data: read.value, failure: null, loading: false }
        : { data: null, failure: read.failure, loading: false },
    );
  }, [definitionId, nodeId]);

  React.useEffect(() => {
    keyRef.current = `${definitionId}|${nodeId}`;
    setState(EMPTY);
    setLink({ send: null, section: null });
    void load();
  }, [definitionId, nodeId, load]);

  const frame = (children: React.ReactNode) => (
    <div data-last-briefing="true" className="flex min-w-0 flex-col gap-3">
      {children}
    </div>
  );

  if (state.loading) return frame(<Loading label="Loading what this block last sent…" />);
  if (state.failure) {
    return frame(
      <LoadFailureNotice
        failure={state.failure}
        what="What this block last sent"
        onRetry={() => {
          setState(EMPTY);
          void load();
        }}
      />,
    );
  }
  if (state.data === null) return frame(<Loading label="Loading what this block last sent…" />);

  const { ranIn, attempt, absent } = state.data;
  if (ranIn === null) {
    const sentence = nodeAbsenceSentence(absent ?? "never_ran");
    return frame(<Notice title={sentence.title}>{sentence.body}</Notice>);
  }

  const runSentence = ranIn.state === null ? null : runStateSentence(ranIn.state);
  return frame(
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 font-mono text-[10px] leading-[1.5] text-neutral-600">
          {/* The run, and nothing else: the version it ran is a sentence
              below, and saying the number twice two lines apart is noise. */}
          <span className="block break-all text-coal">run {ranIn.runId}</span>
          {ranIn.at ? <span className="block">{formatMoment(ranIn.at)}</span> : null}
        </div>
        {/* A new tab, deliberately: an operator reading this is in the middle
            of an edit, and leaving the editor would put a browser prompt
            between them and their unsaved workflow. The run opens on this
            block, on its Briefing tab, which is what the panel is showing. */}
        <Link
          href={`/trace/${encodeURIComponent(ranIn.runId)}?node=${encodeURIComponent(nodeId)}&tab=briefing`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-mono text-[9px] uppercase tracking-[0.04em] text-mariner underline underline-offset-2"
        >
          Open this run<span aria-hidden="true"> ↗</span>
        </Link>
      </div>
      {/* The operator is looking at a canvas and reading a prompt from a run.
          Which workflow version produced it is the difference between "this is
          what my block sends" and "this is what my block used to send", and
          they should not have to compare two numbers to find out. */}
      {ranIn.definitionVersion === null ? null : (
        <Notice
          title={
            openVersion === null || openVersion === undefined
              ? `This went out from workflow version ${ranIn.definitionVersion}`
              : openVersion === ranIn.definitionVersion
                ? `This went out from workflow version ${ranIn.definitionVersion}, the version this canvas is on`
                : `This went out from workflow version ${ranIn.definitionVersion}, and this canvas is on version ${openVersion}`
          }
        >
          {/* Three states, and "we do not know" is not "they match": a canvas
              whose version this screen was never given must not be told its
              run is current. */}
          {openVersion === null || openVersion === undefined
            ? "The newest run of a block wins whatever version it ran. If this workflow has been edited since, what is below is not what the canvas in front of you would send."
            : openVersion === ranIn.definitionVersion
              ? "So what is below is what this block sent on the version you are editing. Unsaved edits on the canvas are not in it."
              : "The newest run of a block wins whatever version it ran, and this one is not the version in front of you. What is below is not what this canvas would send."}
        </Notice>
      )}
      {ranIn.capture ? <CaptureLine capture={ranIn.capture} /> : null}
      {runSentence ? (
        <Notice tone={runSentence.tone === "lost" ? "lost" : "neutral"} title={runSentence.title}>
          {runSentence.body}
        </Notice>
      ) : null}
      {state.data.sendsPrompts === false ? (
        <Notice title="No prompt goes out from this block">
          Briefings record what a model was sent. This block sends no prompt, so it has none.
        </Notice>
      ) : attempt === null ? (
        <Notice title="This run left no attempt of this block">
          The run above reached this block, and the worker holds no attempt of it to open. Its logs for this run and
          block are the next place to look.
        </Notice>
      ) : attempt.ok ? (
        <AttemptSends
          runId={ranIn.runId}
          attempt={attempt.value}
          send={link.send}
          section={link.section}
          onLinkChange={(patch) => setLink((current) => ({ ...current, ...patch }))}
          runExplained={runSentence !== null}
        />
      ) : (
        <Notice title="This attempt was written by a version this dashboard does not read">
          {attempt.message}
        </Notice>
      )}
    </>,
  );
}
