import { describe, expect, it, vi } from "vitest";
import {
  validateRepositoryDiscoveryResult,
} from "../repository-discovery/protocol.js";
import {
  validateRepositoryExpansionRequests,
} from "../repository-discovery/runner.js";
import type { RepositoryCatalogEntry } from "../repository-discovery/catalog.js";
import { workspaceRepositoryAccess } from "../sandbox/repo-workspace.js";
import { ensurePlanningWorkspaceForBlock } from "./agent.js";
import { makeCtx } from "./blocks/test-support.js";

const catalog: RepositoryCatalogEntry[] = [
  {
    provider: "github",
    repoPath: "acme/service",
    name: "service",
    defaultBranch: "main",
    description: "User-facing service",
    topics: ["typescript"],
    usable: true,
  },
  {
    provider: "gitlab",
    repoPath: "acme/shared/contracts",
    name: "contracts",
    defaultBranch: "main",
    description: "Shared contracts",
    topics: ["schema"],
    usable: true,
  },
  {
    provider: "gitlab",
    repoPath: "acme/service",
    name: "service mirror",
    defaultBranch: "trunk",
    description: "Distinct provider-scoped repository",
    topics: [],
    usable: true,
  },
];

describe("multi-repository research workflow scenarios", () => {
  it("turns an ambiguous ticket into validated selection and plans inside the code workspace", async () => {
    const decision = validateRepositoryDiscoveryResult(
      {
        status: "selected",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/service",
            rationale: "ticket symptom",
          },
        ],
        confidence: "high",
        questions: null,
        error: null,
      },
      catalog,
      [],
    );
    expect(decision).toMatchObject({
      kind: "selected",
      repositories: [{ provider: "github", repoPath: "acme/service" }],
    });

    const ctx = makeCtx({ sandboxId: "shared-code-workspace" });
    const prepare = vi.fn();
    await expect(
      ensurePlanningWorkspaceForBlock(ctx, undefined, prepare),
    ).resolves.toEqual({
      kind: "ready",
      sandboxId: "shared-code-workspace",
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("expands from the symptom repository to the shared owner while preserving write-only scope", () => {
    const expansion = validateRepositoryExpansionRequests({
      requests: [
        {
          provider: "gitlab",
          repoPath: "acme/shared/contracts",
          rationale: "service imports this schema",
        },
      ],
      catalog,
      attached: [{ provider: "github", repoPath: "acme/service" }],
      completedRounds: 0,
    });
    expect(expansion).toMatchObject({
      kind: "attach",
      repositories: [
        { provider: "gitlab", repoPath: "acme/shared/contracts" },
      ],
    });

    const manifest = {
      version: 2 as const,
      repositories: [
        {
          provider: "github" as const,
          repoPath: "acme/service",
          slug: "github__acme__service",
          localPath: "/vercel/sandbox/repos/github__acme__service",
          defaultBranch: "main",
          branchName: "main",
          selectedRationale: "symptom",
          access: "read" as const,
          researchBaseSha: "service-sha",
        },
        {
          provider: "gitlab" as const,
          repoPath: "acme/shared/contracts",
          slug: "gitlab__acme__shared__contracts",
          localPath: "/vercel/sandbox/repos/gitlab__acme__shared__contracts",
          defaultBranch: "main",
          branchName: "blazebot/aiw-147",
          selectedRationale: "owner",
          access: "write" as const,
          researchBaseSha: "contracts-sha",
          expectedRemoteSha: "contracts-sha",
          preAgentSha: "contracts-sha",
        },
      ],
    };
    expect(
      manifest.repositories.map((repository) =>
        workspaceRepositoryAccess(manifest, repository),
      ),
    ).toEqual(["read", "write"]);
  });

  it("turns a third expansion round into targeted clarification", () => {
    expect(
      validateRepositoryExpansionRequests({
        requests: [
          {
            provider: "gitlab",
            repoPath: "acme/shared/contracts",
            rationale: "late request",
          },
        ],
        catalog,
        attached: [{ provider: "github", repoPath: "acme/service" }],
        completedRounds: 2,
      }),
    ).toMatchObject({
      kind: "clarification_needed",
      questions: [expect.stringContaining("maximum of 2")],
    });
  });

  it("keeps a PR-trigger repository mandatory even when discovery selects another repository", () => {
    const mandatory = {
      provider: "github" as const,
      repoPath: "acme/service",
      defaultBranch: "main",
      selectedRationale: "source pull request",
    };
    const decision = validateRepositoryDiscoveryResult(
      {
        status: "selected",
        repositories: [
          {
            provider: "gitlab",
            repoPath: "acme/shared/contracts",
            rationale: "import owner",
          },
        ],
        confidence: "medium",
        questions: null,
        error: null,
      },
      catalog,
      [mandatory],
    );

    expect(decision).toMatchObject({
      kind: "selected",
      repositories: [
        { provider: "github", repoPath: "acme/service" },
        { provider: "gitlab", repoPath: "acme/shared/contracts" },
      ],
    });
  });

  it("treats identical paths on GitHub and GitLab as distinct identities", () => {
    const decision = validateRepositoryDiscoveryResult(
      {
        status: "selected",
        repositories: [
          {
            provider: "github",
            repoPath: "acme/service",
            rationale: "primary",
          },
          {
            provider: "gitlab",
            repoPath: "acme/service",
            rationale: "mirror-specific config",
          },
        ],
        confidence: "high",
        questions: null,
        error: null,
      },
      catalog,
      [],
    );

    expect(decision.kind).toBe("selected");
    if (decision.kind === "selected") {
      expect(
        decision.repositories.map(
          (repository) => `${repository.provider}:${repository.repoPath}`,
        ),
      ).toEqual(["github:acme/service", "gitlab:acme/service"]);
    }
  });
});
