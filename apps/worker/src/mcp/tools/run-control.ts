import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  answerClarificationAndResume,
  type AnswerClarificationOutcome,
} from "../../clarifications/answer-core.js";
import {
  getResumableClarificationForRun,
  type HookClarificationRow,
} from "../../clarifications/hook-store.js";
import {
  findLiveRunClaimByRunId,
  findRunOutcomeByRunId,
} from "../../db/queries/runs-read.js";
import { cancelRunForOperator } from "../../lib/cancel-run.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpMutation, executeMcpRead } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import { registerCatalogTool } from "../tool-catalog.js";

/**
 * Run control: reading the question a parked run asked, answering it, and stopping a
 * run.
 *
 * The whole point of this module is what it does NOT contain. Answering a
 * clarification is a lifecycle with a compare-and-set on the row, a single-consume
 * hook, a park marker to clear and a Jira lifecycle attached to it, and that
 * lifecycle already exists once, in answerClarificationAndResume, shared by the
 * dashboard route and the Jira comment path. So this tool resolves a row, calls that
 * core, and maps its outcomes. It does not touch clarification_requests, does not
 * call resumeHook and does not write a run status: a third implementation of any of
 * those would be a third set of races to keep in agreement, and the CAS in the core
 * is exactly what stops two channels from resuming one run twice.
 *
 * Cancelling follows the same rule for the same reason, and carries one extra lesson:
 * it calls cancelRunForOperator, not the cancel core underneath it, because AIW-240
 * was exactly a caller that reached the core and skipped the schedule-ledger settle
 * around it.
 */

type ClarificationView = {
  clarificationId: string;
  status: "pending" | "answered";
  // Null for a row written before the block that asked was recorded; a caller uses it
  // to tell a which-repository question from a planning one, so it is reported as it
  // is rather than defaulted to something that reads like a real block id.
  blockId: string | null;
  questions: string[];
  suggestedAnswers: string[] | null;
  askedAt: string;
  expiresAt: string | null;
  ticketKey: string | null;
  // False for a row that already carries an answer whose resume is still owed, which
  // is a real state (a lost dashboard resume the cron heals) and not the same thing
  // as nobody having answered. Answering an unanswerable row can only be refused, so
  // a caller is told before it tries.
  answerable: boolean;
};

type GetClarificationData = {
  runId: string;
  clarification: ClarificationView | null;
};

type AnswerClarificationData = {
  clarificationId: string;
  runId: string;
  status: "answered";
  answeredAt: string;
  // The MCP client behind the answer, exactly as it was stored on the row, so a
  // caller can see the attribution the resumed agent and the ticket will show.
  answeredByLabel: string;
  ticketKey: string | null;
};

type CancelRunData = {
  runId: string;
  // "already_terminal" is reported as data rather than as an error: the run is stopped,
  // which is what the caller wanted, and a CONFLICT here would push an agent into
  // retrying something already done. The dashboard answers 200 for the same reason.
  outcome: "cancelled" | "already_terminal";
  // The claim this cancel released, so a caller can see which subject is now free.
  // Null on already_terminal: there was no claim left to release.
  subjectKey: string | null;
  // As observed, and only meaningful on already_terminal. It MAY read non-terminal,
  // because workflow_runs can lag the registry; reporting it raw beats inventing a
  // status the row does not carry.
  runStatus: string | null;
  // Whether the schedule occurrence behind this run was closed. Null when there was
  // no occurrence to close (any non-schedule run), false when one should have been
  // found and was not, which the worker logs and the drain heals.
  scheduleOccurrenceSettled: boolean | null;
};

/** Raised before the core was reached, or by an outcome that provably wrote nothing,
 *  so the idempotency key returns to circulation. Deliberately local rather than
 *  imported from authoring-support: that module is scoped to store writes behind the
 *  authoring scopes, and nothing here is authoring. */
function refused(
  code: McpPublicError["code"],
  message: string,
  retryable = false,
): McpPublicError {
  return new McpPublicError(code, message, retryable, undefined, true);
}

function toView(row: HookClarificationRow): ClarificationView {
  return {
    clarificationId: row.id,
    // The store only ever returns these two statuses from the resumable lookups.
    status: row.status === "answered" ? "answered" : "pending",
    blockId: row.blockId,
    questions: row.questions,
    suggestedAnswers: row.suggestedAnswers,
    askedAt: row.askedAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    ticketKey: row.ticketKey,
    answerable: row.status === "pending",
  };
}

/**
 * NOT_FOUND for a run id nothing knows, `clarification: null` for a real run that is
 * not waiting. Two lookups because a freshly bound run exists in active_runs before
 * its workflow_runs row is written (the same two-stage reverse lookup cancelRunById
 * documents), so either one alone would report a live run as unknown or a finished
 * one as unknown. Only reached when there is no clarification to return: a resolved
 * row is already proof the run exists.
 */
async function assertRunExists(
  db: McpToolDependencies["db"],
  runId: string,
): Promise<void> {
  const [claim, outcome] = await Promise.all([
    findLiveRunClaimByRunId(db, runId),
    findRunOutcomeByRunId(db, runId),
  ]);
  if (!claim && !outcome) throw refused("NOT_FOUND", "Run not found");
}

/** The identity of an answer: which run, which question it is bound to (null when the
 *  caller did not bind one), and the text. This is what "same key, same payload" has
 *  to compare, and it becomes the audit row's inputHash, so the answer travels as a
 *  digest rather than as free text kept for a year. The idempotency key stays outside
 *  the hash: it is the thing this payload is compared FOR. */
function answerPayloadHash(identity: {
  runId: string;
  clarificationId: string | null;
  answer: string;
}): string {
  return `sha256:${hashCanonicalJson(identity)}`;
}

/**
 * Every outcome the core can return, mapped onto a code an agent can act on. The
 * switch is exhaustive on purpose: when a new outcome is added to the union (AIW-265
 * adds `ticket_transition_failed`), this stops compiling instead of quietly
 * answering INTERNAL_ERROR for a state the core describes precisely.
 */
function throwForOutcome(
  outcome: Exclude<AnswerClarificationOutcome, { kind: "answered" }>,
): never {
  switch (outcome.kind) {
    case "invalid_answer":
      // The catalog bounds already refuse an empty or oversized answer, so reaching
      // this means the core's own rule moved. Nothing was written either way.
      throw refused("VALIDATION_FAILED", "The answer was rejected as empty or too long");
    case "conflict":
      // Not retryable: another channel (the dashboard, a Jira comment, another
      // agent) won the compare-and-set, and repeating this call cannot take it back.
      throw refused(
        "CONFLICT",
        "This clarification was already answered through another channel, or the run has moved on to a different question. Read it again with runs.get_clarification before answering.",
      );
    case "ticket_gone":
      // The one outcome that changed state on its way to failing: the core
      // superseded the clarification and settled the run as blocked, so the key must
      // keep this verdict rather than invite a retry against a ticket that is gone.
      throw new McpPublicError(
        "NOT_FOUND",
        "The ticket behind this clarification no longer exists, so the question was retired and its run settled as blocked. Nothing is left to answer.",
        false,
        undefined,
        false,
      );
    case "ticket_transition_failed":
      // The core orders the Jira transition before the answer CAS, so this leaves
      // the question pending and the run asleep. A repeat is safe and necessary.
      throw refused(
        "DEPENDENCY_UNAVAILABLE",
        "The ticket could not be moved back to the AI column, so the answer was not recorded and the run remains parked. Retry the same answer after the ticket tracker recovers.",
        true,
      );
    case "resume_failed_retryable":
      // The answer IS recorded and only its delivery was lost, so "effectNotApplied"
      // is literally false here, and it is still the right value: the field decides
      // whether a repeat under this key may run again, and a repeat here is
      // convergent rather than duplicating. The core recognizes the identical answer
      // as a retry and treats an already-consumed hook as won, so a second attempt
      // can only finish the delivery, never deliver twice. Sealing the key instead
      // would replay this failure forever and leave the agent no way to complete the
      // resume it already paid for. (The cron heals it eventually either way, via the
      // answered-retry branch in clarifications/resume-from-comments.ts, so the worst
      // case of being wrong here is a duplicate no-op, not a duplicate effect.)
      throw refused(
        "DEPENDENCY_UNAVAILABLE",
        "The answer was recorded but the run could not be resumed on this attempt. Send the identical answer again with the same idempotencyKey; a scheduled pass also retries it on its own.",
        true,
      );
  }
}

export function registerRunControlTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(
    server,
    "runs.get_clarification",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "runs.get_clarification",
        targetRefs: [input.runId],
        operation: async (): Promise<GetClarificationData> => {
          const row = await getResumableClarificationForRun(deps.db, input.runId);
          if (!row) {
            await assertRunExists(deps.db, input.runId);
            return { runId: input.runId, clarification: null };
          }
          return { runId: input.runId, clarification: toView(row) };
        },
      });
      // No trust override: the questions and suggested answers are agent-authored
      // prose about somebody else's repository, which is what external_untrusted
      // marks, and it is already the default.
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "runs.answer_clarification",
    async (input) => {
      const envelope = await executeMcpMutation({
        deps,
        toolName: "runs.answer_clarification",
        // The run, and the question when the caller bound one. Never the answer
        // text: targetRefs are stored verbatim for a year (audit-store.ts), and the
        // only record of the text this tool leaves is the payload digest.
        targetRefs: input.clarificationId
          ? [input.runId, input.clarificationId]
          : [input.runId],
        idempotencyKey: input.idempotencyKey,
        payloadHash: answerPayloadHash({
          runId: input.runId,
          clarificationId: input.clarificationId ?? null,
          answer: input.answer,
        }),
        operation: async (): Promise<AnswerClarificationData> => {
          const row = await getResumableClarificationForRun(deps.db, input.runId);
          if (!row) {
            await assertRunExists(deps.db, input.runId);
            throw refused(
              "CONFLICT",
              "This run is not waiting on human input: it never parked on a question, it was already answered and resumed, or its clarification expired. Check runs.get_clarification.",
            );
          }
          // Binding is optional, but when the caller states which question it read,
          // answering a different one is refused rather than accepted. A run may ask
          // again with a reworded question, and free text answering the wrong round
          // is worse than a refusal the caller can recover from in one read.
          if (input.clarificationId && input.clarificationId !== row.id) {
            throw refused(
              "VALIDATION_FAILED",
              `This run is waiting on clarification ${row.id}, not ${input.clarificationId}. Read it again with runs.get_clarification and answer the question it returns.`,
            );
          }

          const outcome = await answerClarificationAndResume({
            db: deps.db,
            row,
            rawAnswer: input.answer,
            // The policy for this tool refuses the service role, so there is a person
            // behind userId; the fallback keeps the type honest rather than covering
            // a case that can reach here.
            actor: {
              id: deps.actor.userId ?? deps.actor.subject,
              // Names the client, not the platform: the label is stored on the row,
              // reaches the resumed agent's prompt and (once AIW-265 lands) the
              // ticket comment, so a person reading the ticket sees that an MCP
              // client answered rather than a colleague.
              label: `MCP ${deps.actor.clientId}`,
            },
            issueTracker: deps.adapters.issueTracker,
          });
          if (outcome.kind !== "answered") throwForOutcome(outcome);

          return {
            clarificationId: outcome.row.id,
            runId: outcome.row.runId,
            status: "answered",
            answeredAt: (outcome.row.answeredAt ?? deps.now()).toISOString(),
            answeredByLabel: outcome.row.answeredByLabel ?? `MCP ${deps.actor.clientId}`,
            ticketKey: outcome.row.ticketKey,
          };
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );

  registerCatalogTool(
    server,
    "runs.cancel",
    async (input) => {
      const envelope = await executeMcpMutation({
        deps,
        toolName: "runs.cancel",
        targetRefs: [input.runId],
        idempotencyKey: input.idempotencyKey,
        // The run id is the whole payload, so a repeat under the same key with a
        // different run id is a mistake worth refusing rather than a second cancel.
        payloadHash: `sha256:${hashCanonicalJson({ runId: input.runId })}`,
        operation: async (): Promise<CancelRunData> => {
          const result = await cancelRunForOperator(deps.db, input.runId, {
            // Lands in the durable "cancelled by <actor>" reason on the run, so a
            // person reading why their run stopped sees which client stopped it.
            actorLabel: `MCP ${deps.actor.clientId}`,
            runRegistry: deps.adapters.runRegistry,
          });

          switch (result.outcome) {
            case "cancelled":
            case "already_terminal":
              return {
                runId: input.runId,
                outcome: result.outcome,
                subjectKey: result.subjectKey ?? null,
                runStatus: result.status ?? null,
                scheduleOccurrenceSettled: result.scheduleOccurrenceSettled,
              };
            case "unconfirmed":
              // The claim is retained and Workflow was never touched (cancel-run.ts:
              // "A live run cancellation that never began"), so nothing was torn down
              // and the key must return to circulation for the retry to be possible.
              throw new McpPublicError(
                "CONFLICT",
                "The cancel could not be confirmed on this attempt and nothing was torn down: the run is still live and still owns its subject. Retry with the same idempotencyKey.",
                true,
                5_000,
                true,
              );
            case "not_found":
              throw refused("NOT_FOUND", "Run not found");
          }
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}
