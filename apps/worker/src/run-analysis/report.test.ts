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
} from "../engine/support/run-analysis-report.js";

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

  /**
   * A repository the run was asked to work on and did not.
   *
   * It goes in the section a reader already opens to find out which
   * repositories a run touched, because a left-out repository is not a new
   * subject, it is a repository in a state. Without it the person who excluded
   * the repository in March reads an ordinary success comment in May, finds a
   * pull request short one repository, and has nowhere to learn that their own
   * decision is the reason.
   */
  it("tells the ticket which repositories the run left out, and why", () => {
    const report = buildResearchAnalysisReport({
      runId: "left-out",
      workspaceManifest: {
        repositories: [{
          provider: "github",
          repoPath: "acme/web",
          defaultBranch: "main",
          branchName: "arthur/AWT-1",
          researchBaseSha: "abcdef123456",
          access: "write",
        }],
      },
      leftOutRepositories: [
        {
          repositoryKey: "github:acme/api",
          reason:
            "github:acme/api was excluded on this work by Ada Lovelace on 2026-09-10," +
            " and this run left it out rather than asking about it again.",
        },
      ],
      researchResult: { body: "Plan" },
      usage,
    });
    const published = withAnalysisPublication(
      report,
      [{ provider: "github", repoPath: "acme/web", id: 1, url: "https://github.com/acme/web/pull/1" }],
      "Implemented",
      usage,
    );

    const comment = formatPublishedAnalysisComment(published, "https://dashboard.example/runs/left-out");

    // In the Repositories section, beside the repository the run did open, not
    // in a second place a reader would have to know to look at.
    const repositories = comment.split("\n\n").find((section) => section.startsWith("Repositories"));
    expect(repositories).toContain("- github:acme/web · write");
    expect(repositories).toContain(
      "- github:acme/api · left out · github:acme/api was excluded on this work by Ada Lovelace" +
        " on 2026-09-10, and this run left it out rather than asking about it again.",
    );
  });

  /**
   * The one surface that reaches a person on a run that FINISHED.
   *
   * The pre-sandbox halt text reaches nobody when the run does not halt and the
   * prompt additions reach the agent, so on a green run this comment is the
   * only place the person who excluded the repository can learn that the
   * exclusion is theirs to take back.
   */
  it("tells the ticket what a person can do about the repositories it left out", () => {
    const report = buildResearchAnalysisReport({
      runId: "recovery",
      leftOutRepositories: [
        { repositoryKey: "github:acme/api", reason: "somebody excluded it on this work." },
      ],
      repositoryRecoveryNotes: [
        "Excluding a repository is not final: this work's repository list can be changed" +
          " through the work scope API or the work_scope.edit tool," +
          " and the next run starts from the changed list.",
      ],
      researchResult: { body: "Plan" },
      usage,
    });

    const comment = formatResearchAnalysisComment(
      report,
      "https://dashboard.example/runs/recovery",
    );
    const repositories = comment
      .split("\n\n")
      .find((section) => section.startsWith("Repositories"));

    // Under the line it is about, in the same section, and not as a bullet:
    // it is not a repository, it is what the reader can do about one.
    expect(repositories).toContain("- github:acme/api · left out · somebody excluded it");
    expect(repositories).toContain(
      "\nExcluding a repository is not final: this work's repository list can be changed" +
        " through the work scope API or the work_scope.edit tool," +
        " and the next run starts from the changed list.",
    );
  });

  // The eight-line bound was silent, and a silent bound is worse than a short
  // list: the reader takes the eighth line for the last repository and stops
  // looking. The recorder's own trail bound says how many it dropped, and this
  // section, which is the only one a person reads on a run that finished, owes
  // the reader the same.
  it("says how many left-out repositories the eight-line bound dropped", () => {
    const report = buildResearchAnalysisReport({
      runId: "left-out-bound",
      leftOutRepositories: Array.from({ length: 11 }, (_, index) => ({
        repositoryKey: `github:acme/left-${index}`,
        reason: "somebody excluded it on this work.",
      })),
      researchResult: { body: "Plan" },
      usage,
    });

    expect(report.leftOutRepositories).toHaveLength(8);
    expect(report.leftOutRepositoriesOmitted).toBe(3);

    const repositories = formatResearchAnalysisComment(
      report,
      "https://dashboard.example/runs/left-out-bound",
    )
      .split("\n\n")
      .find((section) => section.startsWith("Repositories"));

    expect(repositories).toContain("- github:acme/left-7 · left out");
    expect(repositories).not.toContain("github:acme/left-8");
    // After the lines it is about, so a reader meets it where the list stops.
    expect(repositories).toContain(
      "- github:acme/left-7 · left out · somebody excluded it on this work.\n" +
        "- and 3 more, not listed here; open the full run report",
    );
  });

  it("says nothing about a bound that dropped nothing, at exactly the bound", () => {
    // Eight is the bound, not one past it: a run that left out exactly eight
    // lost nothing, and a line saying otherwise sends a reader to look for a
    // ninth repository that does not exist.
    const report = buildResearchAnalysisReport({
      runId: "left-out-exactly-eight",
      leftOutRepositories: Array.from({ length: 8 }, (_, index) => ({
        repositoryKey: `github:acme/left-${index}`,
        reason: "somebody excluded it on this work.",
      })),
      researchResult: { body: "Plan" },
      usage,
    });

    expect("leftOutRepositoriesOmitted" in report).toBe(false);
    expect(
      formatResearchAnalysisComment(report, "https://dashboard.example/runs/left-out-exactly-eight"),
    ).not.toContain("more, not listed here");
  });

  it("does not count an entry it discarded as a repository somebody could go and look up", () => {
    // The count comes from the same filter the bound applies. A malformed entry
    // is not in the full report either, so counting it promises a reader
    // something the full report cannot show them.
    const report = buildResearchAnalysisReport({
      runId: "left-out-malformed",
      leftOutRepositories: [
        ...Array.from({ length: 8 }, (_, index) => ({
          repositoryKey: `github:acme/left-${index}`,
          reason: "somebody excluded it on this work.",
        })),
        { repositoryKey: "github:acme/broken" } as never,
      ],
      researchResult: { body: "Plan" },
      usage,
    });

    expect(report.leftOutRepositories).toHaveLength(8);
    expect("leftOutRepositoriesOmitted" in report).toBe(false);
  });

  it("says nothing about taking an exclusion back when it left nothing out", () => {
    // A recovery sentence with no left-out line above it answers a question the
    // reader was never asked.
    const report = buildResearchAnalysisReport({
      runId: "recovery-orphan",
      repositoryRecoveryNotes: ["Excluding a repository is not final."],
      researchResult: { body: "Plan" },
      usage,
    });

    expect("repositoryRecoveryNotes" in report).toBe(false);
    expect(
      formatResearchAnalysisComment(report, "https://dashboard.example/runs/recovery-orphan"),
    ).not.toContain("not final");
  });

  it("does not call a repository it left out analyzed", () => {
    // The heading said "Repositories analyzed" over lines that say a repository
    // was left out, which is the heading asserting the opposite of what is
    // under it. A person reading that a repository was analyzed, on a line
    // saying it was not, learns only that one of the two is lying.
    const report = buildResearchAnalysisReport({
      runId: "left-out-heading",
      leftOutRepositories: [
        { repositoryKey: "github:acme/api", reason: "somebody excluded it on this work." },
      ],
      researchResult: { body: "Plan" },
      usage,
    });

    const comment = formatResearchAnalysisComment(
      report,
      "https://dashboard.example/runs/left-out-heading",
    );
    const repositories = comment
      .split("\n\n")
      .find((section) => section.startsWith("Repositories"));

    expect(repositories).toContain("- github:acme/api · left out · somebody excluded it");
    expect(comment).not.toContain("Repositories analyzed");
  });

  it("says what it dropped when the comment is too long to post in full", () => {
    // The last-resort truncation keeps the first section and the usage tail and
    // discards everything between them, the repositories this run left out with
    // it. A truncation nobody is told about reads as "there was nothing to say",
    // which is the exact silence this section exists to break.
    const repositories = Array.from({ length: 16 }, (_, index) => ({
      provider: "github" as const,
      repoPath: `acme/${"repository-".repeat(30)}${index}`,
      defaultBranch: "main",
      branchName: `arthur/AWT-${index}`,
      researchBaseSha: "abcdef123456",
      access: "write" as const,
      selectedRationale: `${"why this repository matters ".repeat(60)}${index}`,
    }));
    const report = buildResearchAnalysisReport({
      runId: "too-long",
      workspaceManifest: { repositories },
      selectedRepositories: repositories.map((repository) => ({
        provider: repository.provider,
        repoPath: repository.repoPath,
        defaultBranch: repository.defaultBranch,
        selectedRationale: repository.selectedRationale,
      })),
      leftOutRepositories: Array.from({ length: 8 }, (_, index) => ({
        repositoryKey: `github:acme/left-${index}`,
        reason: `${"somebody excluded it on this work ".repeat(15)}${index}`,
      })),
      repositoryRequests: Array.from({ length: 8 }, (_, index) => ({
        provider: "github" as const,
        repoPath: `acme/${"requested-".repeat(50)}${index}`,
        rationale: "research asked for it",
      })),
      researchResult: {
        body: "a".repeat(40_000),
        repositoryEvidence: Array.from({ length: 40 }, (_, index) => "e".repeat(600) + index),
      },
      usage,
    });

    const comment = formatResearchAnalysisComment(
      report,
      "https://dashboard.example/runs/too-long",
    );

    // It says so, and it says which parts went, so a reader knows there was
    // more and where to find it rather than reading the silence as an answer.
    expect(comment).toContain("This comment was too long to post in full");
    expect(comment).toContain("these sections were left out: Repositories");
    expect(comment).toContain("Dashboard: https://dashboard.example/runs/too-long");
  });

  it("says nothing about left-out repositories on a run that left none out", () => {
    // Absent rather than empty: a report that says "left out: none" on every
    // run trains a reader to skip the line that matters.
    const report = buildResearchAnalysisReport({
      runId: "nothing-left-out",
      researchResult: { body: "Plan" },
      usage,
    });

    expect("leftOutRepositories" in report).toBe(false);
    expect(formatResearchAnalysisComment(report, "https://dashboard.example/runs/nothing-left-out"))
      .not.toContain("left out");
  });

  it("keeps the trusted research branch separate from a later promoted branch", () => {
    const prePromotionManifest = {
      repositories: [{
        provider: "github" as const,
        repoPath: "acme/api",
        defaultBranch: "main",
        branchName: "main",
        researchBaseSha: "abcdef123456",
        access: "write" as const,
      }],
    };
    const promotedManifest = {
      repositories: [{
        ...prePromotionManifest.repositories[0],
        branchName: "arthur/AWT-1",
      }],
    };
    const prePromotion = buildResearchAnalysisReport({
      runId: "pre-promotion",
      workspaceManifest: prePromotionManifest,
      researchResult: { body: "Plan" },
      usage,
    });
    const afterPromotion = buildResearchAnalysisReport({
      runId: "after-promotion",
      workspaceManifest: promotedManifest,
      researchResult: { body: "Plan" },
      usage,
    });

    expect(prePromotion.repositories[0]?.researchBranch).toBe("main");
    expect(afterPromotion.repositories[0]?.researchBranch).toBe("arthur/AWT-1");
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

    const ledgerNoChange = buildResearchAnalysisReport({
      runId: "ledger-no-change",
      researchResult: {
        body: "Every review thread was answered without code changes.",
        noChangeNeeded: false,
      },
      noChangeNeededOverride: true,
      usage,
    });
    expect(ledgerNoChange).toMatchObject({
      stage: "no_change",
      noChangeNeeded: true,
    });

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
    // Checked like every other array beside it, because these are rendered as
    // lines in a comment on somebody's ticket. Absent stays valid: a report
    // stored before the field existed still parses.
    expect(parseStoredRunAnalysisReport({
      ...delivered,
      leftOutRepositories: [{ repositoryKey: "github:acme/api" }],
    })).toBeNull();
    expect(
      parseStoredRunAnalysisReport({
        ...delivered,
        leftOutRepositories: [{ repositoryKey: "github:acme/api", reason: "excluded" }],
      })?.leftOutRepositories,
    ).toEqual([{ repositoryKey: "github:acme/api", reason: "excluded" }]);
    expect(parseStoredRunAnalysisReport({
      ...delivered,
      repositoryRecoveryNotes: [{ note: "not a string" }],
    })).toBeNull();
    expect(
      parseStoredRunAnalysisReport({
        ...delivered,
        repositoryRecoveryNotes: ["Excluding a repository is not final."],
      })?.repositoryRecoveryNotes,
    ).toEqual(["Excluding a repository is not final."]);
    // The count is rendered as "and N more" on somebody's ticket, so a stored
    // value that is not a whole number of repositories is a lie with a number
    // in it. Zero is refused too: the field is written only when something was
    // dropped, so a stored zero means the writer was not the builder.
    expect(parseStoredRunAnalysisReport({
      ...delivered,
      leftOutRepositoriesOmitted: 1.5,
    })).toBeNull();
    expect(parseStoredRunAnalysisReport({
      ...delivered,
      leftOutRepositoriesOmitted: 0,
    })).toBeNull();
    expect(
      parseStoredRunAnalysisReport({ ...delivered, leftOutRepositoriesOmitted: 3 })
        ?.leftOutRepositoriesOmitted,
    ).toBe(3);
    expect(parseStoredRunAnalysisReport({ ...delivered })).not.toBeNull();
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

  it("bounds an already-large authored bundle after JSON escaping the summary", () => {
    const repositories = Array.from({ length: 8 }, (_, index) => ({
      provider: "github" as const,
      repoPath: `acme/repository-${index}`,
      defaultBranch: "main",
      branchName: "main",
      researchBaseSha: "abcdef1234567890",
      access: "write" as const,
      selectedRationale: `Repository rationale ${"r".repeat(650)}`,
    }));
    const requests = repositories.map((repository) => ({
      provider: repository.provider,
      repoPath: repository.repoPath,
      rationale: `Request rationale ${"q".repeat(350)}`,
    }));
    const large = buildResearchAnalysisReport({
      runId: "large-publication",
      workspaceManifest: { repositories },
      researchResult: {
        body: `# Plan\n${"P".repeat(14_000)}`,
        repositoryEvidence: Array.from(
          { length: 50 },
          (_, index) => `Evidence ${index} ${"E".repeat(500)}`,
        ),
        resolutionEvidence: Array.from(
          { length: 10 },
          (_, index) => `Resolution ${index} ${"R".repeat(450)}`,
        ),
      },
      repositoryRequests: requests,
      writeRepositories: requests,
      usage,
    });
    const authoredBundle = (report: typeof large, changeSummary: string) => ({
      planMarkdown: report.planMarkdown,
      evidence: report.evidence,
      resolutionEvidence: report.resolutionEvidence,
      repositoryRequests: report.repositoryRequests,
      writeRepositories: report.writeRepositories,
      rationales: report.repositories.map((repository) => repository.rationale),
      changeSummary,
    });
    const existingBytes = new TextEncoder().encode(
      JSON.stringify(authoredBundle(large, "")),
    ).length;
    expect(existingBytes).toBeGreaterThan(48 * 1024);

    const escapeHeavySummary = ['"', "\\", "\n"].join("").repeat(30_000);
    const published = withAnalysisPublication(large, [], escapeHeavySummary, usage);
    const combinedBytes = new TextEncoder().encode(
      JSON.stringify(
        authoredBundle(published, published.publication?.changeSummary ?? ""),
      ),
    ).length;

    expect(combinedBytes).toBeLessThanOrEqual(64 * 1024);
    expect(published.publication?.changeSummary).toContain(
      "omitted; open the full run report",
    );
    expect(published.sanitization.truncated).toBe(true);
  });

  it("maps unknown usage values without inventing tokens", () => {
    const snapshot = usageSnapshot({ ...usage, tokensInput: null, tokensCached: null, tokensOutput: null }, "now");
    expect(snapshot.tokensInput).toBeNull();
    expect(snapshot.costKnown).toBe(false);
  });
});
