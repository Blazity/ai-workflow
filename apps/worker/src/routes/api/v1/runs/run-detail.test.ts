import { createApp, createError, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAnalysisReport, RunDetail, RunStep } from "@shared/contracts";

const state = vi.hoisted(() => ({
  actor: true,
  dbDetail: null as { run: RunDetail; steps: RunStep[]; hasRealSteps: boolean; analysisReport: RunAnalysisReport | null } | null,
  worldResult: null as { run: RunDetail; steps: RunStep[] } | null,
  resolveError: null as Error | null,
  storedReport: null as RunAnalysisReport | null,
}));

vi.mock("../../../../../env.js", () => ({ env: { JIRA_BASE_URL: "https://jira.example", DASHBOARD_ORIGIN: "https://dash.example" } }));
vi.mock("../../../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../../../../lib/auth/request-context.js", () => ({
  requireDashboardActor: vi.fn(async () => {
    if (!state.actor) throw createError({ statusCode: 401, statusMessage: "Unauthorized" });
    return { organizationId: "org", role: "member" };
  }),
  toHttpError: (error: unknown) => { throw error; },
}));
vi.mock("../../../../db/queries/run-detail-read.js", () => ({
  fetchRunDetailFromDb: vi.fn(async () => state.dbDetail),
  fetchRunRefs: vi.fn(async () => null),
}));
vi.mock("../../../../lib/overview/resolve-run-detail.js", () => ({
  resolveRunDetail: vi.fn(async () => {
    if (state.resolveError) throw state.resolveError;
    return state.worldResult;
  }),
}));
vi.mock("../../../../lib/overview/collect-run-detail.js", () => ({ collectRunDetail: vi.fn() }));
vi.mock("../../../../clarifications/store.js", () => ({ getClarificationForRun: vi.fn(async () => null), serializeClarification: vi.fn() }));
vi.mock("../../../../run-analysis/store.js", () => ({ getRunAnalysisReport: vi.fn(async () => state.storedReport) }));

const route = (await import("./[runId].get.js")).default;

function handler() {
  const app = createApp();
  const router = createRouter();
  router.get("/runs/:runId", route);
  app.use(router);
  return toWebHandler(app);
}

const run = (status: RunDetail["status"] = "running"): RunDetail => ({
  id: "run-1", workflow: "wf_agent", workflowName: "Agent", status,
  ticket: "AWT-1", ticketTitle: "Ticket", ticketUrl: "https://jira.example/browse/AWT-1",
  prNumber: null, prUrl: null, prs: null, model: null,
  createdAt: "2026-08-20T00:00:00.000Z", startedAt: "2026-08-20T00:00:00.000Z", completedAt: null,
  durationSec: null, error: null, deploymentId: null,
});

const report = { version: 1, runId: "run-1", sourceResearchRunId: "run-1", researchRevision: 1, stage: "research_complete", researchCompletedAt: "2026-08-20T00:00:00.000Z", repositories: [], expansionRounds: 0, repositoryRequests: [], writeRepositories: [], evidenceStatus: "captured", evidence: [], planMarkdown: "plan", noChangeNeeded: false, resolutionEvidence: [], publication: null, usage: { research: { capturedAt: "now", costUsd: 0, costKnown: true, tokensInput: 0, tokensCached: 0, tokensOutput: 0, phases: {} }, publication: null, final: null }, jira: { research: { state: "pending", attemptedAt: null, commentUrl: null, error: null }, pullRequest: { state: "not_applicable", attemptedAt: null, commentUrl: null, error: null } }, sanitization: { redactions: {}, truncated: false, originalBytes: 1, storedBytes: 1, unavailable: false, unavailableReason: null } } as unknown as RunAnalysisReport;

beforeEach(() => {
  state.actor = true;
  state.dbDetail = { run: run("running"), steps: [], hasRealSteps: false, analysisReport: report };
  state.worldResult = { run: run("running"), steps: [] };
  state.resolveError = null;
  state.storedReport = report;
});

describe("run detail analysis report API", () => {
  it("returns the DB report alongside live world steps and keeps the response private", async () => {
    const response = await handler()(new Request("http://worker.test/runs/run-1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).analysisReport.runId).toBe("run-1");
  });

  it("uses the DB-only fallback when the world fails", async () => {
    state.resolveError = new Error("world unavailable");
    const response = await handler()(new Request("http://worker.test/runs/run-1"));
    expect(response.status).toBe(200);
    expect((await response.json()).analysisReport).toEqual(report);
  });

  it("returns a null report for an unknown run", async () => {
    state.dbDetail = null;
    state.worldResult = null;
    state.storedReport = null;
    const response = await handler()(new Request("http://worker.test/runs/missing"));
    expect(response.status).toBe(200);
    expect((await response.json()).analysisReport).toBeNull();
  });

  it("rejects unauthenticated requests before reading the report", async () => {
    state.actor = false;
    const response = await handler()(new Request("http://worker.test/runs/run-1"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
