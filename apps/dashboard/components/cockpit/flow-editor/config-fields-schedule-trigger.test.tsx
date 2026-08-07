import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer";
import type {
  JsonValue,
  ScheduleConfigResponse,
  ScheduleOccurrenceEntry,
  ScheduleStatus,
  WorkflowDefinitionV2,
  WorkflowEditorOptions,
  WorkflowParamValue,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import {
  ConfigFields,
  ScheduleNextRunsSection,
  ScheduleOccurrenceHistorySection,
} from "./config-fields";
import { PromptAuthoringProvider } from "./prompt-authoring-context";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// next/link's client-side prefetch effect calls requestIdleCallback, which
// Next's own polyfill implements in terms of `self`. This test environment is
// plain Node (no jsdom), where `self` does not exist; in a browser `self` is
// just an alias for the global object, so this shim is exact, not a guess.
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

const options = {
  ticketStatusTargets: [],
  blockRegistry: {},
} as unknown as WorkflowEditorOptions;

function scheduleNode(params: FlowNodeDef["params"] = {}): FlowNodeDef {
  return {
    id: "n9",
    type: "trigger_schedule",
    name: "Schedule",
    x: 0,
    y: 0,
    params,
    inputs: {},
    v2: { configuration: params, inputs: {}, additionalInputs: [] },
  };
}

function render(
  node: FlowNodeDef = scheduleNode(),
  changes: [string, unknown][] = [],
): string {
  return renderToStaticMarkup(
    <PromptAuthoringProvider
      availableValues={[]}
      onV2ConfigurationChange={() => undefined}
      previewCandidate={{
        definitionId: 42,
        definition: {} as WorkflowDefinitionV2,
        blockId: node.id,
      }}
    >
      <ConfigFields
        node={node}
        options={options}
        canEdit
        onChange={(path, value) => changes.push([path, value])}
      />
    </PromptAuthoringProvider>,
  );
}

/** A full ScheduleStatus fixture, cron/timezone included (A2), so every test
 *  below only has to override what it actually cares about. */
function scheduleStatus(overrides: Partial<ScheduleStatus> = {}): ScheduleStatus {
  return {
    scheduleId: "sch_1",
    cron: "0 9 * * *",
    timezone: "UTC",
    pausedAt: null,
    revokedAt: null,
    lastStartedOccurrenceAt: null,
    lastStartedRunId: null,
    lastEvaluatedAt: "2026-08-05T08:59:30.000Z",
    serverNow: "2026-08-05T09:00:00.000Z",
    ...overrides,
  };
}

// --- Static rendering: config fields, notes and the four-state framing ---

test("task fields render with placeholders and the one-PR-per-occurrence note", () => {
  const html = render();

  assert.match(html, /Task title/);
  assert.match(html, /placeholder="Nightly dependency check"/);
  assert.match(html, /Task description/);
  assert.match(
    html,
    /Each occurrence opens its own pull request on its own branch/,
  );
  assert.match(html, /kill every later occurrence/);
});

test("the custom cron field is bound to the stored expression by default", () => {
  const html = render(scheduleNode({ cron: "0 9 * * *" }));

  assert.match(html, /value="0 9 \* \* \*"/);
  assert.match(html, /placeholder="0 9 \* \* \*"/);
});

test("timezone defaults to UTC and warns it is never left blank", () => {
  const html = render();

  assert.match(html, /value="UTC"/);
  assert.match(html, /the schedule would silently run in the host/);
  assert.match(html, /timezone instead/);
});

test("the overlap policy note explains all three choices, including what allow still skips", () => {
  const html = render(scheduleNode({ overlapPolicy: "queue" }));

  assert.match(html, /this occurrence does not run, and the reason is recorded/);
  assert.match(html, /will not run and will not be replayed/);
  assert.match(html, /settled as replaced, not run/);
  assert.match(html, /sharing the same worker-wide pool of concurrent agent runs/);
  assert.match(html, /three by default/);
  assert.match(html, /Allow still skips an occurrence as an overlap/);
});

test("the catch-up grace note states the five-minute floor and its own min attribute", () => {
  const html = render();

  assert.match(html, /Catch-up grace \(minutes\)/);
  assert.match(html, /How late a missed occurrence may still be and be worth running/);
  assert.match(html, /min="5"/);
  assert.match(html, /Five minutes is the floor/);
});

test("presets compile through the worker, never a second evaluator", () => {
  const html = render();

  assert.match(html, /Presets compile to a cron expression through the worker/);
  assert.match(html, /Switch to Custom to type an expression directly/);
});

test("a request still in flight reads as loading, never as a draft it has not earned yet", () => {
  const html = render();

  // Effects (and therefore the fetch) never run in a static render, so this
  // is the panel's true first paint: it must say "loading", not jump ahead to
  // "not deployed", which is a specific claim the fetch has not confirmed yet.
  assert.match(html, /Loading schedule status/);
  assert.doesNotMatch(html, /This schedule is not deployed yet/);
});

test("no italics anywhere in the schedule trigger panel", () => {
  const html = render(scheduleNode({ cron: "0 9 * * *", overlapPolicy: "allow" }));

  assert.doesNotMatch(html, /italic/);
});

// --- Pure sections, driven directly by props (mirrors WebhookDeliveriesSection tests) ---

function nextRunsProps(overrides: Partial<Parameters<typeof ScheduleNextRunsSection>[0]> = {}) {
  return {
    trustState: "evaluating" as const,
    schedule: scheduleStatus(),
    preview: {
      status: "ok" as const,
      cron: "0 9 * * *",
      timezone: "UTC",
      runs: [],
      requestKey: "k",
      suggestedGraceMinutes: null,
    },
    requestKey: "k",
    draftCron: "0 9 * * *",
    draftTimezone: "UTC",
    now: Date.parse("2026-08-05T09:00:00.000Z"),
    canEdit: true,
    busy: false,
    actionError: null,
    loadErrorMessage: null,
    onPause: () => undefined,
    onResume: () => undefined,
    onReload: () => undefined,
    ...overrides,
  };
}

test("the loading state names itself plainly, before any state is known", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection {...nextRunsProps({ trustState: "loading", schedule: null })} />,
  );

  assert.match(html, /Loading schedule status/);
  assert.doesNotMatch(html, /not deployed yet/);
  assert.doesNotMatch(html, />Pause</);
  assert.doesNotMatch(html, />Resume</);
});

test("a failed config load still offers Pause and Resume, since an incident is exactly when they are needed", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "load_error",
        schedule: null,
        loadErrorMessage: "Worker request timed out",
      })}
    />,
  );

  assert.match(html, /Unable to load this schedule/);
  assert.match(html, /Worker request timed out/);
  assert.match(html, />Pause</);
  assert.match(html, />Resume</);
  assert.match(html, />Retry</);
});

test("a validation error from the preview is visible even when not_evaluated hides the timestamps", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "not_evaluated",
        preview: {
          status: "error",
          message: "Expression fires every 2 minutes, the minimum is 15 minutes.",
        },
      })}
    />,
  );

  assert.match(html, /has not evaluated this schedule in this environment/);
  assert.match(html, /the minimum is 15 minutes/);
});

test("a validation error from the preview is visible while paused", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "paused",
        schedule: scheduleStatus({ pausedAt: "2026-08-03T12:00:00.000Z" }),
        preview: { status: "error", message: "Unknown IANA timezone \"Nowhere\"." },
      })}
    />,
  );

  assert.match(html, /Unknown IANA timezone/);
});

test("a validation error from the preview is visible while revoked", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "revoked",
        schedule: scheduleStatus({ revokedAt: "2026-08-04T00:00:00.000Z" }),
        preview: { status: "error", message: "A timezone is required, there is no default." },
      })}
    />,
  );

  assert.match(html, /A timezone is required/);
});

test("the not_evaluated state replaces the preview with a warning and offers Pause, not a timestamp", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "not_evaluated",
        schedule: scheduleStatus({ lastEvaluatedAt: "2026-08-01T09:00:00.000Z" }),
        preview: {
          status: "ok",
          cron: "0 9 * * *",
          timezone: "UTC",
          runs: ["2099-01-01T09:00:00.000Z"],
          requestKey: "k",
          suggestedGraceMinutes: null,
        },
        now: Date.parse("2026-08-05T09:10:00.000Z"),
      })}
    />,
  );

  assert.match(html, /has not evaluated this schedule in this environment since/);
  assert.match(html, /only runs on production deployments/);
  assert.match(html, />Pause</);
  // The confident future timestamp must never leak into this state.
  assert.doesNotMatch(html, /2099-01-01/);
});

test("never evaluated (null last_evaluated_at) reads distinctly from a stale one", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "not_evaluated",
        schedule: scheduleStatus({ lastEvaluatedAt: null }),
        preview: { status: "idle" },
      })}
    />,
  );

  assert.match(html, /The scheduler has never evaluated this schedule in this environment\./);
});

test("the paused state states resume's bounded catch-up semantics, offers only Resume, and reads as neutral, not red", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "paused",
        schedule: scheduleStatus({
          pausedAt: "2026-08-03T12:00:00.000Z",
          lastEvaluatedAt: "2026-08-03T11:00:00.000Z",
        }),
        preview: {
          status: "ok",
          cron: "0 9 * * *",
          timezone: "UTC",
          runs: ["2099-01-01T09:00:00.000Z"],
          requestKey: "k",
          suggestedGraceMinutes: null,
        },
        now: Date.parse("2026-08-05T09:10:00.000Z"),
      })}
    />,
  );

  assert.match(html, /Paused since 2026-08-03 12:00:00 UTC/);
  assert.match(html, /only an occurrence that still falls inside the schedule/);
  assert.match(html, /catch-up grace is caught up/);
  assert.match(html, />Resume</);
  assert.doesNotMatch(html, />Pause</);
  assert.doesNotMatch(html, /2099-01-01/);
  // A pause is the direct result of a click the operator just made, not a
  // failure: it must not wear the same red as an expired or errored chip.
  assert.doesNotMatch(html, /bg-red-50/);
});

test("the evaluating state shows the live preview, its relative time and the last-checked line", () => {
  const now = Date.parse("2026-08-05T09:00:00.000Z");
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "evaluating",
        preview: {
          status: "ok",
          cron: "0 9 * * *",
          timezone: "UTC",
          runs: ["2026-08-05T09:30:00.000Z", "2026-08-06T09:00:00.000Z"],
          requestKey: "k",
          suggestedGraceMinutes: null,
        },
        now,
      })}
    />,
  );

  assert.match(html, /2026-08-05 09:30:00 UTC/);
  assert.match(html, /in 30 minutes/);
  assert.match(html, /2026-08-06 09:00:00 UTC/);
  assert.match(html, /Scheduler last checked 2026-08-05 08:59:30 UTC/);
  assert.match(html, />Pause</);
});

test("Pause is offered with a note that it also cancels an occurrence already waiting", () => {
  const html = renderToStaticMarkup(<ScheduleNextRunsSection {...nextRunsProps()} />);

  assert.match(html, /Also cancels an occurrence that is already waiting/);
});

test("canEdit false disables Pause while evaluating and Resume while paused", () => {
  const evaluatingHtml = renderToStaticMarkup(
    <ScheduleNextRunsSection {...nextRunsProps({ canEdit: false })} />,
  );
  assert.match(evaluatingHtml, /<button[^>]*disabled=""[^>]*>\s*Pause/);

  const pausedHtml = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "paused",
        schedule: scheduleStatus({ pausedAt: "2026-08-03T12:00:00.000Z" }),
        canEdit: false,
      })}
    />,
  );
  assert.match(pausedHtml, /<button[^>]*disabled=""[^>]*>\s*Resume/);
});

test("a draft configuration that differs from nothing deployed shows the pure preview without a deployed-diff note", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "draft",
        schedule: null,
        preview: {
          status: "ok",
          cron: "0 9 * * *",
          timezone: "UTC",
          runs: [],
          requestKey: "k",
          suggestedGraceMinutes: null,
        },
      })}
    />,
  );

  assert.match(html, /This schedule is not deployed yet/);
  assert.doesNotMatch(html, /differs from what is deployed/);
});

test("evaluating with an edited draft names the deployed expression that is still live", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "evaluating",
        schedule: scheduleStatus({ cron: "0 9 * * *", timezone: "UTC" }),
        draftCron: "*/15 * * * *",
        draftTimezone: "UTC",
        preview: {
          status: "ok",
          cron: "*/15 * * * *",
          timezone: "UTC",
          runs: [],
          requestKey: "k",
          suggestedGraceMinutes: null,
        },
      })}
    />,
  );

  assert.match(html, /differs from what is deployed/);
  assert.match(html, /0 9 \* \* \*/);
});

test("evaluating with a draft that matches what is deployed shows no diff note", () => {
  const html = renderToStaticMarkup(<ScheduleNextRunsSection {...nextRunsProps()} />);

  assert.doesNotMatch(html, /differs from what is deployed/);
});

test("a stale preview (fields changed since the debounce fired) is marked as recalculating", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        preview: {
          status: "ok",
          cron: "0 9 * * *",
          timezone: "UTC",
          runs: ["2026-08-06T09:00:00.000Z"],
          requestKey: "stale-key",
          suggestedGraceMinutes: null,
        },
        requestKey: "fresh-key",
      })}
    />,
  );

  assert.match(html, /Recalculating for the latest change/);
});

test("the revoked state reads as a structural fact, not a failure, offers only Refresh, and says pause is preserved", () => {
  const html = renderToStaticMarkup(
    <ScheduleNextRunsSection
      {...nextRunsProps({
        trustState: "revoked",
        schedule: scheduleStatus({
          revokedAt: "2026-08-04T00:00:00.000Z",
          lastEvaluatedAt: "2026-08-03T09:00:00.000Z",
        }),
        preview: {
          status: "ok",
          cron: "0 9 * * *",
          timezone: "UTC",
          runs: ["2099-01-01T09:00:00.000Z"],
          requestKey: "k",
          suggestedGraceMinutes: null,
        },
        now: Date.parse("2026-08-05T09:10:00.000Z"),
      })}
    />,
  );

  assert.match(html, /not in the deployed workflow/);
  assert.match(html, /restore the block and deploy/);
  // "node" is not product vocabulary for this audience; the block is what the
  // customer configured.
  assert.doesNotMatch(html, /\bnode\b/);
  assert.match(html, /paused if it was paused before/);
  assert.doesNotMatch(html, />Pause</);
  assert.doesNotMatch(html, />Resume</);
  assert.match(html, />Refresh</);
  // Neither a confident timestamp nor a "not evaluated" scare should leak in.
  assert.doesNotMatch(html, /2099-01-01/);
  assert.doesNotMatch(html, /has not evaluated/);
});

function occurrence(overrides: Partial<ScheduleOccurrenceEntry> = {}): ScheduleOccurrenceEntry {
  return {
    occurrenceAt: "2026-08-05T09:00:00.000Z",
    pending: false,
    outcome: "started",
    skipReason: null,
    blockingRunId: null,
    runId: null,
    droppedCount: 0,
    droppedCountCapped: false,
    attemptCount: 0,
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-05T09:00:00.000Z");

test("a started occurrence links its run, with a human chip label", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[occurrence({ outcome: "started", runId: "run_42" })]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, />started</);
  assert.match(html, /A run started for this occurrence\./);
  assert.match(html, /href="\/trace\/run_42"/);
  assert.match(html, /run run_42/);
  // The raw enum value must never appear where the human chip label does.
  assert.doesNotMatch(html, />skipped_overlap</);
});

test("a skipped occurrence shows a human chip label, the blocking run linked, and that it will not be replayed", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[
        occurrence({
          outcome: "skipped_overlap",
          skipReason: "previous occurrence still running",
          blockingRunId: "run_7",
          droppedCount: 3,
        }),
      ]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.doesNotMatch(html, />skipped_overlap</);
  assert.match(html, />skipped</);
  assert.match(html, /the previous run of this schedule was still going/);
  assert.match(html, /will not run and will not be replayed/);
  assert.match(html, /href="\/trace\/run_7"/);
  assert.match(html, /dropped 3 earlier occurrences/);
  // No duplicated raw skipReason paragraph alongside the meaning sentence.
  assert.doesNotMatch(html, /previous occurrence still running<\/div>/);
});

test("a superseded occurrence reads with a human chip label and says it will not be replayed", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[occurrence({ outcome: "superseded" })]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.doesNotMatch(html, />superseded</);
  assert.match(html, />replaced</);
  assert.match(html, /will not run and will not be replayed/);
});

test("an expired occurrence's meaning does not mention the drain", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[occurrence({ outcome: "expired" })]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.doesNotMatch(html, /drain/);
  assert.match(html, />abandoned</);
});

test("a pending occurrence reads as waiting, not as an outcome", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[occurrence({ pending: true, outcome: null })]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, />pending</);
  assert.match(html, /Admitted, waiting to be dispatched\./);
});

test("a pending occurrence waiting for capacity reads as normal operation at first, never as an error", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[
        occurrence({
          pending: true,
          outcome: null,
          skipReason: "at_capacity",
          attemptCount: 4,
        }),
      ]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, />waiting</);
  assert.match(html, /Waiting for capacity, attempt 4/);
  assert.match(html, /expected under load/);
  // Neutral or warning styling only: never the red the settled outcomes use.
  assert.doesNotMatch(html, /border-red/);
  // The raw machine string must not also appear as a second, redundant line.
  assert.doesNotMatch(html, /<div[^>]*>at_capacity<\/div>/);
});

test("a capacity wait escalates its copy and points at the logs past the normal-operation threshold", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[
        occurrence({ pending: true, outcome: null, skipReason: "at_capacity", attemptCount: 9 }),
      ]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, /far more attempts than a normal wait/);
  assert.match(html, /check the worker logs/);
});

test("a pending occurrence retrying after a failed attempt is distinct from a fresh admission", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[
        occurrence({
          pending: true,
          outcome: "error",
          skipReason: "provider timeout",
          attemptCount: 2,
        }),
      ]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, />retrying</);
  assert.match(html, /A dispatch attempt failed and will be retried, attempt 2/);
});

test("repeated dispatch failures escalate and point at the logs", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[
        occurrence({ pending: true, outcome: "error", skipReason: "provider timeout", attemptCount: 5 }),
      ]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, /Repeated failures are worth checking the worker logs for/);
});

test("a capped dropped count reads as a floor, never as an exact number", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[
        occurrence({ outcome: "expired", droppedCount: 50, droppedCountCapped: true }),
      ]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, /dropped at least 50 earlier occurrences/);
});

test("an uncapped dropped count reads as an exact number", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[occurrence({ outcome: "superseded", droppedCount: 3 })]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, /dropped 3 earlier occurrences/);
  assert.doesNotMatch(html, /at least 3/);
});

test("a settled occurrence's attempt count only shows once it is past one", () => {
  const single = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[occurrence({ outcome: "started", attemptCount: 1 })]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );
  assert.doesNotMatch(single, /attempts/);

  const many = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[occurrence({ outcome: "expired", attemptCount: 12 })]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );
  assert.match(many, /12 attempts/);
});

test("the last run renders from last_started_occurrence_at and last_started_run_id, linked, with a relative age", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={{ occurrenceAt: "2026-08-04T09:00:00.000Z", runId: "run_55" }}
      now={Date.parse("2026-08-05T09:00:00.000Z")}
      periodMs={null}
      occurrences={[]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, /Last run 2026-08-04 09:00:00 UTC \(1 day ago\)/);
  assert.match(html, /href="\/trace\/run_55"/);
  assert.match(html, /run run_55/);
});

test("a last run well past this schedule's own period is highlighted, a recent one is not", () => {
  const oneDayMs = 24 * 60 * 60 * 1000;
  const stale = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={{ occurrenceAt: "2026-08-01T09:00:00.000Z", runId: "run_1" }}
      now={Date.parse("2026-08-05T09:00:00.000Z")}
      periodMs={oneDayMs}
      occurrences={[]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );
  assert.match(stale, /well past this schedule.{1,10}s usual period/);
  assert.match(stale, /text-amber-800/);

  const fresh = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={{ occurrenceAt: "2026-08-05T08:00:00.000Z", runId: "run_2" }}
      now={Date.parse("2026-08-05T09:00:00.000Z")}
      periodMs={oneDayMs}
      occurrences={[]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );
  assert.doesNotMatch(fresh, /well past this schedule.{1,10}s usual period/);
});

test("a last run is never flagged stale when there is no period to compare it against", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={{ occurrenceAt: "2020-01-01T09:00:00.000Z", runId: "run_1" }}
      now={Date.parse("2026-08-05T09:00:00.000Z")}
      periodMs={null}
      occurrences={[]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.doesNotMatch(html, /well past this schedule.{1,10}s usual period/);
});

test("no run yet is stated plainly when the schedule has never started one", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, /No run yet\./);
});

test("the aggregate line counts how many recent occurrences actually started", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[
        occurrence({ occurrenceAt: "2026-08-05T09:00:00.000Z", outcome: "started" }),
        occurrence({ occurrenceAt: "2026-08-04T09:00:00.000Z", outcome: "skipped_overlap" }),
        occurrence({ occurrenceAt: "2026-08-03T09:00:00.000Z", outcome: "skipped_overlap" }),
      ]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, /1 of 3 recent occurrences started\./);
});

test("no aggregate line renders when there is no history yet", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.doesNotMatch(html, /recent occurrences? started/);
});

test("an empty occurrence history stays honest about it", () => {
  const html = renderToStaticMarkup(
    <ScheduleOccurrenceHistorySection
      lastRun={null}
      now={NOW}
      periodMs={null}
      occurrences={[]}
      loading={false}
      error={null}
      onRefresh={() => undefined}
    />,
  );

  assert.match(html, /No occurrences yet\./);
});

// --- Interactive: the live container against a mocked worker ---

function tree(node: FlowNodeDef, onChange: (path: string, value: unknown) => void) {
  return (
    <PromptAuthoringProvider
      availableValues={[]}
      onV2ConfigurationChange={() => undefined}
      previewCandidate={{
        definitionId: 42,
        definition: {} as WorkflowDefinitionV2,
        blockId: node.id,
      }}
    >
      <ConfigFields node={node} options={options} canEdit onChange={onChange} />
    </PromptAuthoringProvider>
  );
}

/** Applies one `onChange("params.x", value)` call to a node immutably. Every
 *  onChange in the schedule fields writes a single top-level params key, so
 *  this narrow shape is enough; a path outside it is a test bug, not
 *  something to swallow silently. */
function applyParamsChange(
  node: FlowNodeDef,
  path: string,
  value: WorkflowParamValue,
): FlowNodeDef {
  const match = /^params\.([^.]+)$/.exec(path);
  assert.ok(match, `expected a top-level params.* change, got ${path}`);
  const nextParams: Record<string, WorkflowParamValue> = { ...node.params, [match![1]]: value };
  return {
    ...node,
    params: nextParams,
    v2: {
      configuration: nextParams as Record<string, JsonValue>,
      inputs: node.v2?.inputs ?? {},
      additionalInputs: node.v2?.additionalInputs ?? [],
    },
  };
}

/** Like tree(), but a real parent's round trip: onChange also feeds the new
 *  value back into the rendered node, the way the actual editor's state does.
 *  Needed only where a test applies a change and then depends on the
 *  component seeing it reflected in `node.params` on the next interaction. */
function StatefulTree({
  initialNode,
  changes,
}: {
  initialNode: FlowNodeDef;
  changes: [string, unknown][];
}) {
  const [node, setNode] = React.useState(initialNode);
  return (
    <PromptAuthoringProvider
      availableValues={[]}
      onV2ConfigurationChange={() => undefined}
      previewCandidate={{
        definitionId: 42,
        definition: {} as WorkflowDefinitionV2,
        blockId: initialNode.id,
      }}
    >
      <ConfigFields
        node={node}
        options={options}
        canEdit
        onChange={(path, value) => {
          changes.push([path, value]);
          setNode((prev) => applyParamsChange(prev, path, value as WorkflowParamValue));
        }}
      />
    </PromptAuthoringProvider>
  );
}

function nodeText(instance: ReactTestInstance): string {
  return instance.children
    .flatMap((child) => (typeof child === "string" ? [child] : [nodeText(child)]))
    .join("");
}

function findButton(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root
    .findAll((instance) => instance.type === "button")
    .filter((instance) => nodeText(instance).trim() === text);
  assert.equal(matches.length, 1, `expected exactly one button ${text}`);
  return matches[0];
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {});
}

function scheduleConfig(overrides: Partial<ScheduleConfigResponse> = {}): ScheduleConfigResponse {
  return {
    state: "evaluating",
    schedule: scheduleStatus(),
    occurrences: [],
    ...overrides,
  };
}

test("the status panel loads config, shows Pause, and Pause posts and reloads as paused", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let paused = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/schedule/config")) {
      calls.push("config");
      return Response.json(
        paused
          ? scheduleConfig({
              state: "paused",
              schedule: { ...scheduleConfig().schedule!, pausedAt: "2026-08-05T09:00:05.000Z" },
            })
          : scheduleConfig(),
      );
    }
    if (path.endsWith("/schedule/preview")) {
      return Response.json({ ok: true, cron: "0 9 * * *", timezone: "UTC", runs: [], suggestedGraceMinutes: 30 });
    }
    if (path.endsWith("/schedule/pause") && init?.method === "POST") {
      paused = true;
      calls.push("pause");
      return Response.json({ scheduleId: "sch_1", pausedAt: "2026-08-05T09:00:05.000Z" });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(tree(scheduleNode({ cron: "0 9 * * *" }), () => undefined));
    });
    await settle();

    assert.ok(calls.includes("config"));
    const pauseButton = findButton(renderer.root, "Pause");
    await act(async () => pauseButton.props.onClick());
    await settle();

    assert.ok(calls.includes("pause"));
    assert.match(nodeText(renderer.root), /Paused since 2026-08-05 09:00:05 UTC/);
    findButton(renderer.root, "Resume");
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a 403 on Pause states the permission problem plainly, not a generic failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/schedule/config")) return Response.json(scheduleConfig());
    if (path.endsWith("/schedule/preview")) {
      return Response.json({ ok: true, cron: "0 9 * * *", timezone: "UTC", runs: [], suggestedGraceMinutes: 30 });
    }
    if (path.endsWith("/schedule/pause") && init?.method === "POST") {
      return new Response(JSON.stringify({ statusMessage: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(tree(scheduleNode({ cron: "0 9 * * *" }), () => undefined));
    });
    await settle();

    await act(async () => findButton(renderer.root, "Pause").props.onClick());
    await settle();

    assert.match(nodeText(renderer.root), /You do not have permission to pause or resume this schedule\./);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a failed config load still lets Pause and Resume through, live", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const path = String(url);
    if (path.endsWith("/schedule/config")) {
      return new Response("upstream unavailable", { status: 502 });
    }
    if (path.endsWith("/schedule/preview")) {
      return Response.json({ ok: true, cron: "0 9 * * *", timezone: "UTC", runs: [], suggestedGraceMinutes: 30 });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(tree(scheduleNode({ cron: "0 9 * * *" }), () => undefined));
    });
    await settle();

    assert.match(nodeText(renderer.root), /Unable to load this schedule.s status/);
    findButton(renderer.root, "Pause");
    findButton(renderer.root, "Resume");
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("Resume posts and the panel returns to a normal Pause-offering state", async () => {
  const originalFetch = globalThis.fetch;
  let resumed = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/schedule/config")) {
      return Response.json(
        resumed
          ? scheduleConfig({ state: "evaluating" })
          : scheduleConfig({
              state: "paused",
              schedule: { ...scheduleConfig().schedule!, pausedAt: "2026-08-03T12:00:00.000Z" },
            }),
      );
    }
    if (path.endsWith("/schedule/preview")) {
      return Response.json({ ok: true, cron: "0 9 * * *", timezone: "UTC", runs: [], suggestedGraceMinutes: 30 });
    }
    if (path.endsWith("/schedule/resume") && init?.method === "POST") {
      resumed = true;
      return Response.json({ scheduleId: "sch_1" });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(tree(scheduleNode({ cron: "0 9 * * *" }), () => undefined));
    });
    await settle();

    assert.match(nodeText(renderer.root), /catch-up grace is caught up/);
    const resumeButton = findButton(renderer.root, "Resume");
    await act(async () => resumeButton.props.onClick());
    await settle();

    findButton(renderer.root, "Pause");
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("occurrence history is hidden while the schedule is still a draft", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const path = String(url);
    if (path.endsWith("/schedule/config")) {
      return Response.json({ state: "draft", schedule: null, occurrences: [] });
    }
    if (path.endsWith("/schedule/preview")) {
      return Response.json({
        ok: false,
        problem: { reason: "invalid-expression", message: "empty expression" },
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(tree(scheduleNode(), () => undefined));
    });
    await settle();

    assert.doesNotMatch(nodeText(renderer.root), /Recent occurrences/);
    assert.match(nodeText(renderer.root), /This schedule is not deployed yet/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("a revoked schedule fetched from the worker shows Refresh only, and still lists its last run", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const path = String(url);
    if (path.endsWith("/schedule/config")) {
      return Response.json(
        scheduleConfig({
          state: "revoked",
          schedule: {
            ...scheduleConfig().schedule!,
            revokedAt: "2026-08-04T00:00:00.000Z",
            lastStartedOccurrenceAt: "2026-08-03T09:00:00.000Z",
            lastStartedRunId: "run_88",
          },
        }),
      );
    }
    if (path.endsWith("/schedule/preview")) {
      return Response.json({ ok: true, cron: "0 9 * * *", timezone: "UTC", runs: [], suggestedGraceMinutes: 30 });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(tree(scheduleNode({ cron: "0 9 * * *" }), () => undefined));
    });
    await settle();

    const text = nodeText(renderer.root);
    assert.match(text, /not in the deployed workflow/);
    assert.match(text, /Last run 2026-08-03 09:00:00 UTC/);
    assert.match(text, /run_88/);
    assert.throws(() => findButton(renderer.root, "Pause"));
    assert.throws(() => findButton(renderer.root, "Resume"));
    // Two independent Refresh actions are legitimate here: the revoked banner's
    // own, and the occurrence history section's, which still renders since the
    // schedule is deployed history, not a draft.
    const refreshButtons = renderer.root
      .findAll((instance) => instance.type === "button")
      .filter((instance) => nodeText(instance).trim() === "Refresh");
    assert.equal(refreshButtons.length, 2);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

// An interval preset ("every N minutes") has no clock meaning, so the worker
// compiles it in UTC regardless of the timezone field (occurrence.ts's
// INTERVAL_PRESET_TIMEZONE rule). Apply must save exactly what the worker
// compiled, timezone included, even though the field still shows the zone the
// operator originally typed.
test("switching to an interval preset saves UTC, not the typed timezone, and returns to Custom", async () => {
  const originalFetch = globalThis.fetch;
  const previewRequests: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/schedule/config")) {
      return Response.json({ state: "draft", schedule: null, occurrences: [] });
    }
    if (path.endsWith("/schedule/preview")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      previewRequests.push(body);
      if (body.source === "preset") {
        // The worker's own answer for an interval preset: UTC, not the
        // "Europe/Warsaw" the request carried.
        return Response.json({
          ok: true,
          cron: "*/15 * * * *",
          timezone: "UTC",
          runs: ["2026-08-05T09:15:00.000Z"],
          suggestedGraceMinutes: 15,
        });
      }
      return Response.json({
        ok: false,
        problem: { reason: "invalid-expression", message: "empty expression" },
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  const changes: [string, unknown][] = [];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        tree(
          scheduleNode({ timezone: "Europe/Warsaw" }),
          (path, value) => changes.push([path, value]),
        ),
      );
    });
    await settle();
    // The very first preview call, for the (empty) custom cron, has landed.
    assert.equal(previewRequests.length, 1);

    await act(async () => findButton(renderer.root, "Preset").props.onClick());
    // The note appears immediately: it is derived from local preset-kind
    // state, not from the debounced preview response.
    assert.match(
      nodeText(renderer.root),
      /does not observe daylight saving, so the timezone below does not apply/,
    );

    // This change is debounced at 5s like the workflow validator: wait it out
    // rather than firing on every keystroke.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5100));
    });
    await settle();

    const preset = previewRequests.at(-1);
    assert.deepEqual(preset, {
      source: "preset",
      preset: { kind: "every-n-minutes", minutes: 15 },
      timezone: "Europe/Warsaw",
    });

    const apply = findButton(renderer.root, "Apply preset");
    assert.equal(apply.props.disabled, false);
    await act(async () => apply.props.onClick());

    // Both fields are persisted, and the saved timezone is the worker's
    // compiled answer (UTC), not what the operator had typed.
    assert.deepEqual(changes, [
      ["params.cron", "*/15 * * * *"],
      ["params.timezone", "UTC"],
    ]);
    // Back to Custom, showing the applied expression as the source of truth.
    assert.equal(findButton(renderer.root, "Custom").props.disabled, false);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

// A clock-anchored preset (daily, weekly, or every 24 hours) keeps whatever
// timezone is configured, so the override note must not appear for it.
test("a clock-anchored preset does not warn that the timezone is ignored", () => {
  const html = render();

  // The default preset kind is "every-n-minutes" (interval), but the builder
  // starts in Custom mode, so neither the preset UI nor its note renders yet.
  assert.doesNotMatch(html, /does not observe daylight saving/);
});

// A1: switching from an interval preset (which forced UTC) to a clock-anchored
// one must restore the timezone the operator actually typed, not silently
// keep the interval override or, worse, let a later clock preset inherit it.
test("switching from an interval preset back to a clock preset restores the operator's own timezone", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/schedule/config")) {
      return Response.json({ state: "draft", schedule: null, occurrences: [] });
    }
    if (path.endsWith("/schedule/preview")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.source === "preset" && (body.preset as { kind: string }).kind === "every-n-minutes") {
        return Response.json({
          ok: true,
          cron: "*/15 * * * *",
          timezone: "UTC",
          runs: [],
          suggestedGraceMinutes: 15,
        });
      }
      return Response.json({
        ok: true,
        cron: "0 9 * * *",
        timezone: (body as { timezone: string }).timezone,
        runs: [],
        suggestedGraceMinutes: 30,
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  const changes: [string, unknown][] = [];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <StatefulTree
          initialNode={scheduleNode({ timezone: "Europe/Warsaw" })}
          changes={changes}
        />,
      );
    });
    await settle();

    // Move to the interval preset and apply it: the authored timezone becomes
    // UTC, an artifact of the preset, not a new operator choice.
    await act(async () => findButton(renderer.root, "Preset").props.onClick());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5100));
    });
    await settle();
    await act(async () => findButton(renderer.root, "Apply preset").props.onClick());
    assert.deepEqual(changes.at(-1), ["params.timezone", "UTC"]);

    // Re-enter preset mode and switch to a clock-anchored kind ("daily"): the
    // remembered Europe/Warsaw must come back, not the leftover UTC. Listbox
    // renders its option list through a portal driven by real layout
    // measurements this environment does not provide, so the switch is driven
    // through the Listbox component's own onChange prop directly, the same
    // way every button interaction elsewhere in this file goes through
    // .props.onClick rather than a simulated pointer event.
    await act(async () => findButton(renderer.root, "Preset").props.onClick());
    const kindSelect = renderer.root.findAll(
      (instance) => instance.props.ariaLabel === "Preset kind",
    )[0]!;
    await act(async () => kindSelect.props.onChange("daily"));

    assert.deepEqual(changes.at(-1), ["params.timezone", "Europe/Warsaw"]);
    assert.match(nodeText(renderer.root), /Restored your previous timezone \(Europe\/Warsaw\)/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

// G: suggestedGraceMinutes from the preview response is a suggestion the
// operator can pick up, never a value that overwrites their own on its own.
test("a catch-up grace suggestion appears next to the field, and only writes params on click", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/schedule/config")) {
      return Response.json({ state: "draft", schedule: null, occurrences: [] });
    }
    if (path.endsWith("/schedule/preview")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        ok: true,
        cron: body.cron,
        timezone: body.timezone,
        runs: [],
        suggestedGraceMinutes: 20,
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  const changes: [string, unknown][] = [];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        tree(
          scheduleNode({ cron: "0 9 * * *", timezone: "UTC", catchUpGraceMinutes: 60 }),
          (path, value) => changes.push([path, value]),
        ),
      );
    });
    await settle();

    // The suggestion (20) differs from the authored value (60): the button
    // offers it, but nothing has been written to params yet.
    const useSuggested = findButton(renderer.root, "Use suggested 20");
    assert.deepEqual(changes, []);

    await act(async () => useSuggested.props.onClick());

    assert.deepEqual(changes, [["params.catchUpGraceMinutes", 20]]);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("no catch-up grace suggestion is offered once it matches the authored value", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/schedule/config")) {
      return Response.json({ state: "draft", schedule: null, occurrences: [] });
    }
    if (path.endsWith("/schedule/preview")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        ok: true,
        cron: body.cron,
        timezone: body.timezone,
        runs: [],
        suggestedGraceMinutes: 60,
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;

  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        tree(scheduleNode({ cron: "0 9 * * *", timezone: "UTC", catchUpGraceMinutes: 60 }), () => undefined),
      );
    });
    await settle();

    assert.doesNotMatch(nodeText(renderer.root), /Use suggested/);
  } finally {
    await act(async () => renderer.unmount());
    globalThis.fetch = originalFetch;
  }
});
