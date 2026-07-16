import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../../db/test-db.js";
import type { Db } from "../../db/client.js";
import { clarificationRequests, workflowRuns } from "../../db/schema.js";
import { collectAwaitingRuns } from "./collect-awaiting-store.js";

const NOW = new Date("2026-06-16T12:00:00.000Z");
const HOUR = 3_600_000;
const JIRA = "https://blazity.atlassian.net";

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

const base = { jiraBaseUrl: JIRA, model: "claude-fallback", now: NOW };

async function seedRun(over: {
  runId: string;
  status?: string;
  ticketKey?: string | null;
  ticketTitle?: string | null;
  startedAt?: Date | null;
}): Promise<void> {
  await db.insert(workflowRuns).values({
    runId: over.runId,
    workflowId: "wf_agent",
    workflowName: "Agent",
    status: over.status ?? "awaiting",
    ticketKey: over.ticketKey === undefined ? "AWT-1" : over.ticketKey,
    ticketTitle: over.ticketTitle === undefined ? "A ticket" : over.ticketTitle,
    model: "claude-opus-4-8",
    startedAt: over.startedAt === undefined ? new Date(NOW.getTime() - HOUR) : over.startedAt,
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

  it("ignores non-awaiting runs", async () => {
    await seedRun({ runId: "run_done", status: "success", ticketKey: "AWT-3" });

    const rows = await collectAwaitingRuns({ ...base, db });
    expect(rows).toEqual([]);
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
