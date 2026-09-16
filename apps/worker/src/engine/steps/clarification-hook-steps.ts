import type {
  WorkScope,
  WorkScopeAskedRepository,
  WorkScopeQuestionPurpose,
} from "@shared/contracts";
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

/**
 * The ask, with the one fact only this place knows: which of the repositories
 * the question is recorded against its words actually NAMED.
 *
 * Every repository question in the run goes through the step below, and it is
 * the only point where the question's text and the repositories it will be
 * recorded against are both in hand. Computed here rather than declared by each
 * caller for exactly that reason: a caller that forgets would record a decision
 * nobody made, silently, and there is no later reader that could tell.
 *
 * A key is named when it appears in the question as the answer reader spells it
 * back, `provider:owner/repo`, which is how every question that means to name
 * one writes it (`repositoryDiscoveryQuestion`, `workScopeExpansionQuestion`,
 * the pre-sandbox selection question). A question that names a repository some
 * other way reads as not naming it, which costs one question asked again rather
 * than a decision fabricated from silence.
 */
function askedRepositoriesNamedIn(
  questions: string[],
  asked: WorkScopeAskedRepository[],
): WorkScopeAskedRepository[] {
  return asked.map((repository) => ({
    ...repository,
    named: questions.some((question) => question.includes(repository.repositoryKey)),
  }));
}

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
  workScopeAsk?: {
    subjectKey: string;
    askedRepositories: WorkScopeAskedRepository[];
    /** Why the question was put, where no repository key can carry that fact:
     *  a question asking somebody to narrow a set too large to list names none
     *  of them, so the ask below is empty and this is the only record that the
     *  question was that one. */
    purpose?: WorkScopeQuestionPurpose;
  };
}) {
  "use step";
  const { workScopeAsk, ...clarification } = input;
  const { prepareConnectedHookClarification } = await import(
    "../../db/repositories/clarification-hooks.js"
  );
  // Stamped once, and both writes below take the stamped list: the clarification
  // row is what the answer reader decides from, and the trail row is what a
  // later run reads the answered repositories out of, so a fact on one of them
  // and not the other would be two records of the same question disagreeing.
  const askedRepositories = workScopeAsk
    ? askedRepositoriesNamedIn(input.questions, workScopeAsk.askedRepositories)
    : [];
  const row = await prepareConnectedHookClarification({
    ...clarification,
    ...(workScopeAsk ? { askedRepositories } : {}),
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
      asked: askedRepositories,
      ...(workScopeAsk.purpose === undefined ? {} : { purpose: workScopeAsk.purpose }),
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

/**
 * The record as the answer to a repository question left it.
 *
 * THE BLOCK THAT ASKED IS RE-EXECUTED FROM THE TOP after the answer, and it
 * decides against the copy of the record the run froze at start. Without this
 * read that copy still says nobody has been asked, so the block reaches the same
 * line, raises the identical question, and the person answers into a loop that
 * ends only when the run budget kills it. A repeated question is a cost and a
 * fabricated decision is a defect; a run that hangs is worse than both.
 *
 * The same read the expansion path already does when it resumes
 * (`engine/steps/phase.ts`, `resumeFromWorkScope`), for the same reason and with
 * the same reach: every entry written since the run began arrives, this run's
 * own answer and a panel edit alike, because the record is the truth and the
 * frozen copy is only a copy.
 */
export async function readWorkScopeAfterAnswerStep(
  subjectKey: string,
  clarificationId?: string,
): Promise<{
  scope: WorkScope | null;
  selectionAnswered: boolean;
  answeredRepositoryKeys: string[];
  answerAttributed?: boolean;
  narrowingAnswered?: boolean;
}> {
  "use step";
  const {
    readConnectedWorkScope,
    readConnectedWorkScopeAnsweredQuestion,
    readConnectedWorkScopeAnsweredRepositories,
    readConnectedWorkScopeNarrowingAnswered,
    readConnectedWorkScopeSelectionAnswered,
  } = await import("../../db/repositories/work-scope.js");
  const [scope, selectionAnswered, answeredRepositoryKeys, narrowingAnswered, answered] =
    await Promise.all([
      readConnectedWorkScope(subjectKey),
      readConnectedWorkScopeSelectionAnswered(subjectKey),
      readConnectedWorkScopeAnsweredRepositories(subjectKey),
      // THE SAME RUN ASKS AGAIN WITHOUT THIS. A narrowing answer resumes the
      // run that asked, and the block re-executes from the top against a
      // selection discovery rebuilds unchanged, so without this read it raises
      // the identical question the person has just answered.
      readConnectedWorkScopeNarrowingAnswered(subjectKey),
      // Keyed on the clarification, not the subject: "what the record made of
      // the answer" is a fact about one question, and the newest row on a
      // subject is only probably this one.
      clarificationId === undefined
        ? Promise.resolve(null)
        : readConnectedWorkScopeAnsweredQuestion(clarificationId),
    ]);
  const event = answered?.event;
  return {
    scope,
    selectionAnswered,
    answeredRepositoryKeys,
    narrowingAnswered,
    // WHAT THE RECORD DID WITH THE WORDS, which nothing in the entries says: an
    // answer it declined and an answer it read and found nothing in both leave
    // the entries untouched, and only one of them is anybody's refusal. False
    // ONLY for "unattributed", the answer more than one person wrote, because
    // that is the only kind whose meaning is "these words are not one person's
    // decision". Absent when no row could be read, and the reader owes that
    // case a rule of its own rather than a guess.
    ...(event !== undefined && event.kind === "question_answered"
      ? { answerAttributed: event.answer.kind !== "unattributed" }
      : {}),
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
