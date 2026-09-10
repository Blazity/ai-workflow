"use client";

import type { ScheduleEvaluationState, ScheduleOccurrenceOutcome, ScheduleOverlapPolicy, ScheduleStatus, ScheduleWeekday } from "@shared/contracts";
import { ConfigField, webhookActionButtonCls, webhookBannerCls, webhookDangerButtonCls } from "./shared";
import { describeRotationWindow, formatWebhookInstant } from "./webhook-endpoint";

export const SCHEDULE_PRESET_KIND_OPTIONS = [
  { value: "every-n-minutes", label: "Every N minutes" },
  { value: "every-n-hours", label: "Every N hours" },
  { value: "daily", label: "Daily at a time" },
  { value: "weekly", label: "Weekly on chosen days" },
];

/** Step choices the preset builder offers. Duplicated from occurrence.ts's own
 *  EVERY_N_MINUTES_STEPS / EVERY_N_HOURS_STEPS rather than imported: the worker
 *  and the dashboard are different packages and this feature must not add a
 *  cron library here to bridge them. Both lists are divisors of an hour or a
 *  day (a fixed mathematical fact, not configuration) and compileSchedulePreset
 *  is still the sole authority that validates a step, this is only display. */
export const SCHEDULE_EVERY_N_MINUTES_STEPS = [15, 20, 30, 60] as const;
export const SCHEDULE_EVERY_N_HOURS_STEPS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

const SCHEDULE_WEEKDAYS: readonly { value: ScheduleWeekday; label: string }[] = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

export const SCHEDULE_OVERLAP_POLICY_OPTIONS: { value: ScheduleOverlapPolicy; label: string }[] = [
  { value: "skip", label: "Skip" },
  { value: "queue", label: "Queue (keep newest)" },
  { value: "allow", label: "Allow concurrent" },
];

export const scheduleModeToggleCls = "appearance-none rounded-xs border border-neutral-200 bg-panel px-2 py-1 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-600 disabled:opacity-40";

export const SCHEDULE_OUTCOME_STYLES: Record<ScheduleOccurrenceOutcome, string> = {
  started: "border-green-300 bg-green-50 text-green-800",
  skipped_overlap: "border-amber-300 bg-amber-50 text-amber-800",
  skipped_stale: "border-amber-300 bg-amber-50 text-amber-800",
  superseded: "border-mariner-200 bg-mariner-100 text-mariner",
  cancelled: "border-neutral-300 bg-off-white text-neutral-700",
  run_cancelled: "border-neutral-300 bg-neutral-100 text-neutral-800",
  expired: "border-red-300 bg-red-50 text-red-700",
  error: "border-red-300 bg-red-50 text-red-700",
};

/** One line per outcome, so an operator reads what happened without cross
 *  referencing the worker. There is no "skipped_capacity" entry: being at
 *  capacity is not a decision about an occurrence, it stays pending and
 *  carries the reason as an annotation instead (rendered from skipReason). */
export const SCHEDULE_OUTCOME_MEANING: Record<ScheduleOccurrenceOutcome, string> = {
  started: "A run started for this occurrence.",
  skipped_overlap:
    "Skipped because the previous run of this schedule was still going. This occurrence will not run and will not be replayed.",
  skipped_stale:
    "Skipped because it was too late past its catch-up grace. This occurrence will not run and will not be replayed.",
  superseded:
    "Replaced by a newer occurrence while it waited: the queue policy keeps only the newest. This occurrence will not run and will not be replayed.",
  cancelled:
    "Cancelled because the schedule was paused while this occurrence was still waiting. It will not run.",
  run_cancelled:
    "Cancelled by an operator while its run was in progress. The run was stopped, and the schedule resumes at the next occurrence.",
  expired: "Abandoned: it waited too long and nothing ever dispatched it.",
  error: "The dispatch attempt for this occurrence failed.",
};

export function ScheduleWeekdayToggles({
  value,
  disabled,
  onChange,
}: {
  value: readonly ScheduleWeekday[];
  disabled: boolean;
  onChange: (value: ScheduleWeekday[]) => void;
}) {
  return (
    <div role="group" aria-label="Weekdays" className="flex items-center gap-1">
      {SCHEDULE_WEEKDAYS.map(({ value: day, label }) => {
        const active = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() =>
              onChange(
                active
                  ? value.filter((d) => d !== day)
                  : [...value, day].sort((a, b) => a - b),
              )
            }
            className={`rounded-xs border px-1.5 py-1 font-mono text-[9px] uppercase tracking-[0.04em] disabled:opacity-40 ${
              active
                ? "border-mariner bg-mariner-100 text-mariner"
                : "border-neutral-200 bg-panel text-neutral-600"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export type SchedulePreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ok";
      cron: string;
      timezone: string;
      runs: string[];
      requestKey: string;
      suggestedGraceMinutes: number | null;
    };

/** Renders the computed next-occurrence list, or whatever state the preview is
 *  in. Pure: every branch is a direct function of `preview`, so it is testable
 *  without a fetch. formatWebhookInstant and describeRotationWindow are reused
 *  rather than a second formatter, exactly as the webhook trigger does it. */
/** Shared by every trustState branch below: a validation error must stay
 *  visible no matter what the scheduler is doing. The natural fix loop is
 *  pause, correct the expression, resume, and that loop needs the error
 *  visible in exactly the states that used to hide it: not_evaluated is the
 *  permanent condition of every non-production environment, so hiding
 *  validation there meant the editor was permanently blind to it off
 *  production. */
function SchedulePreviewErrorBanner({ preview }: { preview: SchedulePreviewState }) {
  if (preview.status !== "error") return null;
  return (
    <div role="alert" className="font-body text-xs leading-[1.5] text-red-700">
      {preview.message}
    </div>
  );
}

/** Renders the computed next-occurrence list, or whatever state the preview is
 *  in. Pure: every branch is a direct function of `preview`, so it is testable
 *  without a fetch. formatWebhookInstant and describeRotationWindow are reused
 *  rather than a second formatter, exactly as the webhook trigger does it.
 *
 * `requestKey` is the CURRENT effective request, cron/timezone/preset as they
 * stand right now. When it does not match the request `preview` was computed
 * for, a field changed after the debounce fired and a fresh answer is already
 * in flight, so the numbers on screen are marked stale rather than presented
 * with the same confidence as a fresh answer. */
function renderSchedulePreviewBody(
  preview: SchedulePreviewState,
  requestKey: string,
  now: number,
) {
  if (preview.status === "error") return <SchedulePreviewErrorBanner preview={preview} />;
  if (preview.status !== "ok") {
    return (
      <div className="font-body text-xs leading-[1.5] text-neutral-600">
        {preview.status === "loading" ? "Computing…" : "Enter a schedule to preview it."}
      </div>
    );
  }
  const stale = preview.requestKey !== requestKey;
  if (preview.runs.length === 0) {
    return (
      <div className="font-body text-xs leading-[1.5] text-neutral-600">
        This expression has no upcoming occurrences.
        {stale && " Recalculating for the latest change…"}
      </div>
    );
  }
  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {preview.runs.map((run, index) => (
          <li key={run} className="font-mono text-[11px] text-coal">
            {formatWebhookInstant(run)}
            {index === 0 && (
              <span className="ml-1.5 font-body text-[10px] text-neutral-500">
                ({describeRotationWindow(run, now)})
              </span>
            )}
          </li>
        ))}
      </ul>
      {stale && (
        <div className="mt-1 font-body text-[10px] text-neutral-500">
          Recalculating for the latest change…
        </div>
      )}
    </>
  );
}

/** Two purely client-side states occurrence.ts's ScheduleEvaluationState does
 *  not need to know about, since neither is a fact about the schedule itself:
 *  the status fetch has not resolved yet ("loading"), or it failed and the
 *  operator must still be able to act through that failure ("load_error"). A
 *  fetch in flight must never be presented as "not deployed", and a fetch
 *  that failed must never take Pause and Resume off the screen. */
export type ScheduleTrustState = "loading" | "load_error" | ScheduleEvaluationState;

/**
 * The next-occurrences panel, merged with the scheduler's trust state on
 * purpose: requirement is to REPLACE the preview with a warning once the
 * scheduler stops evaluating, not to show both side by side where a confident
 * timestamp list could sit next to a warning and still read as "probably
 * fine". Seven branches, one per state the editor must make unmistakable:
 *   - "loading": the status fetch has not resolved yet. Says so plainly and
 *     offers nothing else: not a draft, not an error, just not answered yet.
 *   - "load_error": the fetch failed. Pause and Resume must still work,
 *     because an operator reaching for the emergency stop during an incident
 *     must not find it gone because a GET failed.
 *   - "draft": not deployed, the preview below is what it WOULD run.
 *   - "evaluating": deployed and healthy, the preview is what it WILL run
 *     from the configuration below; when that configuration differs from
 *     what is actually deployed, a note names the deployed expression too.
 *   - "not_evaluated": deployed but the scheduler has never looked at it or
 *     has stopped, no confident timestamps are shown at all.
 *   - "paused": deliberately not producing occurrences, no timestamps either.
 *   - "revoked": the block is not in the deployed head at all, so nothing is
 *     even trying. Not a failure and must not read as one: the fix is
 *     restoring the block and deploying, which resyncSchedule then clears on
 *     its own, so this state offers a Refresh, never a Pause or a Resume.
 *
 * A validation error from `preview` is shown in every branch, not only the
 * two that already render the preview body: not_evaluated is the permanent
 * condition of every non-production environment, so hiding it there left the
 * pause-fix-resume loop blind everywhere that is not production.
 */
const SCHEDULE_PAUSE_CANCELS_NOTE =
  "Also cancels an occurrence that is already waiting, not just future ones.";
export function ScheduleNextRunsSection({
  trustState,
  schedule,
  preview,
  requestKey,
  draftCron,
  draftTimezone,
  now,
  canEdit,
  busy,
  actionError,
  loadErrorMessage,
  cancelConfirmOpen,
  cancelNotice,
  onPause,
  onResume,
  onReload,
  onCancelRequest,
  onCancelConfirm,
  onCancelDismiss,
}: {
  trustState: ScheduleTrustState;
  schedule: ScheduleStatus | null;
  preview: SchedulePreviewState;
  requestKey: string;
  draftCron: string;
  draftTimezone: string;
  now: number;
  canEdit: boolean;
  busy: boolean;
  actionError: string | null;
  loadErrorMessage: string | null;
  /** Whether the "cancel current run" confirm step is open. There is no live
   *  signal for whether lastStartedRunId is still actually running (see the
   *  block comment on ScheduleStatusPanel), so this only ever gates a second
   *  click, never a claim that a run is in flight. */
  cancelConfirmOpen: boolean;
  /** Result of the last cancel attempt, cleared on the next request. Distinct
   *  from actionError: a cancelled or already_terminal outcome is not a
   *  failure, so it must not render in the same red as one. */
  cancelNotice: string | null;
  onPause: () => void;
  onResume: () => void;
  onReload: () => void;
  onCancelRequest: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
}) {
  if (trustState === "loading") {
    return (
      <ConfigField label="Next occurrences">
        <div className="font-body text-xs leading-[1.5] text-neutral-600">
          Loading schedule status…
        </div>
      </ConfigField>
    );
  }

  if (trustState === "load_error") {
    return (
      <>
        <div role="alert" className={`${webhookBannerCls} bg-red-50 text-red-700`}>
          Unable to load this schedule's status{loadErrorMessage ? `: ${loadErrorMessage}` : "."} Pause
          and Resume still work below: stopping or restarting a schedule must not depend on this read
          succeeding, especially during the kind of incident that makes you reach for them.
        </div>
        <SchedulePreviewErrorBanner preview={preview} />
        {actionError !== null && (
          <div role="alert" className={`${webhookBannerCls} bg-red-50 text-red-700`}>
            {actionError}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 py-2.5 px-[14px] border-b border-neutral-200">
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={onPause}
            className={webhookDangerButtonCls}
          >
            Pause
          </button>
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={onResume}
            className={webhookActionButtonCls}
          >
            Resume
          </button>
          <button type="button" onClick={onReload} className={webhookActionButtonCls}>
            Retry
          </button>
        </div>
      </>
    );
  }

  if (trustState === "not_evaluated") {
    return (
      <>
        <div role="alert" className={`${webhookBannerCls} bg-amber-50 text-amber-800`}>
          {schedule?.lastEvaluatedAt
            ? `The scheduler has not evaluated this schedule in this environment since ${formatWebhookInstant(schedule.lastEvaluatedAt)}. `
            : "The scheduler has never evaluated this schedule in this environment. "}
          The platform cron that drives it only runs on production deployments, so on
          any other environment it may never fire.
        </div>
        <SchedulePreviewErrorBanner preview={preview} />
        {actionError !== null && (
          <div role="alert" className={`${webhookBannerCls} bg-red-50 text-red-700`}>
            {actionError}
          </div>
        )}
        <div className="flex items-center gap-1.5 py-2.5 px-[14px] border-b border-neutral-200">
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={onPause}
            className={webhookDangerButtonCls}
          >
            Pause
          </button>
          <span className="font-body text-[10px] text-neutral-500">{SCHEDULE_PAUSE_CANCELS_NOTE}</span>
        </div>
      </>
    );
  }

  if (trustState === "revoked") {
    return (
      <>
        <div role="status" className={`${webhookBannerCls} bg-off-white text-neutral-700`}>
          This block's schedule is revoked because the block is not in the deployed
          workflow. It is not a failure and nothing is trying to run it: restore the
          block and deploy to pick the schedule back up automatically, paused if it
          was paused before.
        </div>
        <SchedulePreviewErrorBanner preview={preview} />
        <div className="flex items-center gap-1.5 py-2.5 px-[14px] border-b border-neutral-200">
          <button type="button" onClick={onReload} className={webhookActionButtonCls}>
            Refresh
          </button>
        </div>
      </>
    );
  }

  if (trustState === "paused") {
    return (
      <>
        <div role="status" className={`${webhookBannerCls} bg-off-white text-neutral-700`}>
          Paused{schedule?.pausedAt ? ` since ${formatWebhookInstant(schedule.pausedAt)}` : ""}.
          No occurrence runs while paused. Resuming does not replay the whole time
          it was paused: only an occurrence that still falls inside the schedule's
          catch-up grace is caught up, anything older is skipped as stale, the same
          as after a scheduler outage of that length.
        </div>
        <SchedulePreviewErrorBanner preview={preview} />
        {actionError !== null && (
          <div role="alert" className={`${webhookBannerCls} bg-red-50 text-red-700`}>
            {actionError}
          </div>
        )}
        <div className="flex items-center gap-1.5 py-2.5 px-[14px] border-b border-neutral-200">
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={onResume}
            className={webhookActionButtonCls}
          >
            Resume
          </button>
        </div>
      </>
    );
  }

  const deploymentDiffers =
    trustState === "evaluating" &&
    schedule !== null &&
    (schedule.cron !== draftCron || schedule.timezone !== draftTimezone);

  return (
    <ConfigField
      label="Next occurrences"
      action={
        <button type="button" onClick={onReload} className={webhookActionButtonCls}>
          Refresh
        </button>
      }
    >
      {trustState === "draft" && (
        <div className="mb-1 font-body text-[11px] leading-[1.4] text-neutral-600">
          This schedule is not deployed yet. Deploy the workflow, then Refresh, to see
          its live status. Meanwhile, here is what the configuration below would run:
        </div>
      )}
      {deploymentDiffers && schedule !== null && (
        <div className="mb-1 font-body text-[11px] leading-[1.4] text-neutral-600">
          This preview reflects the configuration below, which differs from what
          is deployed. The live block still runs{" "}
          <span className="font-mono">{schedule.cron}</span> in {schedule.timezone}
          {" "}until you deploy this change.
        </div>
      )}
      {renderSchedulePreviewBody(preview, requestKey, now)}
      {trustState === "evaluating" && schedule?.lastEvaluatedAt && (
        <div className="mt-1 font-mono text-[9px] text-neutral-500">
          Scheduler last checked {formatWebhookInstant(schedule.lastEvaluatedAt)}.
        </div>
      )}
      {actionError !== null && (
        <div role="alert" className="mt-1 font-body text-[11px] leading-[1.5] text-red-700">
          {actionError}
        </div>
      )}
      {trustState === "evaluating" && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            disabled={!canEdit || busy}
            onClick={onPause}
            className={webhookDangerButtonCls}
          >
            Pause
          </button>
          <span className="font-body text-[10px] text-neutral-500">{SCHEDULE_PAUSE_CANCELS_NOTE}</span>
        </div>
      )}
      {/* lastStartedRunId is the schedule's last-started run, kept in the ledger
       *  forever, not a live "still running" flag: there is no such signal on
       *  ScheduleStatus. So this control is offered whenever one exists, and a
       *  stale click (the run already finished) is answered honestly by the
       *  endpoint's already_terminal outcome below rather than guessed at here. */}
      {trustState === "evaluating" && schedule?.lastStartedRunId && (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {cancelConfirmOpen ? (
            <div className="flex flex-col gap-1.5 rounded-xs border border-neutral-200 bg-off-white p-2">
              <p className="m-0 font-body text-xs leading-[1.5] text-neutral-700">
                Cancels run {schedule.lastStartedRunId} if it is still running: the
                subject is released and this occurrence settles as run cancelled.
                The schedule keeps running, starting clean at its next occurrence.
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onCancelConfirm}
                  className={webhookDangerButtonCls}
                >
                  {busy ? "Working…" : "Cancel this run"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onCancelDismiss}
                  className="appearance-none border-none bg-transparent p-0 font-mono text-[9px] uppercase tracking-[0.04em] text-neutral-600 disabled:opacity-40"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={!canEdit || busy}
              onClick={onCancelRequest}
              className={`${webhookDangerButtonCls} self-start`}
            >
              Cancel current run
            </button>
          )}
          {cancelNotice !== null && (
            <div role="status" className="font-body text-[11px] leading-[1.5] text-neutral-700">
              {cancelNotice}
            </div>
          )}
        </div>
      )}
    </ConfigField>
  );
}

/** A pending row may carry an annotation about why it has not run yet instead
 *  of a decision: none (freshly admitted), "at_capacity" (the shared run pool
 *  is full, recordOccurrenceAtCapacity), or a failed attempt (outcome "error"
 *  while still pending, so the drain will retry it). None of these settle the
 *  occurrence, which is why they render neutral or warning, never the
 *  error-red a genuinely settled outcome gets: waiting for capacity is normal
 *  operation, since the run pool is shared with the human ticket queue. */
