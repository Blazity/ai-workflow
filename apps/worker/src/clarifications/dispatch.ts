import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import type { Db } from "../db/client.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { AgentWorkflowInput } from "../workflows/agent-input.js";
import { agentWorkflow } from "../workflows/agent.js";
import { logger } from "../lib/logger.js";
import { reserveSubjectWithinCapacity } from "../lib/dispatch.js";
import {
  answerClarification,
  assertClarificationCheckpointAvailable,
  getClarification,
  reserveClarificationSuccessor,
  type ClarificationRow,
} from "./store.js";

export type DispatchClarificationAnsweredResult =
  | { status: "conflict" }
  | { status: "at_capacity" }
  | { status: "started"; runId: string };

/**
 * Answers a durable checkpoint and transfers its already-held subject to one
 * successor reservation. The successor token is written on the clarification
 * before owner handoff, so every crash boundary is retryable without claiming a
 * second subject or replaying the predecessor graph.
 */
export async function dispatchClarificationAnswered(input: {
  db: Db;
  runRegistry: RunRegistryAdapter;
  issueTracker: IssueTrackerAdapter;
  clarification: ClarificationRow;
  answer: string;
  actor: { id: string; label: string };
  /** Retained for route-call compatibility; the parked run already occupies capacity. */
  maxConcurrentAgents: number;
  isRetry: boolean;
  /** Deterministic tests may supply it; production generates a fresh durable token. */
  successorOwnerToken?: string;
}): Promise<DispatchClarificationAnsweredResult> {
  const {
    db,
    runRegistry,
    clarification,
    answer,
    actor,
    isRetry,
  } = input;
  if (typeof runRegistry.handoffBoundRun !== "function") {
    throw new Error("clarification owner handoff is unavailable");
  }

  let checkpoint: ClarificationRow;
  let successorOwnerToken: string;
  if (!isRetry) {
    successorOwnerToken =
      input.successorOwnerToken ?? `clarification:${clarification.id}:${randomUUID()}`;
    checkpoint = await answerClarification(db, {
      id: clarification.id,
      answer,
      actor,
      successorOwnerToken,
    });
    successorOwnerToken = checkpoint.successorOwnerToken ?? successorOwnerToken;
  } else {
    const fresh = await getClarification(db, clarification.id);
    if (!fresh || fresh.status !== "answered" || fresh.dispatchedRunId !== null) {
      return { status: "conflict" };
    }
    if (!fresh.successorOwnerToken) {
      throw new Error(
        "clarification successor reservation is missing; restart the ticket to rebuild the workspace",
      );
    }
    assertClarificationCheckpointAvailable(fresh);
    checkpoint = fresh;
    successorOwnerToken = fresh.successorOwnerToken;
  }

  let active = await runRegistry.get(checkpoint.subjectKey);
  let recreatedSuccessorReservation = false;
  if (isRetry && active === null) {
    const reservation = await reserveSubjectWithinCapacity(
      {
        subjectKey: checkpoint.subjectKey,
        ticketKey: checkpoint.ticketKey,
        kind: checkpoint.originEntry.kind === "pr_trigger" ? "pr_trigger" : "ticket",
      },
      successorOwnerToken,
      runRegistry,
      input.maxConcurrentAgents,
      () =>
        reserveClarificationSuccessor(db, {
          clarificationId: checkpoint.id,
          ownerToken: successorOwnerToken,
          kind:
            checkpoint.originEntry.kind === "pr_trigger"
              ? "pr_trigger"
              : "ticket",
        }),
    );
    if (reservation === "at_capacity") return { status: "at_capacity" };
    recreatedSuccessorReservation = reservation === "reserved";
    if (reservation === "already_claimed") {
      active = await runRegistry.get(checkpoint.subjectKey);
      if (active === null) return { status: "conflict" };
    }
  }
  if (
    active?.ownerToken === successorOwnerToken &&
    active.state === "bound" &&
    active.runId
  ) {
    return { status: "started", runId: active.runId };
  }

  const successorAlreadyReserved =
    recreatedSuccessorReservation ||
    (active?.ownerToken === successorOwnerToken &&
      active.state === "reserved" &&
      active.runId === null);
  if (!successorAlreadyReserved) {
    const handedOff = await runRegistry.handoffBoundRun(
      checkpoint.subjectKey,
      checkpoint.ownerToken,
      checkpoint.runId,
      successorOwnerToken,
    );
    if (!handedOff) {
      const after = await runRegistry.get(checkpoint.subjectKey);
      if (
        after?.ownerToken === successorOwnerToken &&
        after.state === "bound" &&
        after.runId
      ) {
        return { status: "started", runId: after.runId };
      }
      if (
        after?.ownerToken !== successorOwnerToken ||
        after.state !== "reserved" ||
        after.runId !== null
      ) {
        return { status: "conflict" };
      }
    }
  }

  const entry: AgentWorkflowInput = {
    kind: "clarification_answered",
    subjectKey: checkpoint.subjectKey,
    ticketKey: checkpoint.ticketKey,
    ownerToken: successorOwnerToken,
    ...(checkpoint.definitionId !== null
      ? { definitionId: checkpoint.definitionId }
      : {}),
    ...(checkpoint.definitionVersionPin !== null
      ? { definitionVersion: checkpoint.definitionVersionPin }
      : {}),
    clarificationRequestId: checkpoint.id,
  };
  const handle = await start(agentWorkflow, [entry]);
  logger.info(
    { ticketKey: checkpoint.ticketKey, runId: handle.runId },
    "clarification_answered_workflow_started",
  );
  return { status: "started", runId: handle.runId };
}
