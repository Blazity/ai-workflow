import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
import type { Db } from "../db/client.js";
import { clarificationRequests } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { dispatchClarificationAnswered } from "./dispatch.js";
import {
  recoverInterruptedClarificationParking,
  recoverUndispatchedClarificationSuccessors,
} from "./reconciliation.js";
import { getClarification } from "./store.js";

const start = vi.hoisted(() => vi.fn());
const getRun = vi.hoisted(() => vi.fn());
vi.mock("../../env.js", () => ({ env: { COLUMN_AI: "AI", JIRA_PROJECT_KEY: "AWT" } }));
vi.mock("workflow/api", () => ({
  start: (...args: unknown[]) => start(...args),
  getRun: (...args: unknown[]) => getRun(...args),
}));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agent-workflow" }));

const subjectKey = "ticket:jira:AWT-PARK-RACE";
const issueTracker = {} as IssueTrackerAdapter;
let db: Db;
let registry: PostgresRunRegistry;

beforeEach(async () => {
  start.mockReset().mockResolvedValue({ runId: "run-successor" });
  getRun.mockReset().mockReturnValue({ status: Promise.resolve("failed") });
  db = await createTestDb();
  registry = new PostgresRunRegistry(db);
  await registry.reserve({
    subjectKey,
    ticketKey: "AWT-PARK-RACE",
    ownerToken: "owner-predecessor",
    kind: "ticket",
  });
  await registry.bindRun(subjectKey, "owner-predecessor", "run-predecessor");
  await db.insert(clarificationRequests).values({
    id: "clarification-race",
    ticketKey: "AWT-PARK-RACE",
    subjectKey,
    ownerToken: "owner-predecessor",
    runId: "run-predecessor",
    blockId: "implementation",
    waitingNodeId: "implementation",
    definitionId: 7,
    definitionVersion: 4,
    definitionVersionPin: 4,
    originEntry: { kind: "ticket", ticketKey: "AWT-PARK-RACE" },
    originTriggerNodeId: "trigger",
    originTriggerType: "trigger_ticket_ai",
    triggerPayload: { status: "fired", ticketKey: "AWT-PARK-RACE" },
    priorSteps: {},
    interpreterState: { attempts: {}, executions: 0 },
    budgetState: {
      activeElapsedMs: 0,
      tokensInput: 0,
      tokensCached: 0,
      tokensOutput: 0,
      tokensKnown: true,
      costNanos: 0,
      costUsd: 0,
      costKnown: true,
    },
    runtimeContext: { preSandboxAdditions: { research: [], implementation: [], review: [] } },
    sourceHeads: [],
    checkpointState: "ready",
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    cleanupState: "none",
    publishedAt: new Date(),
    questions: ["Which implementation?"],
    status: "pending",
  });
});

describe("clarification answer-before-parking recovery", () => {
  it("records the answer without starting, then reconciliation hands off after the drain", async () => {
    const clarification = await getClarification(db, "clarification-race");
    if (!clarification) throw new Error("missing clarification fixture");

    await expect(
      dispatchClarificationAnswered({
        db,
        runRegistry: registry,
        issueTracker,
        clarification,
        answer: "Use the existing pattern",
        actor: { id: "user-1", label: "Alice" },
        maxConcurrentAgents: 2,
        isRetry: false,
        successorOwnerToken: "owner-successor",
      }),
    ).resolves.toEqual({ status: "recorded" });
    expect(start).not.toHaveBeenCalled();
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-predecessor",
      runId: "run-predecessor",
      state: "bound",
    });

    await expect(
      recoverInterruptedClarificationParking({ db, runRegistry: registry }),
    ).resolves.toBe(1);
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-predecessor",
      runId: "run-predecessor",
      state: "parked",
    });

    await expect(
      recoverUndispatchedClarificationSuccessors({
        db,
        runRegistry: registry,
        issueTracker,
        maxConcurrentAgents: 2,
      }),
    ).resolves.toBe(1);
    expect(start).toHaveBeenCalledOnce();
    expect(await registry.get(subjectKey)).toMatchObject({
      ownerToken: "owner-successor",
      runId: null,
      state: "reserved",
    });
  });
});
