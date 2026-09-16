import type { WorkScopeWritePlan } from "@shared/contracts";

/**
 * What one call site needs to apply a run's work scope decision to the
 * stored record: whose record it is, which run decided it, and what the
 * decision wrote down.
 *
 * Named once here because the shape used to be spelled inline at every call
 * site (`engine/steps/phase.ts`, `engine/agent-workflow.ts`): a clump that
 * appears four times with no name is a clump the next change to it has to
 * find by eye.
 */
export interface RunWorkScopeWrite {
  subjectKey: string;
  runId: string;
  plans: WorkScopeWritePlan[];
}

/**
 * Apply what a run decided about a subject's work scope, from inside the step
 * that carries it.
 *
 * Only ever called from a step with `maxRetries = 0`. A refusal line lost when
 * an invocation dies is acceptable, because a refusal changes no entry; a
 * DUPLICATED one is not, because the refusal vocabulary has no reason for a
 * repeat and two identical lines read as an agent that asked twice.
 *
 * A FAILED WRITE IS LOGGED AND THE RUN CONTINUES. This summarises what the run
 * computed from inputs that all still exist: the same ticket, the same
 * policy, the same catalog. The next run computes the same thing again, so a
 * lost write costs a debugging line and at worst one recomputation, unlike an
 * answer to a question a person will not be asked twice. The log line carries
 * the subject and the run so it can be found rather than merely counted.
 *
 * The database import stays deferred inside this function, not hoisted to the
 * top of the module: a step body reaches this file through a dynamic import,
 * and the database client may not load until a step actually runs.
 */
export async function applyRunWorkScopePlans(write: RunWorkScopeWrite): Promise<void> {
  if (write.plans.length === 0) return;
  try {
    const { applyConnectedRunWorkScopePlan } = await import(
      "../../db/repositories/work-scope.js"
    );
    for (const plan of write.plans) {
      await applyConnectedRunWorkScopePlan({
        subjectKey: write.subjectKey,
        runId: write.runId,
        plan,
      });
    }
  } catch (error) {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      {
        subjectKey: write.subjectKey,
        runId: write.runId,
        err: error instanceof Error ? error.message : String(error),
      },
      "work_scope_write_failed",
    );
  }
}
