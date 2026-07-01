import { describe, expect, it } from "vitest";
import {
  buildRepoSlug,
  buildWorkspaceManifest,
  parseWorkspaceManifest,
} from "./repo-workspace.js";

describe("repo workspace manifest", () => {
  it("builds stable filesystem-safe slugs", () => {
    expect(buildRepoSlug("Acme/API Service")).toBe("acme__api-service");
    expect(buildRepoSlug("group/sub/repo")).toBe("group__sub__repo");
  });

  it("builds manifest entries from selected repositories", () => {
    const manifest = buildWorkspaceManifest({
      branchName: "blazebot/aiw-45",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "ticket mentions api",
        },
      ],
    });

    expect(manifest.repositories).toEqual([
      expect.objectContaining({
        provider: "github",
        repoPath: "acme/api",
        slug: "acme__api",
        localPath: "/vercel/sandbox/repos/acme__api",
        branchName: "blazebot/aiw-45",
        defaultBranch: "main",
      }),
    ]);
  });

  it("preserves workflow-owned branch metadata", () => {
    const manifest = buildWorkspaceManifest({
      branchName: "blazebot/aiw-45",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          defaultBranch: "main",
          selectedRationale: "workflow-owned branch for this ticket",
          workflowOwnedBranch: {
            branchName: "blazebot/aiw-45",
            pr: {
              id: 42,
              url: "https://github.com/acme/web/pull/42",
              branch: "blazebot/aiw-45",
            },
          },
        },
      ],
    });

    expect(manifest.repositories[0].workflowOwnedBranch).toEqual({
      branchName: "blazebot/aiw-45",
      pr: {
        id: 42,
        url: "https://github.com/acme/web/pull/42",
        branch: "blazebot/aiw-45",
      },
    });
  });

  it("uses an existing workflow-owned branch as the repository branch", () => {
    const manifest = buildWorkspaceManifest({
      branchName: "blazebot/aiw-45",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/web",
          defaultBranch: "main",
          selectedRationale: "workflow-owned branch for this ticket",
          workflowOwnedBranch: {
            branchName: "custom/aiw-45",
          },
        },
      ],
    });

    expect(manifest.repositories[0].branchName).toBe("custom/aiw-45");
  });

  it("parses valid manifest JSON", () => {
    const parsed = parseWorkspaceManifest(JSON.stringify({
      version: 1,
      repositories: [],
    }));

    expect(parsed.version).toBe(1);
  });
});
