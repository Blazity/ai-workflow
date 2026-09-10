import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";
import { approvalRequests, clarificationRequests, workflowRuns } from "../../db/schema.js";
import { collectAwaitingRuns } from "./collect-awaiting-store.js";
import type { BlockRunState, HarnessRunManifestRecord } from "@shared/contracts";

/** Minimal fixture: attributeRunModel only reads `.nodeId` / `.manifest.model.id`. */
function harnessManifest(nodeId: string, modelId: string): HarnessRunManifestRecord {
  return {
    nodeId,
    manifest: { model: { id: modelId } },
  } as unknown as HarnessRunManifestRecord;
}

const NOW = new Date("2026-06-16T12:00:00.000Z");
const HOUR = 3_600_000;
const JIRA = "https://blazity.atlassian.net";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const base = { jiraBaseUrl: JIRA, now: NOW };

async function seedRun(over: {
  runId: string;
  status?: string;
  ticketKey?: string | null;
  ticketTitle?: string | null;
  startedAt?: Date | null;
  model?: string | null;
  harnessManifests?: HarnessRunManifestRecord[] | null;
  blockStatuses?: Record<string, Omit<BlockRunState, "output">> | null;
}): Promise<void> {
  await db.insert(workflowRuns).values({
    runId: over.runId,
    workflowId: "wf_agent",
    workflowName: "Agent",
    status: over.status ?? "awaiting",
    ticketKey: over.ticketKey === undefined ? "AWT-1" : over.ticketKey,
    ticketTitle: over.ticketTitle === undefined ? "A ticket" : over.ticketTitle,
    model: over.model === undefined ? "claude-opus-4-8" : over.model,
    harnessManifests: over.harnessManifests ?? null,
    blockStatuses: over.blockStatuses ?? null,
    startedAt: over.startedAt === undefined ? new Date(NOW.getTime() - HOUR) : over.startedAt,
  });
}

async function seedApproval(over: {
  runId: string;
  ticketKey?: string;
  status?: string;
}): Promise<void> {
  await db.insert(approvalRequests).values({
    id: randomUUID(),
    ticketKey: over.ticketKey ?? "AWT-1",
    definitionId: 1,
    runId: over.runId,
    plan: { markdown: "# Plan" },
    status: over.status ?? "pending",
  });
}

async function seedClarification(over: {
  runId: string;
  ticketKey?: string;
  status?: string;
  questions?: string[];
  suggestedAnswers?: string[] | null;
  askedAt?: Date;
}): Promise<void> {
  await db.insert(clarificationRequests).values({
    id: randomUUID(),
    ticketKey: over.ticketKey ?? "AWT-1",
    runId: over.runId,
    questions: over.questions ?? ["Which environment?", "Ship behind a flag?"],
    suggestedAnswers: over.suggestedAnswers ?? null,
    status: over.status ?? "pending",
    askedAt: over.askedAt ?? new Date(NOW.getTime() - 30 * 60_000),
  });
}

describe("collectAwaitingRuns (store)", () => {
  it("enriches an awaiting run with its pending clarification, keeping the real run id", async () => {
    await seedRun({ runId: "run_await", ticketKey: "AWT-1", ticketTitle: "Ship it" });
    await seedClarification({
      runId: "run_await",
      questions: ["Which environment?", "Ship behind a flag?"],
      suggestedAnswers: ["staging", "yes"],
    });

    const rows = await collectAwaitingRuns({ ...base, db });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "run_await",
      ticket: "AWT-1",
      ticketTitle: "Ship it",
      status: "awaiting",
      question: "1. Which environment?\n2. Ship behind a flag?",
      suggestedAnswers: ["staging", "yes"],
      askedAtMin: 30,
      ticketUrl: "https://blazity.atlassian.net/browse/AWT-1",
    });
    // Real run started an hour ago; startedAtMin tracks the run, not the ask.
    expect(rows[0].startedAtMin).toBe(60);
  });

  it("still lists an awaiting run whose clarification was already answered (no pending row)", async () => {
    await seedRun({ runId: "run_answered", ticketKey: "AWT-2" });
    await seedClarification({
      runId: "run_answered",
      ticketKey: "AWT-2",
      status: "answered",
    });

    const rows = await collectAwaitingRuns({ ...base, db });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("run_answered");
    expect(rows[0].status).toBe("awaiting");
    // No pending row joined -> no question payload.
    expect(rows[0].question).toBeUndefined();
    expect(rows[0].suggestedAnswers).toBeUndefined();
    expect(rows[0].askedAtMin).toBeUndefined();
  });

  it("marks a run parked on a pending approval (no clarification) as awaitingKind approval", async () => {
    await seedRun({ runId: "run_approval", ticketKey: "AWT-4" });
    await seedApproval({ runId: "run_approval", ticketKey: "AWT-4" });

    const rows = await collectAwaitingRuns({ ...base, db });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("run_approval");
    expect(rows[0].awaitingKind).toBe("approval");
    expect(rows[0].approvalId).toBeDefined();
    // No clarification joined -> no question payload, guarding against the
    // dead-end "Answer" CTA rendering a null question as if it were one.
    expect(rows[0].question).toBeUndefined();
    expect(rows[0].suggestedAnswers).toBeUndefined();
    expect(rows[0].askedAtMin).toBeUndefined();
  });

  it("keeps a clarification row's shape unchanged even when a pending approval also exists", async () => {
    await seedRun({ runId: "run_await", ticketKey: "AWT-1", ticketTitle: "Ship it" });
    await seedClarification({
      runId: "run_await",
      questions: ["Which environment?", "Ship behind a flag?"],
      suggestedAnswers: ["staging", "yes"],
    });
    await seedApproval({ runId: "run_await", ticketKey: "AWT-1" });

    const rows = await collectAwaitingRuns({ ...base, db });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "run_await",
      question: "1. Which environment?\n2. Ship behind a flag?",
      suggestedAnswers: ["staging", "yes"],
      askedAtMin: 30,
    });
    // A clarification always wins the label: unset, exactly as before this join.
    expect(rows[0].awaitingKind).toBeUndefined();
    expect(rows[0].approvalId).toBeUndefined();
  });

  it("ignores non-awaiting runs", async () => {
    await seedRun({ runId: "run_done", status: "success", ticketKey: "AWT-3" });

    const rows = await collectAwaitingRuns({ ...base, db });
    expect(rows).toEqual([]);
  });

  it("attributes the parked block's harness model over the persisted org default", async () => {
    // A run parked mid-planning persists the org default from activeModel's
    // prepare_workspace seeding; the manifest holds what actually ran (AIW-253).
    await seedRun({
      runId: "run_parked",
      ticketKey: "AWT-20",
      model: "claude-opus-4-8",
      harnessManifests: [
        harnessManifest("planning-1", "gpt-5.6-sol"),
        harnessManifest("review-1", "claude-opus-4-8"),
      ],
      blockStatuses: {
        "planning-1": { status: "running" },
        "review-1": { status: "pending" },
      },
    });
    await seedClarification({ runId: "run_parked", ticketKey: "AWT-20" });

    const rows = await collectAwaitingRuns({ ...base, db });
    expect(rows[0].model).toBe("gpt-5.6-sol");
  });

  it("reports no model for a parked run with no attribution evidence", async () => {
    await seedRun({ runId: "run_bare", ticketKey: "AWT-21", model: null });
    await seedClarification({ runId: "run_bare", ticketKey: "AWT-21" });

    const rows = await collectAwaitingRuns({ ...base, db });
    expect(rows[0].model).toBeNull();
  });

  it("orders newest ask first", async () => {
    await seedRun({ runId: "run_old", ticketKey: "AWT-10" });
    await seedClarification({
      runId: "run_old",
      ticketKey: "AWT-10",
      askedAt: new Date(NOW.getTime() - 120 * 60_000),
    });
    await seedRun({ runId: "run_new", ticketKey: "AWT-11" });
    await seedClarification({
      runId: "run_new",
      ticketKey: "AWT-11",
      askedAt: new Date(NOW.getTime() - 5 * 60_000),
    });

    const rows = await collectAwaitingRuns({ ...base, db });
    expect(rows.map((r) => r.id)).toEqual(["run_new", "run_old"]);
  });
});
