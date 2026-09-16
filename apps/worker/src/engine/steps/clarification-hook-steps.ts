import type { WorkScopeAskedRepository } from "@shared/contracts";
import type { SerializableClarificationSnapshot } from "./clarification-snapshot-steps.js";
import type { WorkspaceManifest } from "../../sandbox/repo-workspace.js";

export async function verifyWorkspaceManifestStep(
  sandboxId: string,
  trustedManifest: WorkspaceManifest,
): Promise<void> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { parseVerifiedWorkspaceManifest, WORKSPACE_MANIFEST_PATH } =
    await import("../../sandbox/repo-workspace.js");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const buffer = await sandbox.readFileToBuffer({ path: WORKSPACE_MANIFEST_PATH });
  if (!buffer) {
    throw new Error(`clarification workspace manifest is missing in sandbox ${sandboxId}`);
  }
  parseVerifiedWorkspaceManifest(buffer.toString("utf8"), trustedManifest);
}
verifyWorkspaceManifestStep.maxRetries = 0;

export async function prepareClarificationHookStep(input: {
  ticketKey: string | null;
  subjectKey: string;
  runId: string;
  blockId: string;
  definitionId: number | null;
  definitionVersion: number | null;
  questions: string[];
  suggestedAnswers?: string[] | null;
  /** Present only when the question is about repositories, and then it carries
   *  the subject whose work scope records the answer. The repository a question
   *  is about is written down when it is ASKED: by answer time the clarification
   *  row is all that is left of the question, so without this the answer would
   *  name no repository and the next run would ask again. */
  workScopeAsk?: { subjectKey: string; askedRepositories: WorkScopeAskedRepository[] };
}) {
  "use step";
  const { workScopeAsk, ...clarification } = input;
  const { prepareConnectedHookClarification } = await import(
    "../../db/repositories/clarification-hooks.js"
  );
  const row = await prepareConnectedHookClarification({
    ...clarification,
    ...(workScopeAsk ? { askedRepositories: workScopeAsk.askedRepositories } : {}),
  });
  if (workScopeAsk) {
    const { appendConnectedWorkScopeQuestionAsked } = await import(
      "../../db/repositories/work-scope.js"
    );
    // Keyed on the id this attempt produced, because the insert above is not
    // idempotent (`db/repositories/clarification-hooks.ts:76` draws a fresh id
    // per attempt): a retried attempt asks a second question, and its own row
    // is as true as the first one's.
    //
    // Logged and never thrown, and it has to stay that way. WHICH repositories
    // the question named is the clarification row's own column, written by the
    // insert above, so a lost trail row costs a line in the debug view and no
    // decision. Thrown, it would cost the question itself: this step would
    // fail, the SDK would retry it three times, every attempt would leave
    // another preparing clarification behind, and the run would die without
    // ever having asked the person anything. console.error, like the rest of
    // the run's best-effort telemetry (`engine/steps/telemetry.ts:154-173`), so
    // a failing append is visible the day it starts rather than silent.
    await appendConnectedWorkScopeQuestionAsked({
      subjectKey: workScopeAsk.subjectKey,
      runId: input.runId,
      clarificationId: row.id,
      asked: workScopeAsk.askedRepositories,
    }).catch((error: unknown) => {
      console.error(
        "work_scope_question_asked_append_failed",
        row.id,
        input.runId,
        (error as Error).message,
      );
    });
  }
  return {
    id: row.id,
    hookToken: row.hookToken,
    snapshotRequestedAt: row.askedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

export async function recordClarificationHookSnapshotStep(
  id: string,
  snapshot: SerializableClarificationSnapshot,
): Promise<void> {
  "use step";
  const { recordConnectedHookClarificationSnapshot } = await import(
    "../../db/repositories/clarification-hooks.js"
  );
  await recordConnectedHookClarificationSnapshot(id, {
    snapshotId: snapshot.snapshotId,
    sourceSandboxId: snapshot.sourceSandboxId,
    expiresAt: new Date(snapshot.expiresAt),
  });
}

export async function publishClarificationHookStep(id: string): Promise<void> {
  "use step";
  const { publishConnectedHookClarification } = await import(
    "../../db/repositories/clarification-hooks.js"
  );
  await publishConnectedHookClarification(id);
}

export async function markClarificationHookCleanupStep(
  id: string,
  result: { status: "deleted" } | { status: "failed"; error: string },
): Promise<void> {
  "use step";
  const { markConnectedHookClarificationCleanup } = await import(
    "../../db/repositories/clarification-hooks.js"
  );
  await markConnectedHookClarificationCleanup(id, result);
}

export async function markRunAwaitingStep(runId: string): Promise<void> {
  "use step";
  const { markConnectedRunAwaiting } = await import("../../db/repositories/runs/telemetry.js");
  await markConnectedRunAwaiting(runId);
}

export async function markRunResumedStep(runId: string): Promise<void> {
  "use step";
  const { markConnectedRunResumed } = await import("../../db/repositories/runs/telemetry.js");
  await markConnectedRunResumed(runId);
}

export async function supersedeClarificationHookStep(id: string): Promise<void> {
  "use step";
  const { supersedeConnectedPreparingHookClarification } = await import(
    "../../db/repositories/clarification-hooks.js"
  );
  await supersedeConnectedPreparingHookClarification(id);
}
