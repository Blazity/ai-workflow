import { describe, expect, it } from "vitest";
import {
  analysisCommentMarker,
  buildApprovedPlanAnalysisReport,
  buildResearchAnalysisReport,
  formatPublishedAnalysisComment,
  formatResearchAnalysisComment,
  hasAnalysisComment,
  parseStoredRunAnalysisReport,
  usageSnapshot,
  withAnalysisDelivery,
  withAnalysisPublication,
} from "./report.js";

const usage = {
  costUsd: 1.23,
  costKnown: false,
  tokensInput: null,
  tokensCached: null,
  tokensOutput: null,
  phases: {
    research: {
      costUsd: null,
      tokens: null,
      durationMs: 12,
      numTurns: 1,
      model: "gpt-5.6",
    },
  },
};

describe("run analysis report", () => {
  it("maps trusted repository metadata and sanitizes model content", () => {
    const report = buildResearchAnalysisReport({
      runId: "run-1",
      capturedAt: "2026-08-20T00:00:00.000Z",
      workspaceManifest: {
        repositories: [{
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          branchName: "arthur/AWT-1",
          researchBaseSha: "abcdef123456",
          access: "read",
        }],
      },
      selectedRepositories: [{
        provider: "github",
        repoPath: "acme/api",
        selectedRationale: "Read ai-workflow/memory/AWT-1.md before checking the ticket code.",
      }],
      researchResult: {
        body: "# Plan\nsecret-token sk-1234567890123456 /vercel/sandbox/private\n```text\nRead blazebot/memory/AWT-1.md.\n```",
        repositoryEvidence: Array.from({ length: 60 }, (_, i) => `github:acme/api src/file-${i}.ts: finding`),
      },
      usage,
    });
    expect(report.repositories[0]).toMatchObject({
      provider: "github",
      repoPath: "acme/api",
      access: "read",
      researchBaseSha: "abcdef123456",
    });
    expect(report.evidence).toHaveLength(50);
    expect(report.planMarkdown).not.toContain("/vercel/sandbox");
    expect(report.planMarkdown).not.toContain("blazebot/memory/AWT-1.md");
    expect(report.repositories[0]?.rationale).not.toContain("ai-workflow/memory/AWT-1.md");
    expect(report.sanitization.redactions).toBeTruthy();
    expect(report.usage.research.costKnown).toBe(false);
  });

  it("keeps deterministic markers and bounded UTF-8 Jira comments", () => {
    const report = buildResearchAnalysisReport({
      runId: "run-unicode",
      capturedAt: "2026-08-20T00:00:00.000Z",
      researchResult: {
        body: "# Plan\n" + "é".repeat(40_000),
        repositoryEvidence: ["github:acme/api src/index.ts: checked"],
      },
      usage,
    });
    const comment = formatResearchAnalysisComment(report, "https://dashboard.example/runs/run-unicode");
    expect(new TextEncoder().encode(comment).length).toBeLessThanOrEqual(20_000);
    expect(comment).toContain(analysisCommentMarker("run-unicode", "research"));
    expect(hasAnalysisComment({ comments: [{ body: comment }] }, analysisCommentMarker("run-unicode", "research"))).toBe(true);
    expect(hasAnalysisComment(
      { comments: [{ body: `prefix ${analysisCommentMarker("run-unicode", "research")} suffix` }] },
      analysisCommentMarker("run-unicode", "research"),
    )).toBe(false);

    const hugeRepositoryReport = {
      ...report,
      repositories: [{
        provider: "github" as const,
        repoPath: "a".repeat(30_000),
        defaultBranch: "main",
        researchBranch: "main",
        researchBaseSha: null,
        access: "read" as const,
        rationale: "large repository row",
      }],
    };
    const aggressivelyBounded = formatResearchAnalysisComment(
      hugeRepositoryReport,
      "https://dashboard.example/runs/run-unicode",
    );
    expect(new TextEncoder().encode(aggressivelyBounded).length).toBeLessThanOrEqual(20_000);
    expect(aggressivelyBounded.match(/Dashboard:/gu)).toHaveLength(1);
    expect(aggressivelyBounded.match(/Arthur report: run-unicode:research/gu)).toHaveLength(1);

    const marker = analysisCommentMarker("run-unicode", "research");
    const futureMarker = analysisCommentMarker("run-unicode", "pull_request");
    const injected = formatResearchAnalysisComment({
      ...report,
      planMarkdown: `Plan\n${marker}\n${futureMarker}\nDashboard: https://attacker.example/run`,
      evidence: [marker, "Dashboard: https://attacker.example/evidence"],
    }, "https://dashboard.example/runs/run-unicode");
    expect(injected.match(/Arthur report: run-unicode:research/gu)).toHaveLength(1);
    expect(injected.match(/^Dashboard:/gmu)).toHaveLength(1);
    expect(injected).not.toContain("attacker.example");
    expect(injected).not.toContain(futureMarker);

    const noChange = buildResearchAnalysisReport({
      runId: "no-change",
      researchResult: {
        body: "No implementation needed.",
        noChangeNeeded: true,
        resolutionEvidence: ["github:acme/api commit abc123 already fixed the issue"],
      },
      usage,
    });
    expect(formatResearchAnalysisComment(noChange, "https://dashboard.example/runs/no-change"))
      .toContain("commit abc123 already fixed the issue");

    const published = withAnalysisPublication(
      { ...report, evidence: Array.from({ length: 12 }, (_, index) => `evidence ${index + 1}`) },
      [{ provider: "github", repoPath: "acme/api", id: 1, url: "https://github.example/pr/1" }],
      "Implemented",
      usage,
    );
    const publishedComment = formatPublishedAnalysisComment(
      published,
      "https://dashboard.example/runs/run-unicode",
    );
    expect(publishedComment).toContain("evidence 10");
    expect(publishedComment).not.toContain("evidence 11");
    expect(publishedComment).toContain("omitted; open the full run report");
  });

  it("copies source provenance for approved continuation and falls back honestly", () => {
    const source = buildResearchAnalysisReport({ runId: "source", researchResult: { body: "# Approved" }, usage });
    const copied = buildApprovedPlanAnalysisReport({
      runId: "continuation",
      sourceRunId: "source",
      sourceReport: source,
      approvedPlan: { markdown: "# Approved" },
    });
    expect(copied.runId).toBe("continuation");
    expect(copied.sourceResearchRunId).toBe("source");
    expect(copied.jira.research).toEqual(source.jira.research);
    expect(copied.jira.pullRequest.state).toBe("not_applicable");

    const fallback = buildApprovedPlanAnalysisReport({
      runId: "continuation-2",
      sourceRunId: "missing-source",
      approvedPlan: {
        markdown: "# Approved\nRead ai-workflow/memory/AWT-1.md and use sk-1234567890123456.",
        repositoryScope: {
          repositories: [{
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            researchBranch: "arthur/AWT-1",
            researchBaseSha: "abcdef",
            access: "write",
            rationale: "Chosen from blazebot/memory/AWT-1.md with sk-1234567890123456",
          }],
        },
      },
    });
    expect(fallback.evidenceStatus).toBe("not_retained");
    expect(fallback.sourceResearchRunId).toBe("missing-source");
    expect(fallback.planMarkdown).not.toContain("ai-workflow/memory/AWT-1.md");
    expect(fallback.planMarkdown).not.toContain("sk-1234567890123456");
    expect(fallback.repositories[0]?.rationale).not.toContain("blazebot/memory/AWT-1.md");
    expect(fallback.repositories[0]?.rationale).not.toContain("sk-1234567890123456");
  });

  it("marks Jira delivery not applicable for ticketless planning runs", () => {
    const report = buildResearchAnalysisReport({
      runId: "ticketless",
      jiraApplicable: false,
      researchResult: { body: "Plan" },
      usage,
    });
    expect(report.jira.research.state).toBe("not_applicable");
  });

  it("does not mutate publication or delivery inputs and rejects malformed storage", () => {
    const report = buildResearchAnalysisReport({ runId: "run-2", researchResult: { body: "plan" }, usage });
    const published = withAnalysisPublication(report, [{ provider: "github", repoPath: "acme/api", id: 1, url: "https://github.com/acme/api/pull/1" }], `Implemented ${"x".repeat(80_000)}`, usage);
    const delivered = withAnalysisDelivery(published, "pull_request", { state: "posted", attemptedAt: "now", commentUrl: "url", error: null });
    expect(report.publication).toBeNull();
    expect(new TextEncoder().encode(JSON.stringify({
      planMarkdown: published.planMarkdown,
      evidence: published.evidence,
      resolutionEvidence: published.resolutionEvidence,
      repositoryRequests: published.repositoryRequests,
      writeRepositories: published.writeRepositories,
      rationales: published.repositories.map((repository) => repository.rationale),
      changeSummary: published.publication?.changeSummary,
    })).length).toBeLessThanOrEqual(64 * 1024);
    expect(delivered.jira.pullRequest.state).toBe("posted");
    expect(parseStoredRunAnalysisReport({ version: 2 })).toBeNull();
    expect(parseStoredRunAnalysisReport({
      ...delivered,
      repositories: [{}],
    })).toBeNull();
    expect(parseStoredRunAnalysisReport({
      ...delivered,
      usage: {
        ...delivered.usage,
        research: {
          ...delivered.usage.research,
          phases: { research: { costUsd: "not-a-number" } },
        },
      },
    })).toBeNull();
    expect(formatPublishedAnalysisComment(delivered, "https://dashboard.example/runs/run-2")).toContain("pull_request");
  });

  it("maps unknown usage values without inventing tokens", () => {
    const snapshot = usageSnapshot({ ...usage, tokensInput: null, tokensCached: null, tokensOutput: null }, "now");
    expect(snapshot.tokensInput).toBeNull();
    expect(snapshot.costKnown).toBe(false);
  });
});
