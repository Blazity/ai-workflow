import { logger } from "./logger.js";

/**
 * Longest a single step invocation can stay alive on Vercel. The deployed step
 * function ships maxDuration "max", which resolves to 800 s on Pro and 900 s
 * on Enterprise, and the runtime kills the invocation at that ceiling ("Task
 * timed out after 800 seconds", 504). Twenty minutes leaves a real margin
 * beyond the larger figure for clock skew between the platform and event log.
 */
export const DEAD_STEP_AFTER_MS = 20 * 60_000;

interface DrainStep {
  stepId?: string;
  stepName?: string;
  status: string;
  attempt?: number;
  startedAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

function toMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A "running" step proves a live handler only while an invocation could still
 * be executing it. Callers ask once the Workflow run is terminal (cancelled,
 * failed, completed): from then on a queue redelivery of the step message is
 * rejected on RunExpired before any user code runs, so the only handler that
 * can still be alive is one that started before the run went terminal, and it
 * dies at the function ceiling at the latest. A step whose last recorded
 * activity (the later of startedAt and updatedAt; the terminal transition
 * itself bumps updatedAt) is older than DEAD_STEP_AFTER_MS therefore has no
 * handler left anywhere.
 *
 * Without this rule a step whose invocation hung until the kill stays
 * "running" in the event log forever, every drain reports pending, and the
 * claim it blocks never releases (UP-4765, 2026-08-21: three redeliveries of
 * one checkPhaseDone each died at 800 s, the cancel confirmed the run but the
 * ticket stayed undispatchable). A step without timestamps stays live: that is
 * the conservative reading.
 */
export function isDeadRunningStep(step: DrainStep, now: number = Date.now()): boolean {
  if (step.status !== "running") return false;
  const startedAt = toMs(step.startedAt);
  const updatedAt = toMs(step.updatedAt);
  // Treat incomplete or malformed metadata as live. The watchdog must fail
  // closed rather than release an owner on a timestamp it cannot trust.
  if (startedAt === null || updatedAt === null) return false;
  const last = Math.max(startedAt, updatedAt);
  return now - last > DEAD_STEP_AFTER_MS;
}

/**
 * A terminal Workflow run may still have a step handler executing. Do not
 * release or park the application owner until every durable step page proves
 * that no handler remains in `running`, where a step that outlived the
 * function ceiling no longer counts (see isDeadRunningStep).
 */
export async function confirmWorkflowStepsDrained(
  subjectKey: string,
  runId: string,
): Promise<boolean> {
  try {
    const { getWorld } = await import("workflow/runtime");
    const world = getWorld();
    let cursor: string | undefined;
    for (;;) {
      const page = await world.steps.list({
        runId,
        resolveData: "none",
        pagination: { limit: 100, ...(cursor ? { cursor } : {}) },
      });
      const running = page.data.filter((step) => step.status === "running");
      const dead = running.filter((step) => isDeadRunningStep(step));
      if (dead.length > 0) {
        logger.warn(
          {
            subjectKey,
            runId,
            steps: dead.map((step) => ({
              stepId: step.stepId,
              stepName: step.stepName,
              attempt: step.attempt,
              startedAt: step.startedAt,
              updatedAt: step.updatedAt,
            })),
          },
          "workflow_step_drain_ignored_dead_steps",
        );
      }
      if (running.length > dead.length) {
        logger.info({ subjectKey, runId }, "workflow_step_drain_pending");
        return false;
      }
      if (!page.hasMore) return true;
      if (!page.cursor) {
        throw new Error("Workflow step pagination reported more pages without a cursor");
      }
      cursor = page.cursor;
    }
  } catch (error) {
    logger.warn(
      { subjectKey, runId, error: (error as Error).message },
      "workflow_step_drain_unconfirmed",
    );
    return false;
  }
}
