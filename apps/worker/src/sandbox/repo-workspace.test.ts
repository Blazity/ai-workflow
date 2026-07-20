import { describe, expect, it } from "vitest";
import {
  buildRepoSlug,
  buildWorkspaceManifest,
  parseWorkspaceManifest,
  parseVerifiedWorkspaceManifest,
} from "./repo-workspace.js";

describe("repo workspace manifest", () => {
  it("builds stable filesystem-safe slugs", () => {
    expect(buildRepoSlug("Acme/API Service")).toBe("acme__api-service");
    expect(buildRepoSlug("group/sub/repo")).toBe("group__sub__repo");
  });

  it("prefixes non-root workspace paths with provider to avoid cross-provider collisions", () => {
    const manifest = buildWorkspaceManifest({
      branchName: "blazebot/aiw-45",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/app",
          defaultBranch: "main",
          selectedRationale: "ticket mentions app",
        },
        {
          provider: "gitlab",
          repoPath: "acme/app",
          defaultBranch: "main",
          selectedRationale: "ticket mentions app",
        },
      ],
    });

    expect(manifest.repositories[0].localPath).toBe("/vercel/sandbox");
    expect(manifest.repositories[1]).toMatchObject({
      slug: "gitlab__acme__app",
      localPath: "/vercel/sandbox/repos/gitlab__acme__app",
    });
  });

  it("uses the sandbox root as the first selected repository path", () => {
    const manifest = buildWorkspaceManifest({
      branchName: "blazebot/aiw-45",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "ticket mentions api",
        },
        {
          provider: "github",
          repoPath: "acme/web",
          defaultBranch: "main",
          selectedRationale: "ticket mentions web",
        },
      ],
    });

    expect(manifest.repositories).toEqual([
      expect.objectContaining({
        provider: "github",
        repoPath: "acme/api",
        slug: "acme__api",
        localPath: "/vercel/sandbox",
        branchName: "blazebot/aiw-45",
        defaultBranch: "main",
      }),
      expect.objectContaining({
        provider: "github",
        repoPath: "acme/web",
        slug: "github__acme__web",
        localPath: "/vercel/sandbox/repos/github__acme__web",
      }),
    ]);
  });

  it("rejects duplicate provider/repository selections before provisioning", () => {
    expect(() =>
      buildWorkspaceManifest({
        branchName: "blazebot/aiw-45",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "ticket mentions api",
          },
          {
            provider: "github",
            repoPath: "acme/api",
            defaultBranch: "main",
            selectedRationale: "workflow-owned branch",
          },
        ],
      }),
    ).toThrow("Duplicate selected repository: github:acme/api");
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

  it("preserves repository-specific merge bases", () => {
    const manifest = buildWorkspaceManifest({
      branchName: "blazebot/aiw-45",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "workflow-owned branch for this ticket",
          mergeBase: "main",
        },
      ],
    });

    expect(manifest.repositories[0].mergeBase).toBe("main");
  });

  it("parses valid manifest JSON", () => {
    const parsed = parseWorkspaceManifest(JSON.stringify({
      version: 1,
      repositories: [],
    }));

    expect(parsed.version).toBe(1);
  });

  it("accepts only a field-for-field copy of the trusted provisioned manifest", () => {
    const trusted = {
      version: 1 as const,
      repositories: [{
        provider: "github" as const,
        repoPath: "acme/api",
        slug: "acme__api",
        localPath: "/vercel/sandbox",
        defaultBranch: "main",
        branchName: "blazebot/aiw-45",
        mergeBase: "main",
        selectedRationale: "ticket mentions api",
        preAgentSha: "trusted-sha",
        workflowOwnedBranch: { branchName: "blazebot/aiw-45" },
      }],
    };

    expect(parseVerifiedWorkspaceManifest(JSON.stringify(trusted), trusted)).toEqual(trusted);

    const tampered = structuredClone(trusted);
    tampered.repositories[0].branchName = "attacker/branch";
    expect(() =>
      parseVerifiedWorkspaceManifest(JSON.stringify(tampered), trusted),
    ).toThrow("does not match the trusted provisioned manifest");
  });
});
