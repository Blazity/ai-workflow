"use client";

/**
 * A ticket's repository record: which repositories this work may touch, who
 * decided that and why, and every repository question as a round.
 *
 * It belongs to the ticket, not to one run: every run of the ticket reads the
 * same record, and a person answering in Jira wants to see what their last
 * answer did before they write the next one.
 */
import React from "react";

import { useCockpit } from "@/components/cockpit/context";
import { Button, CkChip } from "@/components/ui";
import { apiClient } from "@/lib/api/client";
import { readWorkScopeWithRounds, type WorkScopeEditRead, type WorkScopeRead } from "@/lib/agent-visibility/contract";
import { offeredNotInRecord } from "@/lib/agent-visibility/edit";
import { formatClock, plural } from "@/lib/agent-visibility/format";
import { loadVisibility, type LoadFailure } from "@/lib/agent-visibility/load";
import type { ClarificationRoundHeader } from "@shared/agent-visibility";
import { ticketSubjectKey } from "@shared/contracts";

import { integrationsProviding } from "@integrations/registry";

import { IDLE_POLL_MS, useLivePoll } from "@/lib/use-live-poll";

import { LoadFailureNotice, Loading, Notice } from "./notices";
import { useOnScreen } from "./on-screen";
import { PagedCacheProvider } from "./paged";
import { RecordEditor } from "./record-editor";
import { RoundView } from "./round-view";

/**
 * The subject this panel reads a ticket's record under. The spelling is
 * `ticketSubjectKey` in `@shared/contracts`, the one the worker writes with;
 * what this adds is the provider segment.
 *
 * The provider segment is the tracker's own id, not the word "jira": the
 * worker writes the record under whichever tracker this deployment connected,
 * so a hardcoded segment reads an address nothing was ever written to and the
 * panel shows an empty record instead of the work somebody is looking at.
 * Taken from the build's own integrations when only one serves `issue_tracker`;
 * when multiple trackers ship in the build, an explicit tracker id or full
 * subject key is required so the panel never guesses the first provider.
 */
const TICKET_PROVIDERS = integrationsProviding("issue_tracker").map(
  (integration) => integration.id,
);

export function panelTicketSubjectKey(ticketKey: string, trackerId?: string): string {
  if (ticketKey.startsWith("ticket:")) {
    return ticketKey;
  }
  const provider = trackerId ?? (TICKET_PROVIDERS.length === 1 ? TICKET_PROVIDERS[0] : undefined);
  if (provider === undefined) {
    throw new Error(
      "This build ships more than one issue tracker, so the ticket's subject key cannot be derived from the build alone: pass the run's tracker id into this panel.",
    );
  }
  return ticketSubjectKey(provider, ticketKey);
}

function resolvePanelSubjectKey(
  ticketKey: string,
  trackerId?: string,
  explicitSubjectKey?: string,
): string | null {
  if (explicitSubjectKey && explicitSubjectKey.trim() !== "") {
    return explicitSubjectKey;
  }
  if (ticketKey.startsWith("ticket:")) {
    return ticketKey;
  }
  const provider = trackerId ?? (TICKET_PROVIDERS.length === 1 ? TICKET_PROVIDERS[0] : undefined);
  if (provider === undefined) {
    return null;
  }
  return ticketSubjectKey(provider, ticketKey);
}

function Entries({
  record,
  questionWaiting,
  onRecord,
  onReload,
}: {
  record: WorkScopeRead;
  questionWaiting: boolean;
  onRecord: (scope: WorkScopeEditRead) => void;
  onReload: () => void;
}) {
  if (!record.carriesRecord) {
    return <Notice>This kind of work keeps no repository record, so nothing is decided here.</Notice>;
  }
  const rounds = record.rounds.ok ? record.rounds.value.items : [];
  const offered = offeredNotInRecord(rounds, record.entries);
  if (record.entries.length === 0 && offered.length === 0) {
    return (
      <Notice>
        No repository is decided for this ticket yet. A run that needs one asks, and the answer lands here.
      </Notice>
    );
  }
  return (
    <>
      {record.entries.length === 0 ? (
        <Notice>
          No repository is decided for this ticket yet. A run that needs one asks, and the answer lands here. You can
          also put one in yourself.
        </Notice>
      ) : null}
      <RecordEditor
        record={record}
        offered={offered}
        questionWaiting={questionWaiting}
        onRecord={onRecord}
        onReload={onReload}
      />
    </>
  );
}

function Rounds({ subjectKey, record }: { subjectKey: string; record: WorkScopeRead }) {
  const page = record.rounds.ok ? record.rounds.value : null;
  const rounds: ClarificationRoundHeader[] = page?.items ?? [];
  const pending = rounds.find((round) => round.status === "pending") ?? null;
  const [openRound, setOpenRound] = React.useState<string | null>(null);
  // A question still waiting for an answer is what a person came to read.
  React.useEffect(() => {
    if (pending) setOpenRound((current) => current ?? pending.id);
  }, [pending?.id]);

  if (!record.rounds.ok) {
    return record.rounds.reason === "absent" ? (
      <Notice>
        This worker does not serve repository questions yet, so the rounds of this ticket cannot be shown.
      </Notice>
    ) : (
      <Notice title="The repository questions could not be read">{record.rounds.message}</Notice>
    );
  }
  if (rounds.length === 0) {
    return <Notice>No repository question has been asked on this ticket.</Notice>;
  }
  return (
    <>
      {page && page.unreadable.length > 0 ? (
        <Notice>{plural(page.unreadable.length, "round")} could not be read and is not listed.</Notice>
      ) : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {rounds.map((round) => (
          <RoundView
            key={round.id}
            subjectKey={subjectKey}
            round={round}
            open={openRound === round.id}
            onToggle={() => setOpenRound(openRound === round.id ? null : round.id)}
          />
        ))}
      </ul>
      {page && page.nextCursor !== null ? (
        <p className="m-0 font-body text-[12px] text-neutral-700">
          Showing the first {rounds.length} of {page.total} questions.
        </p>
      ) : null}
    </>
  );
}

export function RepositoriesPanel({
  ticketKey,
  trackerId,
  subjectKey: explicitSubjectKey,
  autoOpen = false,
}: {
  ticketKey: string;
  /** The tracker that owns this ticket, when known by the caller. */
  trackerId?: string;
  /** Optional full subject key. */
  subjectKey?: string;
  /** May open itself when a question is waiting. False on a page opened for
   *  one run: there the trace is what the person came for, and the waiting
   *  chip in this header already carries the news. */
  autoOpen?: boolean;
}) {
  const { issueTrackerId } = useCockpit();
  const subjectKey = resolvePanelSubjectKey(ticketKey, trackerId ?? issueTrackerId, explicitSubjectKey);
  const [toggled, setToggled] = React.useState<boolean | null>(null);
  const [loadedSubjectKey, setLoadedSubjectKey] = React.useState<string | null>(null);
  const [record, setRecord] = React.useState<WorkScopeRead | null>(null);
  const [failure, setFailure] = React.useState<LoadFailure | null>(null);
  const [loading, setLoading] = React.useState(subjectKey !== null);
  const [readAt, setReadAt] = React.useState<Date | null>(null);
  const subjectRef = React.useRef(subjectKey);
  const loadedSubjectRef = React.useRef<string | null>(null);
  // The ticket page mounts this panel twice, once per breakpoint, and hides
  // one: only the twin a person can see is worth a request.
  const frameRef = React.useRef<HTMLElement>(null);
  const onScreen = useOnScreen(frameRef);

  const hasCurrentSubjectState = subjectKey !== null && loadedSubjectKey === subjectKey;
  const activeRecord = hasCurrentSubjectState ? record : null;
  const activeFailure = hasCurrentSubjectState ? failure : null;
  const activeReadAt = hasCurrentSubjectState ? readAt : null;
  const activeLoading = subjectKey !== null && (loading || !hasCurrentSubjectState);

  const load = React.useCallback(async () => {
    subjectRef.current = subjectKey;
    if (subjectKey === null) {
      loadedSubjectRef.current = null;
      setLoadedSubjectKey(null);
      setRecord(null);
      setFailure(null);
      setReadAt(null);
      setLoading(false);
      return;
    }
    if (loadedSubjectRef.current !== subjectKey) {
      setRecord(null);
      setFailure(null);
      setReadAt(null);
    }
    setLoading(true);
    const loaded = await loadVisibility(
      () => apiClient.workScope.get(subjectKey, null, { cache: "no-store" }),
      readWorkScopeWithRounds,
    );
    if (subjectRef.current !== subjectKey) return;
    loadedSubjectRef.current = subjectKey;
    setLoadedSubjectKey(subjectKey);
    setLoading(false);
    setReadAt(new Date());
    if (loaded.ok) {
      setRecord(loaded.value);
      setFailure(null);
      return;
    }
    setFailure(loaded.failure);
  }, [subjectKey]);

  // Loaded even while closed, so the header can say whether a question is
  // waiting without a person opening the panel to find out.
  React.useEffect(() => {
    if (onScreen) void load();
  }, [load, onScreen]);

  const rounds = activeRecord?.rounds.ok ? activeRecord.rounds.value : null;
  const pending = rounds?.items.filter((round) => round.status === "pending").length ?? 0;

  // A person answers in Jira and comes back to this tab. Slow cadence: the
  // answer travels through a webhook and a run, not through this page.
  useLivePoll({
    enabled: onScreen === true && pending > 0 && subjectKey !== null,
    intervalMs: IDLE_POLL_MS,
    onTick: () => void load(),
  });

  // Open without being asked only where the ticket itself is what a person
  // came for, and only when a question is waiting.
  const open = toggled ?? (autoOpen && pending > 0);
  const summary =
    subjectKey === null
      ? "unavailable"
      : activeRecord
    ? `${plural(activeRecord.entries.length, "repository", "repositories")} decided${
        rounds ? `, ${plural(rounds.total, "question")}` : ""
      }`
    : activeLoading
      ? "loading"
      : "could not be loaded";

  return (
    <section ref={frameRef} data-repositories-panel="true" className="rounded-sm border border-neutral-200 bg-panel">
      <Button
        variant="text"
        onClick={() => setToggled(!open)}
        aria-expanded={open}
        className="w-full px-4 py-3 text-left hover:bg-app-bg [&>span]:w-full"
      >
        <span className="flex w-full min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="flex items-baseline gap-2">
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-neutral-700">
              Repositories
            </span>
            <span className="font-display text-[15px] font-medium text-coal">{ticketKey}</span>
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {pending > 0 ? <CkChip tone="awaiting">{plural(pending, "question")} waiting</CkChip> : null}
            <span className="font-body text-[12px] text-neutral-600">{summary}</span>
            {activeReadAt ? (
              <span className="font-mono text-[10px] text-neutral-600">read at {formatClock(activeReadAt)}</span>
            ) : null}
          </span>
        </span>
      </Button>
      {open ? (
        <PagedCacheProvider>
          <div className="flex flex-col gap-4 border-t border-neutral-200 px-4 py-3">
            {subjectKey === null ? (
              <Notice title="The repository record is unavailable">
                The issue tracker for this ticket could not be determined, so its repository record cannot be read.
              </Notice>
            ) : null}
            {subjectKey !== null && activeFailure ? (
              <LoadFailureNotice failure={activeFailure} what="The repository record" onRetry={() => void load()} />
            ) : null}
            {subjectKey !== null && activeLoading && activeRecord === null ? (
              <Loading label="Loading the repository record…" />
            ) : null}
            {subjectKey !== null && activeRecord ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h4 className="m-0 font-display text-[14px] font-semibold text-coal">What is decided</h4>
                    <span className="font-mono text-[10px] text-neutral-600">record version {activeRecord.version}</span>
                  </div>
                  <Entries
                    record={activeRecord}
                    questionWaiting={pending > 0}
                    onRecord={(scope) =>
                      setRecord((current) =>
                        current === null
                          ? current
                          : {
                              ...current,
                              version: scope.version,
                              entries: scope.entries,
                              unreadableEntries: scope.unreadableEntries,
                            },
                      )
                    }
                    onReload={() => void load()}
                  />
                  {activeRecord.unreadableEntries > 0 ? (
                    <Notice>
                      {plural(activeRecord.unreadableEntries, "entry", "entries")} of the record could not be read and is not
                      listed.
                    </Notice>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <h4 className="m-0 font-display text-[14px] font-semibold text-coal">Repository questions</h4>
                  <Rounds subjectKey={subjectKey} record={activeRecord} />
                </div>
              </>
            ) : null}
          </div>
        </PagedCacheProvider>
      ) : null}
    </section>
  );
}
