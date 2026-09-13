import { createHash, randomUUID } from "node:crypto";
import { start } from "workflow/api";
import type {
  ManualDispatchInput,
  ManualDispatchPreflightResponse,
  ManualDispatchRequest,
  ManualDispatchResponse,
} from "@shared/contracts";
import { env } from "../../infra/vcs-config.js";
import type { Adapters } from "../../engine/support/adapters.js";
import { reserveSubjectWithinCapacity } from "../dispatch/index.js";
import type { RepositoryCatalogSnapshot } from "../repository-catalog/index.js";
import { aiColumnMoveTarget, moveTicketForRun } from "../tickets/index.js";
import type { Db } from "../../db/types.js";
import type { AgentWorkflowInput, PrTriggerPayload } from "../../engine/index.js";
import { agentWorkflow } from "../../engine/index.js";
import {
  readConnectedDeployedWorkflowDefinitionVersion,
  readDeployedWorkflowDefinitionVersion,
} from "../../engine/stored-definition-reads.js";
import { ManualDispatchError } from "./errors.js";
import {
  acknowledgeManualDispatchStarted,
  acknowledgeConnectedManualDispatchStarted,
  createConnectedManualDispatchRequest,
  createManualDispatchRequest,
  getConnectedManualDispatchRequest,
  getManualDispatchRequest,
  listRecoverableManualDispatches,
  listConnectedRecoverableManualDispatches,
  markManualDispatchCandidateStarted,
  markConnectedManualDispatchCandidateStarted,
  markManualDispatchFailed,
  markConnectedManualDispatchFailed,
  markManualDispatchPrepared,
  markConnectedManualDispatchPrepared,
  reserveManualDispatchRequest,
  reserveConnectedManualDispatchRequest,
  resetManualDispatchToPending,
  resetConnectedManualDispatchToPending,
  type ManualDispatchRow,
} from "../../db/repositories/manual-dispatch.js";
import { resolveConnectedManualDispatch, resolveManualDispatch, type ResolvedManualDispatch } from "./resolve.js";

export interface ManualDispatchActor {
  id: string;
  label: string;
}

type ManualExecutionStore = {
  getDeployed(definitionId: number): ReturnType<typeof readDeployedWorkflowDefinitionVersion>;
  get(requestId: string): ReturnType<typeof getManualDispatchRequest>;
  reserve(requestId: string, ownerToken: string): ReturnType<typeof reserveManualDispatchRequest>;
  prepare(requestId: string, ownerToken: string, payload?: Record<string, unknown>): ReturnType<typeof markManualDispatchPrepared>;
  candidateStarted(requestId: string, ownerToken: string, runId: string): ReturnType<typeof markManualDispatchCandidateStarted>;
  fail(requestId: string, code: string, message: string): ReturnType<typeof markManualDispatchFailed>;
  transitionTicket(input: Omit<Parameters<typeof moveTicketForRun>[0], "db">): Promise<void>;
  resolve(input: Omit<Parameters<typeof resolveManualDispatch>[0], "db">): ReturnType<typeof resolveManualDispatch>;
};

function explicitExecutionStore(db: Db): ManualExecutionStore {
  return {
    getDeployed: (definitionId) => readDeployedWorkflowDefinitionVersion(db, definitionId),
    get: (requestId) => getManualDispatchRequest(db, requestId),
    reserve: (requestId, ownerToken) => reserveManualDispatchRequest(db, requestId, ownerToken),
    prepare: (requestId, ownerToken, payload) => markManualDispatchPrepared(db, requestId, ownerToken, payload),
    candidateStarted: (requestId, ownerToken, runId) => markManualDispatchCandidateStarted(db, requestId, ownerToken, runId),
    fail: (requestId, code, message) => markManualDispatchFailed(db, requestId, code, message),
    transitionTicket: (input) => moveTicketForRun({ ...input, db }),
    resolve: (input) => resolveManualDispatch({ ...input, db }),
  };
}

const connectedExecutionStore: ManualExecutionStore = {
  getDeployed: readConnectedDeployedWorkflowDefinitionVersion,
  get: getConnectedManualDispatchRequest,
  reserve: reserveConnectedManualDispatchRequest,
  prepare: markConnectedManualDispatchPrepared,
  candidateStarted: markConnectedManualDispatchCandidateStarted,
  fail: markConnectedManualDispatchFailed,
  transitionTicket: async (input) => {
    const { moveConnectedTicketForRun } = await import("../tickets/ticket-transition.js");
    return moveConnectedTicketForRun(input);
  },
  resolve: async (input) => {
    const { resolveConnectedManualDispatch: resolveConnected } = await import("./resolve.js");
    return resolveConnected(input);
  },
};

export async function preflightManualDispatch(input: {
  db: Db;
  adapters: Adapters;
  definitionId: number;
  triggerNodeId: string;
  dispatchInput: ManualDispatchInput;
  maxConcurrentAgents: number;
  repositoryCatalog: RepositoryCatalogSnapshot;
}): Promise<ManualDispatchPreflightResponse> {
  const resolved = await resolveManualDispatch({
    db: input.db,
    issueTracker: input.adapters.issueTracker,
    definitionId: input.definitionId,
    triggerNodeId: input.triggerNodeId,
    dispatchInput: input.dispatchInput,
    repositoryCatalog: input.repositoryCatalog,
  });
  const active = await input.adapters.runRegistry.get(resolved.subjectKey);
  const atCapacity =
    !active && (await capacityCount(input.adapters)) >= input.maxConcurrentAgents;
  return {
    definitionId: resolved.definitionId,
    definitionName: resolved.definitionName,
    deployedVersion: resolved.definitionVersion,
    triggerNodeId: resolved.triggerNodeId,
    triggerType: resolved.triggerType,
    input: resolved.input,
    subject: {
      kind: resolved.inputKind === "ticket" ? "ticket" : "pull_request",
      key:
        resolved.inputKind === "ticket"
          ? resolved.ticketKey
          : `${(resolved.inputPayload.pr as PrTriggerPayload).repoPath}#${(resolved.inputPayload.pr as PrTriggerPayload).prNumber}`,
      title: resolved.subjectTitle,
      ...(resolved.inputKind === "ticket"
        ? { currentStatus: resolved.currentStatus }
        : { url: resolved.subjectUrl }),
    },
    steps: resolved.steps,
    runnable: !active && !atCapacity,
    ...(active
      ? {
          blocker: {
            code: "active_run" as const,
            message: "This ticket or pull request already has an active workflow run.",
          },
        }
      : atCapacity
        ? {
            blocker: {
              code: "at_capacity" as const,
              message: "All workflow execution slots are currently in use.",
            },
          }
        : {}),
  };
}

/** Production preflight with persistence expressed as named connected reads. */
export async function preflightConnectedManualDispatch(
  input: Omit<Parameters<typeof preflightManualDispatch>[0], "db">,
): Promise<ManualDispatchPreflightResponse> {
  const resolved = await resolveConnectedManualDispatch({
    issueTracker: input.adapters.issueTracker,
    definitionId: input.definitionId,
    triggerNodeId: input.triggerNodeId,
    dispatchInput: input.dispatchInput,
    repositoryCatalog: input.repositoryCatalog,
  });
  const active = await input.adapters.runRegistry.get(resolved.subjectKey);
  const atCapacity = !active && (await capacityCount(input.adapters)) >= input.maxConcurrentAgents;
  return {
    definitionId: resolved.definitionId,
    definitionName: resolved.definitionName,
    deployedVersion: resolved.definitionVersion,
    triggerNodeId: resolved.triggerNodeId,
    triggerType: resolved.triggerType,
    input: resolved.input,
    subject: {
      kind: resolved.inputKind === "ticket" ? "ticket" : "pull_request",
      key: resolved.inputKind === "ticket" ? resolved.ticketKey : `${(resolved.inputPayload.pr as PrTriggerPayload).repoPath}#${(resolved.inputPayload.pr as PrTriggerPayload).prNumber}`,
      title: resolved.subjectTitle,
      ...(resolved.inputKind === "ticket" ? { currentStatus: resolved.currentStatus } : { url: resolved.subjectUrl }),
    },
    steps: resolved.steps,
    runnable: !active && !atCapacity,
    ...(active ? { blocker: { code: "active_run" as const, message: "This ticket or pull request already has an active workflow run." } } : atCapacity ? { blocker: { code: "at_capacity" as const, message: "All workflow execution slots are currently in use." } } : {}),
  };
}

export async function dispatchManualWorkflow(input: {
  db: Db;
  adapters: Adapters;
  definitionId: number;
  triggerNodeId: string;
  request: ManualDispatchRequest;
  actor: ManualDispatchActor;
  maxConcurrentAgents: number;
  repositoryCatalog: RepositoryCatalogSnapshot;
}): Promise<ManualDispatchResponse> {
  const resolved = await resolveManualDispatch({
    db: input.db,
    issueTracker: input.adapters.issueTracker,
    definitionId: input.definitionId,
    triggerNodeId: input.triggerNodeId,
    dispatchInput: input.request.input,
    repositoryCatalog: input.repositoryCatalog,
  });
  if (resolved.definitionVersion !== input.request.expectedDeployedVersion) {
    throw new ManualDispatchError(
      409,
      "deployment_changed",
      "The deployed workflow changed. Run the preflight again.",
    );
  }
  const payloadHash = hashRequest({
    definitionId: input.definitionId,
    definitionVersion: resolved.definitionVersion,
    triggerNodeId: input.triggerNodeId,
    input: resolved.input,
  });
  const persisted = await createManualDispatchRequest(input.db, {
    requestId: input.request.requestId,
    payloadHash,
    definitionId: resolved.definitionId,
    definitionVersion: resolved.definitionVersion,
    triggerNodeId: resolved.triggerNodeId,
    triggerType: resolved.triggerType,
    inputKind: resolved.inputKind,
    subjectKey: resolved.subjectKey,
    ticketKey: resolved.ticketKey,
    inputPayload: resolved.inputPayload,
    actorUserId: input.actor.id,
    actorLabel: input.actor.label,
  });
  if (!persisted.inserted && persisted.row.payloadHash !== payloadHash) {
    throw new ManualDispatchError(
      409,
      "invalid_input",
      "That request ID was already used for different dispatch input.",
    );
  }
  if (!persisted.inserted) return storedResponse(persisted.row);
  return processManualDispatch({
    db: input.db,
    store: explicitExecutionStore(input.db),
    adapters: input.adapters,
    row: persisted.row,
    requireCurrentDeployment: true,
    maxConcurrentAgents: input.maxConcurrentAgents,
    repositoryCatalog: input.repositoryCatalog,
  });
}

export async function dispatchConnectedManualWorkflow(
  input: Omit<Parameters<typeof dispatchManualWorkflow>[0], "db">,
): Promise<ManualDispatchResponse> {
  const resolved = await resolveConnectedManualDispatch({
    issueTracker: input.adapters.issueTracker,
    definitionId: input.definitionId,
    triggerNodeId: input.triggerNodeId,
    dispatchInput: input.request.input,
    repositoryCatalog: input.repositoryCatalog,
  });
  if (resolved.definitionVersion !== input.request.expectedDeployedVersion) {
    throw new ManualDispatchError(409, "deployment_changed", "The deployed workflow changed. Run the preflight again.");
  }
  const payloadHash = hashRequest({ definitionId: input.definitionId, definitionVersion: resolved.definitionVersion, triggerNodeId: input.triggerNodeId, input: resolved.input });
  const persisted = await createConnectedManualDispatchRequest({
    requestId: input.request.requestId, payloadHash, definitionId: resolved.definitionId,
    definitionVersion: resolved.definitionVersion, triggerNodeId: resolved.triggerNodeId,
    triggerType: resolved.triggerType, inputKind: resolved.inputKind, subjectKey: resolved.subjectKey,
    ticketKey: resolved.ticketKey, inputPayload: resolved.inputPayload,
    actorUserId: input.actor.id, actorLabel: input.actor.label,
  });
  if (!persisted.inserted && persisted.row.payloadHash !== payloadHash) {
    throw new ManualDispatchError(409, "invalid_input", "That request ID was already used for different dispatch input.");
  }
  if (!persisted.inserted) return storedResponse(persisted.row);
  return processManualDispatch({ store: connectedExecutionStore, adapters: input.adapters, row: persisted.row, requireCurrentDeployment: true, maxConcurrentAgents: input.maxConcurrentAgents, repositoryCatalog: input.repositoryCatalog });
}

function storedResponse(row: ManualDispatchRow): ManualDispatchResponse {
  if (
    (row.status === "candidate_started" || row.status === "started") &&
    row.runId
  ) {
    return { requestId: row.requestId, status: "started", runId: row.runId };
  }
  if (row.status === "failed") throw storedFailure(row);
  return { requestId: row.requestId, status: "recovering" };
}

export async function recoverManualDispatches(input: {
  db?: Db;
  adapters: Adapters;
  maxConcurrentAgents: number;
  repositoryCatalog: RepositoryCatalogSnapshot;
}): Promise<{ scanned: number; started: number; recovering: number; failed: number }> {
  const store = input.db ? explicitExecutionStore(input.db) : connectedExecutionStore;
  const rows = input.db
    ? await listRecoverableManualDispatches(input.db)
    : await listConnectedRecoverableManualDispatches();
  const metrics = { scanned: rows.length, started: 0, recovering: 0, failed: 0 };
  for (const listed of rows) {
    let row = listed;
    try {
      if (row.ownerToken) {
        const active = await input.adapters.runRegistry.get(row.subjectKey);
        if (
          active?.ownerToken === row.ownerToken &&
          active.runId &&
          active.state !== "reserved"
        ) {
          if (input.db) {
            await acknowledgeManualDispatchStarted(
              input.db,
              row.requestId,
              row.ownerToken,
              active.runId,
            );
          } else {
            await acknowledgeConnectedManualDispatchStarted(
              row.requestId,
              row.ownerToken,
              active.runId,
            );
          }
          metrics.started++;
          continue;
        }
        if (!active) {
          const reset = input.db
            ? await resetManualDispatchToPending(input.db, row.requestId, row.ownerToken)
            : await resetConnectedManualDispatchToPending(row.requestId, row.ownerToken);
          if (!reset) {
            metrics.recovering++;
            continue;
          }
          row = (await store.get(row.requestId))!;
        } else if (active.ownerToken !== row.ownerToken) {
          await store.fail(
            row.requestId,
            "active_run",
            "The subject is now owned by another workflow run.",
          );
          metrics.failed++;
          continue;
        }
      }
      const dispatchInput = storedInput(row);
      const resolveInput = {
        issueTracker: input.adapters.issueTracker,
        definitionId: row.definitionId,
        triggerNodeId: row.triggerNodeId,
        dispatchInput,
        definitionVersion: row.definitionVersion,
        repositoryCatalog: input.repositoryCatalog,
      };
      const resolved = input.db
        ? await resolveManualDispatch({ ...resolveInput, db: input.db })
        : await resolveConnectedManualDispatch(resolveInput);
      if (
        resolved.definitionVersion !== row.definitionVersion ||
        hashRequest({
          definitionId: row.definitionId,
          definitionVersion: row.definitionVersion,
          triggerNodeId: row.triggerNodeId,
          input: resolved.input,
        }) !== row.payloadHash
      ) {
        await failAndRelease({ ...input, store }, row, "deployment_changed", "The pinned dispatch is no longer valid.");
        metrics.failed++;
        continue;
      }
      const result = await processManualDispatch({
        ...input,
        store,
        row,
        requireCurrentDeployment: false,
      });
      if (result.status === "started") metrics.started++;
      else metrics.recovering++;
    } catch (error) {
      if (error instanceof ManualDispatchError && error.statusCode < 500) {
        await failAndRelease({ ...input, store }, row, error.code, error.message);
        metrics.failed++;
      } else {
        metrics.recovering++;
      }
    }
  }
  return metrics;
}

async function processManualDispatch(input: {
  db?: Db;
  store: ManualExecutionStore;
  adapters: Adapters;
  row: ManualDispatchRow;
  requireCurrentDeployment: boolean;
  maxConcurrentAgents: number;
  repositoryCatalog: RepositoryCatalogSnapshot;
}): Promise<ManualDispatchResponse> {
  if (input.row.status === "started" && input.row.runId) {
    return { requestId: input.row.requestId, status: "started", runId: input.row.runId };
  }
  if (input.row.status === "failed") {
    throw storedFailure(input.row);
  }

  let ownerToken = input.row.ownerToken;
  if (!ownerToken) {
    ownerToken = `owner:${randomUUID()}`;
    const reservation = await reserveSubjectWithinCapacity(
      {
        subjectKey: input.row.subjectKey,
        ticketKey: input.row.ticketKey,
        kind:
          input.row.inputKind === "ticket"
            ? "manual_ticket"
            : "manual_pr_trigger",
      },
      ownerToken,
      input.adapters.runRegistry,
      input.maxConcurrentAgents,
    );
    if (reservation !== "reserved") {
      const code = reservation === "at_capacity" ? "at_capacity" : "active_run";
      await input.store.fail(
        input.row.requestId,
        code,
        reservation === "at_capacity"
          ? "All workflow execution slots are currently in use."
          : "This ticket or pull request already has an active workflow run.",
      );
      throw new ManualDispatchError(
        409,
        code,
        reservation === "at_capacity"
          ? "All workflow execution slots are currently in use."
          : "This ticket or pull request already has an active workflow run.",
      );
    }
    if (!(await input.store.reserve(input.row.requestId, ownerToken))) {
      await input.adapters.runRegistry
        .releaseReservation(input.row.subjectKey, ownerToken)
        .catch(() => false);
      const fresh = await input.store.get(input.row.requestId);
      if (fresh?.status === "started" && fresh.runId) {
        return { requestId: fresh.requestId, status: "started", runId: fresh.runId };
      }
      return { requestId: input.row.requestId, status: "recovering" };
    }
  }

  if (input.requireCurrentDeployment) {
    const deployed = await input.store.getDeployed(input.row.definitionId);
    if (deployed?.version !== input.row.definitionVersion) {
      await failAndRelease(
        input,
        { ...input.row, ownerToken },
        "deployment_changed",
        "The deployed workflow changed. Run the preflight again.",
      );
      throw new ManualDispatchError(
        409,
        "deployment_changed",
        "The deployed workflow changed. Run the preflight again.",
      );
    }
  }

  let resolved: ResolvedManualDispatch;
  try {
    resolved = await input.store.resolve({
      issueTracker: input.adapters.issueTracker,
      definitionId: input.row.definitionId,
      triggerNodeId: input.row.triggerNodeId,
      dispatchInput: storedInput(input.row),
      definitionVersion: input.row.definitionVersion,
      repositoryCatalog: input.repositoryCatalog,
    });
  } catch (error) {
    if (error instanceof ManualDispatchError && error.statusCode < 500) {
      await failAndRelease(input, { ...input.row, ownerToken }, error.code, error.message);
      throw error;
    }
    return { requestId: input.row.requestId, status: "recovering" };
  }
  if (
    resolved.definitionVersion !== input.row.definitionVersion ||
    resolved.subjectKey !== input.row.subjectKey ||
    resolved.triggerType !== input.row.triggerType
  ) {
    await failAndRelease(
      input,
      { ...input.row, ownerToken },
      "deployment_changed",
      "The deployed workflow or resolved subject changed. Run the preflight again.",
    );
    throw new ManualDispatchError(
      409,
      "deployment_changed",
      "The deployed workflow or resolved subject changed. Run the preflight again.",
    );
  }

  if (resolved.inputKind === "ticket") {
    try {
      await input.store.transitionTicket({
        issueTracker: input.adapters.issueTracker,
        ticketKey: resolved.ticketKey,
        target: aiColumnMoveTarget({
          COLUMN_AI: resolved.aiColumn,
          JIRA_AI_TRANSITION_ID: env.JIRA_AI_TRANSITION_ID,
        }),
        owner: {
          subjectKey: resolved.subjectKey,
          ownerToken,
          runId: null,
        },
        requiredOwnerState: "reserved",
      });
      if (
        !(await input.store.prepare(
          input.row.requestId,
          ownerToken,
          resolved.inputPayload,
        ))
      ) {
        return { requestId: input.row.requestId, status: "recovering" };
      }
    } catch {
      await input.adapters.runRegistry
        .releaseReservation(input.row.subjectKey, ownerToken)
        .catch(() => false);
      await input.store.fail(
        input.row.requestId,
        "provider_unavailable",
        "Jira could not move the ticket to the AI column.",
      );
      throw new ManualDispatchError(
        502,
        "provider_unavailable",
        "Jira could not move the ticket to the AI column.",
      );
    }
  } else if (
    !(await input.store.prepare(
      input.row.requestId,
      ownerToken,
      resolved.inputPayload,
    ))
  ) {
    return { requestId: input.row.requestId, status: "recovering" };
  }

  try {
    const workflowInput = workflowInputFor(resolved, ownerToken, input.row.requestId);
    const handle = await start(agentWorkflow, [workflowInput]);
    const startedRun = {
      subjectKey: resolved.subjectKey,
      ticketKey: resolved.ticketKey ?? null,
      ownerToken,
      runId: handle.runId,
      kind:
        resolved.inputKind === "ticket"
          ? "manual_ticket"
          : "manual_pr_trigger",
    } as const;
    const { commitHostedStart } = await import(
      "../run-lifecycle/run-start-lifecycle.js"
    );
    const committed = await commitHostedStart(
      input.adapters.runRegistry,
      startedRun,
    );
    if (!committed) {
      return { requestId: input.row.requestId, status: "recovering" };
    }
    const recorded = await input.store.candidateStarted(
      input.row.requestId,
      ownerToken,
      handle.runId,
    );
    if (!recorded) {
      const fresh = await input.store.get(input.row.requestId);
      if (fresh?.status === "started" && fresh.runId) {
        return { requestId: fresh.requestId, status: "started", runId: fresh.runId };
      }
      return { requestId: input.row.requestId, status: "recovering" };
    }
    return {
      requestId: input.row.requestId,
      status: "started",
      runId: handle.runId,
    };
  } catch {
    // The ticket may already be in AI and start() may have accepted the
    // candidate before losing its response. Retain both durable request and
    // reservation so cron recovery retries this exact pinned dispatch.
    return { requestId: input.row.requestId, status: "recovering" };
  }
}

function workflowInputFor(
  resolved: ResolvedManualDispatch,
  ownerToken: string,
  requestId: string,
): AgentWorkflowInput {
  if (resolved.inputKind === "ticket") {
    return {
      kind: "ticket",
      subjectKey: resolved.subjectKey,
      ticketKey: resolved.ticketKey,
      ownerToken,
      definitionId: resolved.definitionId,
      definitionVersion: resolved.definitionVersion,
      manualDispatchId: requestId,
    };
  }
  return {
    kind: "pr_trigger",
    triggerType: resolved.triggerType,
    subjectKey: resolved.subjectKey,
    ...(resolved.ticketKey ? { ticketKey: resolved.ticketKey } : {}),
    ownerToken,
    definitionId: resolved.definitionId,
    definitionVersion: resolved.definitionVersion,
    scope: resolved.inputPayload.scope,
    pr: resolved.inputPayload.pr,
    manualDispatchId: requestId,
  };
}

async function capacityCount(adapters: Adapters): Promise<number> {
  const entries = adapters.runRegistry.listCapacityConsumers
    ? await adapters.runRegistry.listCapacityConsumers()
    : await adapters.runRegistry.listAll();
  return entries.length;
}

function storedInput(row: ManualDispatchRow): ManualDispatchInput {
  if (row.inputKind === "ticket") {
    return { kind: "ticket", ticketKey: row.ticketKey! };
  }
  const pr = row.inputPayload.pr as unknown as PrTriggerPayload;
  return { kind: "pull_request", url: pr.prUrl };
}

function hashRequest(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function storedFailure(row: ManualDispatchRow): ManualDispatchError {
  const statusCode =
    row.errorCode === "provider_unavailable"
      ? 502
      : row.errorCode === "invalid_input" || row.errorCode === "not_eligible"
        ? 422
        : 409;
  return new ManualDispatchError(
    statusCode,
    (row.errorCode ?? "invalid_input") as ManualDispatchError["code"],
    row.errorMessage ?? "Manual dispatch failed.",
  );
}

async function failAndRelease(
  input: {
    store: Pick<ManualExecutionStore, "fail">;
    adapters: Adapters;
  },
  row: ManualDispatchRow,
  code: ManualDispatchError["code"],
  message: string,
): Promise<void> {
  if (row.ownerToken) {
    await input.adapters.runRegistry
      .releaseReservation(row.subjectKey, row.ownerToken)
      .catch(() => false);
  }
  await input.store.fail(row.requestId, code, message);
}
