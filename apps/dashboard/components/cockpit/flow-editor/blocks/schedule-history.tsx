"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ScheduleConfigResponse, ScheduleOccurrenceEntry, ScheduleOccurrenceOutcome } from "@shared/contracts";
import { apiClient } from "@/lib/api/client";
import { ConfigField, webhookActionButtonCls } from "./shared";
import { describeRotationWindow, formatWebhookInstant } from "./webhook-endpoint";
import { SCHEDULE_OUTCOME_MEANING, SCHEDULE_OUTCOME_STYLES, ScheduleNextRunsSection } from "./schedule-preview";
import type { SchedulePreviewState, ScheduleTrustState } from "./schedule-preview";

function schedulePendingChip(occurrence: ScheduleOccurrenceEntry): { label: string; cls: string } {
  if (occurrence.skipReason === "at_capacity") {
    return { label: "waiting", cls: "border-amber-300 bg-amber-50 text-amber-800" };
  }
  if (occurrence.outcome === "error") {
    return { label: "retrying", cls: "border-amber-300 bg-amber-50 text-amber-800" };
  }
  return { label: "pending", cls: "border-neutral-300 bg-off-white text-neutral-700" };
}

/** Escalation thresholds for a pending annotation's copy: past these, "normal
 *  operation" no longer reads true and the copy should point at the logs
 *  instead, since attempt_count is the only thing that distinguishes "waited
 *  once" from "waited a dozen times" (see occurrence-store.ts's own note on
 *  it). Capacity waits are routine under load, so its floor is higher than a
 *  dispatch error's, which is worth a look sooner. */
const SCHEDULE_CAPACITY_ESCALATION_ATTEMPTS = 5;
const SCHEDULE_ERROR_ESCALATION_ATTEMPTS = 3;

function schedulePendingMeaning(occurrence: ScheduleOccurrenceEntry): string {
  const attempts = occurrence.attemptCount;
  const attemptSuffix = attempts > 1 ? `, attempt ${attempts}` : "";
  if (occurrence.skipReason === "at_capacity") {
    if (attempts > SCHEDULE_CAPACITY_ESCALATION_ATTEMPTS) {
      return `Waiting for capacity${attemptSuffix}. That is far more attempts than a normal wait: check the worker logs for this schedule.`;
    }
    return `Waiting for capacity${attemptSuffix}. The run pool is shared with the ticket queue, so this is expected under load.`;
  }
  if (occurrence.outcome === "error") {
    if (attempts > SCHEDULE_ERROR_ESCALATION_ATTEMPTS) {
      return `A dispatch attempt failed and will be retried${attemptSuffix}. Repeated failures are worth checking the worker logs for.`;
    }
    return `A dispatch attempt failed and will be retried${attemptSuffix}.`;
  }
  return "Admitted, waiting to be dispatched.";
}

/** The wording for a settled occurrence, which for skipped_overlap depends on
 *  what actually blocked it. The ledger has two producers of that outcome and
 *  they mean different things: the dispatcher settles an occurrence whose
 *  subject a started run holds, naming that run, while acceptOccurrence inserts
 *  an occurrence already settled behind one that was merely still waiting, with
 *  no run to name. Telling an operator "the previous run was still going" for
 *  the second sends them looking for a run that never existed, in the one panel
 *  they open to find out what went wrong. */
function scheduleOutcomeMeaning(occurrence: ScheduleOccurrenceEntry): string {
  if (
    occurrence.outcome === "cancelled" &&
    occurrence.skipReason !== null &&
    occurrence.skipReason !== ""
  ) {
    return occurrence.skipReason;
  }
  if (occurrence.outcome === "skipped_overlap" && occurrence.blockingRunId === null) {
    // A third producer, and the reason column is the only thing that separates
    // it: the dispatcher settles an occurrence its trigger's rate limit refused,
    // which has nothing to do with overlap. Saying "another occurrence was
    // waiting" here would send the operator hunting for a queue that is empty.
    if (occurrence.skipReason === "rate_limited") {
      return "Skipped because this trigger's rate limit for the current window was already spent. This occurrence will not run and will not be replayed; the trigger's rejection counter above records it.";
    }
    return "Skipped because another occurrence of this schedule was already waiting its turn. This occurrence will not run and will not be replayed.";
  }
  return SCHEDULE_OUTCOME_MEANING[occurrence.outcome ?? "error"];
}

/** Human labels for a settled outcome's chip, so an operator never has to read
 *  a raw enum value next to a pending row's already-human "waiting" or
 *  "retrying". Deliberately short: the sentence below each chip carries the
 *  actual meaning. */
const SCHEDULE_OUTCOME_CHIP_LABELS: Record<ScheduleOccurrenceOutcome, string> = {
  started: "started",
  skipped_overlap: "skipped",
  skipped_stale: "skipped",
  superseded: "replaced",
  cancelled: "cancelled",
  run_cancelled: "run cancelled",
  expired: "abandoned",
  error: "failed",
};

/** How many of this schedule's own periods "Last run" may age past before it
 *  is highlighted rather than read as routine. A daily schedule silent for
 *  three days is exactly the state that must not look healthy. */
const SCHEDULE_STALE_LAST_RUN_PERIODS = 3;

/** Pure rendering of the occurrence ledger, mirroring WebhookDeliveriesSection:
 *  instant, outcome chip, its meaning, and whatever detail that outcome
 *  carries. A skip shows the run blocking it, so an operator can see which run
 *  is holding the schedule; a started occurrence links its run; a non-zero
 *  dropped_count is always shown, since silently dropping a backlog is exactly
 *  what this ledger exists to make visible, and a capped count reads "at least
 *  N" rather than a bare N, since the evaluator deliberately stopped counting
 *  past its cap and the UI must not invent the precision back. There is no raw
 *  skipReason paragraph: for a settled row it duplicates the meaning sentence
 *  above it without adding anything, and for a pending one it is already
 *  folded into that sentence ("waiting for capacity", "will be retried").
 *
 * lastRun renders last_started_occurrence_at and last_started_run_id from the
 * schedule row, never the evaluation watermark (an internal engine cursor):
 * those two are the only pair that survive the ledger's retention window, so
 * they are what "last run" stands on. Its age is relative and highlighted
 * once it passes a few of the schedule's own periods, so "three minutes ago"
 * and "three weeks ago" cannot read identically; periodMs is null (and the
 * highlight never fires) when there is nothing to compare the age against. */
function ScheduleOccurrenceHistorySection({
  lastRun,
  now,
  periodMs,
  occurrences,
  loading,
  error,
  onRefresh,
}: {
  lastRun: { occurrenceAt: string; runId: string } | null;
  now: number;
  periodMs: number | null;
  occurrences: readonly ScheduleOccurrenceEntry[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const lastRunAgeMs = lastRun ? now - new Date(lastRun.occurrenceAt).getTime() : null;
  const lastRunIsStale =
    lastRunAgeMs !== null &&
    periodMs !== null &&
    lastRunAgeMs > periodMs * SCHEDULE_STALE_LAST_RUN_PERIODS;
  const startedCount = occurrences.filter((occurrence) => occurrence.outcome === "started").length;

  return (
    <ConfigField
      label="Recent occurrences"
      action={
        <button
          type="button"
          disabled={loading}
          onClick={onRefresh}
          className={webhookActionButtonCls}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      }
    >
      <div
        className={`mb-1 font-body text-[11px] leading-[1.4] ${lastRunIsStale ? "text-amber-800" : "text-neutral-600"}`}
      >
        {lastRun ? (
          <>
            Last run {formatWebhookInstant(lastRun.occurrenceAt)} (
            {describeRotationWindow(lastRun.occurrenceAt, now)}){" · "}
            <Link
              href={`/trace/${encodeURIComponent(lastRun.runId)}`}
              className="text-mariner underline"
            >
              run {lastRun.runId}
            </Link>
            {lastRunIsStale && ", well past this schedule's usual period"}
          </>
        ) : (
          "No run yet."
        )}
      </div>
      {occurrences.length > 0 && (
        <div className="mb-1.5 font-body text-[11px] leading-[1.4] text-neutral-600">
          {startedCount} of {occurrences.length} recent occurrence{occurrences.length === 1 ? "" : "s"}{" "}
          started.
        </div>
      )}
      {error !== null ? (
        <div role="alert" className="font-body text-xs leading-[1.5] text-red-700">
          {error}
        </div>
      ) : occurrences.length === 0 ? (
        <div className="font-body text-xs leading-[1.5] text-neutral-600">
          {loading ? "Loading occurrences…" : "No occurrences yet."}
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {occurrences.map((occurrence) => {
            const pendingChip = occurrence.pending ? schedulePendingChip(occurrence) : null;
            const chipLabel = pendingChip
              ? pendingChip.label
              : SCHEDULE_OUTCOME_CHIP_LABELS[occurrence.outcome ?? "error"];
            const chipCls = pendingChip
              ? pendingChip.cls
              : SCHEDULE_OUTCOME_STYLES[occurrence.outcome ?? "error"];
            const meaning = occurrence.pending
              ? schedulePendingMeaning(occurrence)
              : scheduleOutcomeMeaning(occurrence);
            return (
              <li
                key={occurrence.occurrenceAt}
                className="rounded-xs border border-neutral-200 bg-off-white px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`rounded-xs border px-1 py-px font-mono text-[8px] uppercase tracking-[0.04em] ${chipCls}`}
                  >
                    {chipLabel}
                  </span>
                  <span className="font-mono text-[9px] text-neutral-600">
                    {formatWebhookInstant(occurrence.occurrenceAt)}
                  </span>
                </div>
                <div className="mt-0.5 font-body text-[11px] leading-[1.4] text-neutral-700">
                  {meaning}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1 break-all font-mono text-[9px] text-neutral-500">
                  {occurrence.runId !== null && (
                    <Link href={`/trace/${encodeURIComponent(occurrence.runId)}`} className="text-mariner underline">
                      run {occurrence.runId}
                    </Link>
                  )}
                  {occurrence.blockingRunId !== null && (
                    <span>
                      blocked by{" "}
                      <Link
                        href={`/trace/${encodeURIComponent(occurrence.blockingRunId)}`}
                        className="text-mariner underline"
                      >
                        run {occurrence.blockingRunId}
                      </Link>
                    </span>
                  )}
                  {occurrence.droppedCount > 0 && (
                    <span>
                      dropped {occurrence.droppedCountCapped ? "at least " : ""}
                      {occurrence.droppedCount} earlier occurrence
                      {occurrence.droppedCount === 1 ? "" : "s"}
                    </span>
                  )}
                  {!occurrence.pending && occurrence.attemptCount > 1 && (
                    <span>{occurrence.attemptCount} attempts</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </ConfigField>
  );
}

/** Server-owned half of the schedule inspector: status, pause/resume, and the
 *  occurrence ledger. It fetches config.get once per definition and node,
 *  mutations are explicit clicks, and it never carries its own cron logic, the
 *  live preview it renders (via ScheduleNextRunsSection) is computed by the
 *  parent from the worker's preview route. Pause and Resume are reachable
 *  through every state this panel can be in, including a failed config load:
 *  an operator reaching for the emergency stop during an incident must not
 *  find it gone because a GET failed. */
export function ScheduleStatusPanel({
  definitionId,
  nodeId,
  canEdit,
  draftCron,
  draftTimezone,
  preview,
  requestKey,
}: {
  definitionId: number | undefined;
  nodeId: string;
  canEdit: boolean;
  draftCron: string;
  draftTimezone: string;
  preview: SchedulePreviewState;
  requestKey: string;
}) {
  const [config, setConfig] = useState<ScheduleConfigResponse | null>(null);
  const [loading, setLoading] = useState(definitionId !== undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    if (definitionId === undefined) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await apiClient.triggers.scheduleConfig(
        definitionId,
        nodeId,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(response.errorMessage);
      setConfig(response.data);
    } catch (caught) {
      setConfig(null);
      setLoadError(
        caught instanceof Error ? caught.message : "Unable to load this schedule.",
      );
    } finally {
      setLoading(false);
    }
  }, [definitionId, nodeId]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  async function run(action: "pause" | "resume") {
    if (definitionId === undefined) return;
    setBusy(true);
    setActionError(null);
    try {
      const response = action === "pause"
        ? await apiClient.triggers.schedulePause(definitionId, nodeId, {
            cache: "no-store",
          })
        : await apiClient.triggers.scheduleResume(definitionId, nodeId, {
            cache: "no-store",
          });
      if (response.status === 403) {
        // readErrorMessage would otherwise surface whatever the proxy's own
        // 403 body happens to contain, which is not guaranteed to mention
        // permissions at all: name the reason directly instead.
        setActionError("You do not have permission to pause or resume this schedule.");
        return;
      }
      if (!response.ok) throw new Error(response.errorMessage);
      await loadConfig();
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "This action did not go through.",
      );
    } finally {
      setBusy(false);
    }
  }

  function requestCancelRun() {
    setActionError(null);
    setCancelNotice(null);
    setCancelConfirmOpen(true);
  }

  function dismissCancelRun() {
    // Clear the last attempt's feedback too, mirroring requestCancelRun: backing
    // out of an unconfirmed/failed cancel must not leave a stale banner with
    // nothing left to retry.
    setActionError(null);
    setCancelNotice(null);
    setCancelConfirmOpen(false);
  }

  // Success here is decided by switching on `outcome`, never on response.ok:
  // already_terminal is still a 200, and it must not read as a fresh cancel
  // just because the request went through.
  async function cancelRun() {
    const runId = config?.schedule?.lastStartedRunId;
    if (!runId) return;
    setBusy(true);
    setActionError(null);
    setCancelNotice(null);
    try {
      const response = await apiClient.runs.cancel(runId, { cache: "no-store" });
      if (response.status === 403) {
        setActionError("You do not have permission to cancel this run.");
        return;
      }
      if (response.status === 404) {
        setActionError("This run could not be found.");
        return;
      }
      // 409 still carries a typed body ({ outcome: "unconfirmed" }), so it must
      // reach the switch below rather than being thrown here as a generic
      // failure.
      if (!response.ok) throw new Error(response.errorMessage);
      const body = response.data;
      switch (body.outcome) {
        case "cancelled":
          setCancelNotice("Run cancelled. The schedule starts clean at its next occurrence.");
          setCancelConfirmOpen(false);
          await loadConfig();
          break;
        case "already_terminal":
          setCancelNotice("This run already ended, nothing to cancel.");
          setCancelConfirmOpen(false);
          await loadConfig();
          break;
        case "unconfirmed":
          setActionError("The cancel could not be confirmed. Try again.");
          break;
      }
    } catch (caught) {
      setActionError(
        caught instanceof Error ? caught.message : "This action did not go through.",
      );
    } finally {
      setBusy(false);
    }
  }

  const trustState: ScheduleTrustState =
    loadError !== null ? "load_error" : config === null ? "loading" : config.state;
  const live = config !== null && config.state !== "draft";
  // The server's clock, not the browser's: a staleness read must not depend
  // on whether the operator's laptop is off by a few minutes, which is
  // exactly the state this whole feature exists to report truthfully. Only
  // falls back to the local clock before the first response ever lands.
  const now = config?.schedule?.serverNow ? new Date(config.schedule.serverNow).getTime() : Date.now();
  // This schedule's own period, from the live preview's first two occurrences,
  // so "Last run" can be judged against it rather than an arbitrary constant.
  const periodMs =
    preview.status === "ok" && preview.runs.length >= 2
      ? new Date(preview.runs[1]!).getTime() - new Date(preview.runs[0]!).getTime()
      : null;

  return (
    <>
      <ScheduleNextRunsSection
        trustState={trustState}
        schedule={config?.schedule ?? null}
        preview={preview}
        requestKey={requestKey}
        draftCron={draftCron}
        draftTimezone={draftTimezone}
        now={now}
        canEdit={canEdit}
        busy={busy}
        actionError={actionError}
        loadErrorMessage={loadError}
        cancelConfirmOpen={cancelConfirmOpen}
        cancelNotice={cancelNotice}
        onPause={() => void run("pause")}
        onResume={() => void run("resume")}
        onReload={() => void loadConfig()}
        onCancelRequest={requestCancelRun}
        onCancelConfirm={() => void cancelRun()}
        onCancelDismiss={dismissCancelRun}
      />
      {live && (
        <ScheduleOccurrenceHistorySection
          lastRun={
            config?.schedule?.lastStartedOccurrenceAt && config.schedule.lastStartedRunId
              ? {
                  occurrenceAt: config.schedule.lastStartedOccurrenceAt,
                  runId: config.schedule.lastStartedRunId,
                }
              : null
          }
          now={now}
          periodMs={periodMs}
          occurrences={config?.occurrences ?? []}
          loading={loading}
          error={null}
          onRefresh={() => void loadConfig()}
        />
      )}
    </>
  );
}

const scheduleHistoryCompatibility = { ScheduleOccurrenceHistorySection };

export default scheduleHistoryCompatibility;
