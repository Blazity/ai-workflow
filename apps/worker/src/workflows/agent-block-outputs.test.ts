import { describe, expect, it } from "vitest";
import {
  buildImplementationAgentSuccessOutput,
  buildOpenPrSuccessOutput,
  buildReviewAgentSuccessOutput,
  reviewAgentExecutionResult,
  resolveImplementationPlanInput,
} from "./agent.js";
import { validateBlockOutputForDefinition } from "../workflow-definition/block-registry.js";

describe("specialized workflow block outputs", () => {
  it("uses an explicit implementation plan even when ambient legacy state differs", () => {
    expect(
      resolveImplementationPlanInput(
        { plan: "Plan from an alternate explicit producer" },
        "Legacy planning-agent plan",
      ),
    ).toBe("Plan from an alternate explicit producer");
  });

  it("confines the ambient plan fallback to definitions with no plan binding", () => {
    expect(resolveImplementationPlanInput({}, "Legacy planning-agent plan")).toBe(
      "Legacy planning-agent plan",
    );
    expect(() => resolveImplementationPlanInput({ plan: 42 }, "legacy")).toThrow(
      /implementation input "plan" must be a string/i,
    );
  });

  it("reports the implementation workspace, changed branches, commits, and summary", () => {
    const output = buildImplementationAgentSuccessOutput({
      workspaceId: "sbx-1",
      workspaceManifest: {
        version: 1,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/web",
            slug: "acme__web",
            localPath: "/vercel/sandbox",
            defaultBranch: "main",
            branchName: "aiw/AIW-103",
            selectedRationale: "ticket mentions web",
          },
          {
            provider: "gitlab",
            repoPath: "acme/api",
            slug: "gitlab__acme__api",
            localPath: "/vercel/sandbox/repos/gitlab__acme__api",
            defaultBranch: "main",
            branchName: "aiw/AIW-103",
            selectedRationale: "ticket mentions api",
          },
        ],
      },
      commits: [
        { provider: "gitlab", repoPath: "acme/api", sha: "abc123" },
      ],
      summary: "Implemented the API change.",
    });

    expect(output).toEqual({
      status: "implemented",
      workspaceId: "sbx-1",
      branches: [
        {
          provider: "gitlab",
          repoPath: "acme/api",
          branch: "aiw/AIW-103",
        },
      ],
      commits: [{ provider: "gitlab", repoPath: "acme/api", sha: "abc123" }],
      summary: "Implemented the API change.",
    });
    expect(
      validateBlockOutputForDefinition("implementation_agent", {}, output, {
        requireNormalOutput: true,
      }),
    ).toEqual([]);
  });

  it("reports structured review findings and derives the publication decision", () => {
    const output = buildReviewAgentSuccessOutput({
      feedback: "One blocking issue.",
      issues: [
        { file: "src/index.ts", description: "Handle null input.", severity: "critical" },
      ],
    });

    expect(output).toEqual({
      status: "reviewed",
      findings: [
        { file: "src/index.ts", description: "Handle null input.", severity: "critical" },
      ],
      decision: "request_changes",
      feedback: "One blocking issue.",
    });
    expect(
      validateBlockOutputForDefinition("review_agent", {}, output, {
        requireNormalOutput: true,
      }),
    ).toEqual([]);
  });

  it("routes rejected v2 reviews as normal data while preserving the v1 compatibility failure", () => {
    const rejectedReview = {
      result: "failed" as const,
      feedback: "One blocking issue.",
      issues: [
        { file: "src/index.ts", description: "Handle null input.", severity: "critical" as const },
      ],
    };

    expect(reviewAgentExecutionResult(2, rejectedReview)).toEqual({
      kind: "next",
      output: {
        status: "reviewed",
        findings: rejectedReview.issues,
        decision: "request_changes",
        feedback: "One blocking issue.",
      },
    });
    expect(reviewAgentExecutionResult(1, rejectedReview)).toMatchObject({
      kind: "execution_error",
      error: {
        category: "unknown",
        detail: "unknown",
        phase: "review",
      },
    });
  });

  it("reports every created PR while preserving the primary legacy fields", () => {
    const output = buildOpenPrSuccessOutput([
      {
        provider: "github",
        repoPath: "acme/web",
        id: 12,
        url: "https://github.com/acme/web/pull/12",
        branch: "aiw/AIW-103",
        isNew: true,
      },
      {
        provider: "gitlab",
        repoPath: "acme/api",
        id: 13,
        url: "https://gitlab.com/acme/api/-/merge_requests/13",
        branch: "aiw/AIW-103",
        isNew: true,
      },
    ]);

    expect(output).toMatchObject({
      status: "ok",
      prUrl: "https://github.com/acme/web/pull/12",
      prNumber: 12,
      prs: [
        expect.objectContaining({ provider: "github", repoPath: "acme/web", id: 12 }),
        expect.objectContaining({ provider: "gitlab", repoPath: "acme/api", id: 13 }),
      ],
    });
    expect(
      validateBlockOutputForDefinition("open_pr", {}, output, {
        requireNormalOutput: true,
      }),
    ).toEqual([]);
    expect(
      validateBlockOutputForDefinition(
        "open_pr",
        {},
        { status: "ok", prs: output.prs },
        { requireNormalOutput: true },
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("prUrl"),
        expect.stringContaining("prNumber"),
      ]),
    );
  });
});
