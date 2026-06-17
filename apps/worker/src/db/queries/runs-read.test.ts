import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../test-db.js";
import type { Db } from "../client.js";
import { workflowRuns } from "../schema.js";
import type { WorkflowMeta } from "@shared/contracts";
import {
  parseWindow,
  parseSearch,
  listRuns,
  runKpis,
  workflowAgg,
  costAgg,
} from "./runs-read.js";

const NOW = new Date("2026-06-16T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JIRA = "https://blazity.atlassian.net";

const REGISTRY: WorkflowMeta[] = [
  { id: "wf_agent", name: "Agent", blurb: "", gateway: "anthropic", primary: true },
  { id: "wf_post_pr_gate", name: "Post-PR gate", blurb: "", gateway: "anthropic" },
];

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

let seq = 0;
interface SeedRun {
  runId?: string;
  workflowId?: string;
  workflowName?: string;
  status?: string | null;
  ticketKey?: string | null;
  ticketTitle?: string | null;
  ticketUrl?: string | null;
  model?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  durationSec?: number | null;
  costUsd?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  prNumber?: number | null;
  prUrl?: string | null;
}

async function seed(over: SeedRun = {}): Promise<void> {
  seq += 1;
  await db.insert(workflowRuns).values({
    runId: over.runId ?? `wrun_${seq}`,
    workflowId: over.workflowId ?? "wf_agent",
    workflowName: over.workflowName ?? "Agent",
    status: over.status === undefined ? "success" : over.status,
    ticketKey: over.ticketKey === undefined ? "AWT-1" : over.ticketKey,
    ticketTitle: over.ticketTitle === undefined ? "A ticket" : over.ticketTitle,
    ticketUrl: over.ticketUrl ?? null,
    model: over.model === undefined ? "claude-opus-4-8" : over.model,
    startedAt: over.startedAt === undefined ? new Date(NOW.getTime() - HOUR) : over.startedAt,
    completedAt: over.completedAt ?? null,
    durationSec: over.durationSec === undefined ? 120 : over.durationSec,
    costUsd: over.costUsd === undefined ? 1.5 : over.costUsd,
    tokensInput: over.tokensInput === undefined ? 1000 : over.tokensInput,
    tokensOutput: over.tokensOutput === undefined ? 500 : over.tokensOutput,
    prNumber: over.prNumber ?? null,
    prUrl: over.prUrl ?? null,
  });
}

describe("parseWindow", () => {
  it("accepts the whitelist", () => {
    expect(parseWindow("24h")).toBe("24h");
    expect(parseWindow("7d")).toBe("7d");
    expect(parseWindow("30d")).toBe("30d");
    expect(parseWindow("all")).toBe("all");
  });
  it("defaults unknown/non-string to 24h", () => {
    expect(parseWindow("yesterday")).toBe("24h");
    expect(parseWindow("'; DROP TABLE workflow_runs; --")).toBe("24h");
    expect(parseWindow(undefined)).toBe("24h");
    expect(parseWindow(7)).toBe("24h");
  });
});

describe("parseSearch", () => {
  it("trims and returns the query", () => {
    expect(parseSearch("  AWT-12 ")).toBe("AWT-12");
  });
  it("returns null for empty / non-string", () => {
    expect(parseSearch("   ")).toBeNull();
    expect(parseSearch("")).toBeNull();
    expect(parseSearch(undefined)).toBeNull();
    expect(parseSearch(123)).toBeNull();
  });
  it("caps length", () => {
    expect(parseSearch("x".repeat(500))?.length).toBe(100);
  });
});

describe("listRuns", () => {
  const base = { jiraBaseUrl: JIRA, modelFallback: "claude-fallback", now: NOW };

  it("maps persisted cost/tokens (no longer null) and coerces status", async () => {
    await seed({ runId: "r1", status: "success", costUsd: 2.25, tokensInput: 1200, tokensOutput: 800 });
    const { rows } = await listRuns({ db, window: "all", q: null, ...base });
    const r = rows.find((x) => x.id === "r1")!;
    expect(r.cost).toBeCloseTo(2.25);
    expect(r.tokens).toBe(2000);
    expect(r.status).toBe("success");
  });

  it("treats a null status (usage recorded before snapshot) as running", async () => {
    await seed({ runId: "r1", status: null });
    const { rows } = await listRuns({ db, window: "all", q: null, ...base });
    expect(rows[0].status).toBe("running");
  });

  it("derives a ticket URL when none is persisted", async () => {
    await seed({ runId: "r1", ticketKey: "AWT-9", ticketUrl: null });
    const { rows } = await listRuns({ db, window: "all", q: null, ...base });
    expect(rows[0].ticketUrl).toBe(`${JIRA}/browse/AWT-9`);
  });

  it("filters by the time window on startedAt", async () => {
    await seed({ runId: "recent", startedAt: new Date(NOW.getTime() - 2 * HOUR) });
    await seed({ runId: "old", startedAt: new Date(NOW.getTime() - 5 * DAY) });
    const day = await listRuns({ db, window: "24h", q: null, ...base });
    expect(day.rows.map((r) => r.id)).toEqual(["recent"]);
    const week = await listRuns({ db, window: "7d", q: null, ...base });
    expect(week.rows.map((r) => r.id).sort()).toEqual(["old", "recent"]);
  });

  it("searches ticket key and title, case-insensitively", async () => {
    await seed({ runId: "k", ticketKey: "AWT-42", ticketTitle: "Refactor cron" });
    await seed({ runId: "t", ticketKey: "AWT-99", ticketTitle: "Fix LOGIN bug" });
    await seed({ runId: "n", ticketKey: "AWT-7", ticketTitle: "Unrelated" });
    const byKey = await listRuns({ db, window: "all", q: "awt-42", ...base });
    expect(byKey.rows.map((r) => r.id)).toEqual(["k"]);
    const byTitle = await listRuns({ db, window: "all", q: "login", ...base });
    expect(byTitle.rows.map((r) => r.id)).toEqual(["t"]);
  });

  it("treats the search as a bound literal, not SQL (injection-safe)", async () => {
    await seed({ runId: "a" });
    await seed({ runId: "b" });
    const res = await listRuns({ db, window: "all", q: "' OR 1=1 --", ...base });
    expect(res.rows).toHaveLength(0);
    // table still intact
    const all = await listRuns({ db, window: "all", q: null, ...base });
    expect(all.rows).toHaveLength(2);
  });

  it("treats % and _ in the query as literals, not wildcards", async () => {
    await seed({ runId: "lit", ticketTitle: "100% done" });
    await seed({ runId: "other", ticketTitle: "1000 done" });
    const res = await listRuns({ db, window: "all", q: "100%", ...base });
    expect(res.rows.map((r) => r.id)).toEqual(["lit"]);
  });

  it("counts the full matched set and orders newest-first", async () => {
    await seed({ runId: "s1", status: "success", startedAt: new Date(NOW.getTime() - 3 * HOUR) });
    await seed({ runId: "f1", status: "failed", startedAt: new Date(NOW.getTime() - 2 * HOUR) });
    await seed({ runId: "r1", status: "running", startedAt: new Date(NOW.getTime() - 1 * HOUR) });
    const res = await listRuns({ db, window: "24h", q: null, ...base });
    expect(res.total).toBe(3);
    expect(res.counts).toMatchObject({ success: 1, failed: 1, running: 1 });
    expect(res.rows.map((r) => r.id)).toEqual(["r1", "f1", "s1"]);
  });

  it("respects the row cap while counting the full set", async () => {
    for (let i = 0; i < 5; i++) await seed({ startedAt: new Date(NOW.getTime() - (i + 1) * HOUR) });
    const res = await listRuns({ db, window: "all", q: null, limit: 2, ...base });
    expect(res.rows).toHaveLength(2);
    expect(res.total).toBe(5);
  });
});

describe("runKpis", () => {
  it("counts runs/errors/cost in the window with a delta vs the prior window", async () => {
    // current 24h
    await seed({ status: "success", startedAt: new Date(NOW.getTime() - 2 * HOUR), costUsd: 1 });
    await seed({ status: "failed", startedAt: new Date(NOW.getTime() - 3 * HOUR), costUsd: 2 });
    // prior 24h (between 24h and 48h ago)
    await seed({ status: "success", startedAt: new Date(NOW.getTime() - 30 * HOUR), costUsd: 5 });
    const k = await runKpis({ db, window: "24h", now: NOW });
    expect(k.runs24h!.value).toBe(2);
    expect(k.errors24h!.value).toBe(1);
    expect(k.cost24h!.value).toBeCloseTo(3);
    expect(k.runs24h!.deltaPct).toBeCloseTo(100); // 2 vs 1
    expect(k.runs24h!.spark).toHaveLength(24);
  });

  it("uses daily buckets for a 7d window", async () => {
    await seed({ startedAt: new Date(NOW.getTime() - 2 * DAY) });
    const k = await runKpis({ db, window: "7d", now: NOW });
    expect(k.runs24h!.spark).toHaveLength(7);
  });

  it("for 'all' counts everything with no delta", async () => {
    await seed({ startedAt: new Date(NOW.getTime() - 100 * DAY) });
    await seed({ startedAt: new Date(NOW.getTime() - 1 * HOUR) });
    const k = await runKpis({ db, window: "all", now: NOW });
    expect(k.runs24h!.value).toBe(2);
    expect(k.runs24h!.deltaPct).toBe(0);
  });
});

describe("workflowAgg", () => {
  const base = { jiraBaseUrl: JIRA, now: NOW, registry: REGISTRY };

  it("aggregates per registry workflow over the window", async () => {
    await seed({ workflowId: "wf_agent", status: "success", durationSec: 100 });
    await seed({ workflowId: "wf_agent", status: "failed", durationSec: 200 });
    await seed({ workflowId: "wf_post_pr_gate", status: "success", durationSec: 50 });
    const { rows } = await workflowAgg({ db, window: "24h", ...base });
    const agent = rows.find((r) => r.id === "wf_agent")!;
    expect(agent.runs24h).toBe(2);
    expect(agent.errRate).toBeCloseTo(0.5);
    const gate = rows.find((r) => r.id === "wf_post_pr_gate")!;
    expect(gate.runs24h).toBe(1);
  });

  it("reports the latest run regardless of window", async () => {
    await seed({ workflowId: "wf_agent", ticketKey: "AWT-OLD", startedAt: new Date(NOW.getTime() - 100 * DAY) });
    await seed({ workflowId: "wf_agent", ticketKey: "AWT-NEW", startedAt: new Date(NOW.getTime() - 50 * DAY) });
    const { rows } = await workflowAgg({ db, window: "24h", ...base });
    const agent = rows.find((r) => r.id === "wf_agent")!;
    expect(agent.runs24h).toBe(0); // none in 24h
    expect(agent.latestRun?.ticket).toBe("AWT-NEW");
  });

  it("sums per-workflow cost (costToday) from persisted cost", async () => {
    await seed({ workflowId: "wf_agent", costUsd: 1.25 });
    await seed({ workflowId: "wf_agent", costUsd: 0.75 });
    const { rows } = await workflowAgg({ db, window: "24h", ...base });
    expect(rows.find((r) => r.id === "wf_agent")!.costToday).toBeCloseTo(2);
  });
});

describe("costAgg", () => {
  it("totals, per-workflow, and daily buckets over the window", async () => {
    await seed({ workflowId: "wf_agent", workflowName: "Agent", costUsd: 2, tokensInput: 1000, tokensOutput: 500, startedAt: new Date(NOW.getTime() - 2 * HOUR) });
    await seed({ workflowId: "wf_post_pr_gate", workflowName: "Post-PR gate", costUsd: 1, tokensInput: 100, tokensOutput: 50, startedAt: new Date(NOW.getTime() - 2 * HOUR) });
    const c = await costAgg({ db, window: "24h", now: NOW });
    expect(c.totals.totalTokenCost).toBeCloseTo(3);
    expect(c.totals.totalTokens).toBe(1650);
    expect(c.totals.traceCount).toBe(2);
    expect(c.byWorkflow).toHaveLength(2);
    expect(c.byWorkflow.find((w) => w.taskId === "wf_agent")!.cost).toBeCloseTo(2);
    expect(c.daily).toHaveLength(1);
    expect(c.daily[0].cost).toBeCloseTo(3);
  });

  it("excludes rows outside the window", async () => {
    await seed({ costUsd: 9, startedAt: new Date(NOW.getTime() - 40 * DAY) });
    const c = await costAgg({ db, window: "24h", now: NOW });
    expect(c.totals.traceCount).toBe(0);
  });
});
