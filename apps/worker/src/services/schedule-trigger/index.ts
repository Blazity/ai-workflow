/**
 * Schedule parsing, occurrence planning and the scheduled dispatch pass.
 *
 * The declared interface of this cluster. Cross-cluster imports must target
 * this file; the deep imports that predate the rule are listed in
 * scripts/gates/cluster-deep-imports.json and that list only shrinks.
 */
export {
  createConnectedScheduleDispatchDeps,
  createScheduleDispatchDeps,
  runScheduleTriggerPass,
} from "./dispatch-schedule-trigger.js";
export {
  MINIMUM_PERIOD_MS,
  compileSchedulePreset,
  nextRuns,
  parseSchedule,
  suggestedGraceMinutes,
  violatesMinimumPeriod,
} from "./occurrence.js";
export type {
  EveryNHoursStep,
  EveryNMinutesStep,
  SchedulePreset,
  Weekday,
} from "./occurrence.js";
export type { OccurrenceRow } from "./occurrence-store.js";
// Declared for one consumer, `services/workflow-definitions/persistence.test.ts`:
// the cross-cluster rule above applies to it, and the boundaries gate cannot
// record the alternative because it excludes test files from the cruise.
export { resolveLiveScheduleTriggerTarget } from "./live-target.js";
export {
  cancelWaitingOccurrences,
} from "./revoked-occurrences.js";
