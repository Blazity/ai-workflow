import { describe, expect, it } from "vitest";
import {
  buildImplementationAgentSuccessOutput,
  buildOpenPrSuccessOutput,
  buildReviewAgentSuccessOutput,
} from "./agent.js";
import { validateBlockOutputForDefinition } from "../workflow-definition/block-registry.js";

describe("specialized workflow block outputs", () => {
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
  });
});
