import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunAnalysisReport } from "@shared/contracts";
import { RunAnalysisReportCard } from "./run-analysis-report";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const base: RunAnalysisReport = {
  version: 1,
  runId: "run-report",
  sourceResearchRunId: "run-report",
  researchRevision: 1,
  stage: "published",
  researchCompletedAt: "2026-08-20T00:00:00.000Z",
  repositories: [{ provider: "github", repoPath: "acme/api", defaultBranch: "main", researchBranch: "arthur/AWT-1", researchBaseSha: "abcdef123456", access: "write", rationale: "ticket" }],
  expansionRounds: 1,
  repositoryRequests: [],
  writeRepositories: [{ provider: "github", repoPath: "acme/api", rationale: "ticket" }],
  evidenceStatus: "captured",
  evidence: ["github:acme/api src/index.ts: checked"],
  planMarkdown: "# Plan\n\nImplement the change.",
  noChangeNeeded: false,
  resolutionEvidence: [],
  publication: { prs: [{ provider: "github", repoPath: "acme/api", id: 1, url: "https://github.com/acme/api/pull/1" }], changeSummary: "Implemented the change." },
  usage: {
    research: {
      capturedAt: "2026-08-20T00:00:00.000Z",
      costUsd: 1.2,
      costKnown: false,
      tokensInput: null,
      tokensCached: null,
      tokensOutput: null,
      phases: {
        research: {
          costUsd: 1.2,
          tokens: { input: 100, cachedInput: 25, output: 50 },
          durationMs: 1200,
          numTurns: 2,
          model: "gpt-5.6",
        },
      },
    },
    publication: null,
    final: null,
  },
  jira: {
    research: { state: "posted", attemptedAt: "2026-08-20T00:00:00.000Z", commentUrl: "https://jira.example/comment/1", error: null },
    pullRequest: { state: "failed", attemptedAt: "2026-08-20T00:00:00.000Z", commentUrl: null, error: "Jira unavailable" },
  },
  sanitization: { redactions: { token: 1 }, truncated: false, originalBytes: 1, storedBytes: 1, unavailable: false, unavailableReason: null },
};

test("renders the complete report with accessible disclosures and delivery state", () => {
  const html = renderToStaticMarkup(<RunAnalysisReportCard report={base} runStatus="success" currentRunId="run-report" />);
  assert.match(html, /Analysis report/);
  assert.match(html, /PR\/MR published/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Some report content was redacted/);
  assert.match(html, /Automatic retries exhausted/);
  assert.match(html, /\$1\.20\+/);
  assert.match(html, /gpt-5\.6/);
  assert.match(html, /100 in \/ 25 cached \/ 50 out/);
  assert.match(html, /1200ms \/ 2 turns/);
  assert.match(html, /https:\/\/jira\.example\/comment\/1/);
  assert.match(html, /base: main/);
  assert.doesNotMatch(html, /overflow-x-hidden/); // code blocks retain a bounded local scroller
});

test("distinguishes missing evidence and hides runs without a report", () => {
  const notRetained = renderToStaticMarkup(<RunAnalysisReportCard report={{ ...base, stage: "research_complete", evidenceStatus: "not_retained", evidence: [], publication: null }} runStatus="success" currentRunId="run-report" />);
  assert.match(notRetained, /Source evidence was not retained/);
  const missing = renderToStaticMarkup(<RunAnalysisReportCard report={null} runStatus="failed" currentRunId="legacy" />);
  assert.equal(missing, "");
  const active = renderToStaticMarkup(<RunAnalysisReportCard report={null} runStatus="running" currentRunId="live" />);
  assert.equal(active, "");
});
