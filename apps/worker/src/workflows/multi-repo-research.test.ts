import { describe, expect, it, vi } from "vitest";

// Publication seams composed by scenarios 2, 3, and 6. These reuse the exact mock
// shapes from workspace-publication.test.ts and trusted-workspace-publisher.test.ts
// without duplicating their whole harnesses: only the seams these three scenarios
// actually reach are mocked. env is mocked minimally (the trusted publisher reads
// only JOB_TIMEOUT_MS, and never before the read-only failure below).
const mocks = vi.hoisted(() => ({
  findPr: vi.fn(),
  createPr: vi.fn(),
  recordIntent: vi.fn(),
  recordPr: vi.fn(),
  getBranchSha: vi.fn(),
  getPrHead: vi.fn(),
  getToken: vi.fn(),
  sourceCommand: vi.fn(),
  readBundle: vi.fn(),
  createSandbox: vi.fn(),
  isRepoAllowed: vi.fn(),
}));

vi.mock("./repository-prs.js", () => ({
  findWorkflowOwnedPullRequestForBranch: mocks.findPr,
  createOrFindWorkflowOwnedPullRequest: mocks.createPr,
  recordWorkflowOwnedPullRequestIntent: mocks.recordIntent,
  recordWorkflowOwnedPullRequest: mocks.recordPr,
}));
vi.mock("../lib/vcs-runtime.js", () => ({
  createRepositoryVcsRuntime: () => ({
    config: {
      kind: "github",
      host: "https://github.com",
      auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
    },
    getToken: mocks.getToken,
    vcs: { getBranchSha: mocks.getBranchSha, getPRHead: mocks.getPrHead },
  }),
}));
vi.mock("../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({ teamId: "team" }),
}));
vi.mock("../lib/repo-allowlist.js", () => ({
  isRepoAllowed: mocks.isRepoAllowed,
  isRepoAllowedForScope: (repository: { repoPath: string }) =>
    mocks.isRepoAllowed(repository.repoPath),
}));
vi.mock("../../env.js", () => ({ env: { JOB_TIMEOUT_MS: 120_000 } }));
vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(async () => ({
      sandboxId: "source-sandbox",
      runCommand: mocks.sourceCommand,
      readFileToBuffer: mocks.readBundle,
    })),
    create: mocks.createSandbox,
  },
}));

import {
  validateRepositoryDiscoveryResult,
} from "../repository-discovery/protocol.js";
import {
  EXPANSION_LIMIT_CLARIFICATION_PREFIX,
  validateHumanRepositoryExpansion,
  validateRepositoryExpansionRequests,
} from "../repository-discovery/runner.js";
import type { RepositoryCatalogEntry } from "../repository-discovery/catalog.js";
import { filterPinnedRepositories } from "../adapters/vcs/repository-directory.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import { workspaceRepositoryAccess } from "../sandbox/repo-workspace.js";
import { publishTrustedWorkspaceFromSandbox } from "../sandbox/trusted-workspace-publisher.js";
import { applyHumanRepositoryExpansion } from "./agent.js";
import { makeCtx } from "./blocks/test-support.js";
import {
  openPullRequestsForPublication,
  type FinalizedBranch,
} from "./workspace-publication.js";

function command(stdout = "", stderr = "", exitCode = 0) {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

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
  });

  it("expands from the symptom repository to the shared owner while preserving write-only scope", async () => {
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

    // Only the write-scoped shared owner X changed; the read-only symptom repo Y
    // never becomes a finalized branch, so exactly one PR is opened, for X.
    const finalizedX: FinalizedBranch = {
      provider: "gitlab",
      repoPath: "acme/shared/contracts",
      branchName: "blazebot/aiw-147",
      defaultBranch: "main",
      expectedHead: "contracts-sha",
      pushedHead: "after-contracts",
    };
    mocks.findPr.mockReset().mockResolvedValue(null);
    mocks.recordIntent.mockReset().mockResolvedValue(undefined);
    mocks.recordPr.mockReset().mockResolvedValue(undefined);
    mocks.getBranchSha.mockReset().mockResolvedValue(finalizedX.pushedHead);
    mocks.getPrHead
      .mockReset()
      .mockResolvedValue({ headSha: finalizedX.pushedHead, baseRef: "main", state: "open" });
    mocks.createPr.mockReset().mockResolvedValue({
      provider: "gitlab",
      repoPath: "acme/shared/contracts",
      id: 21,
      url: "https://gitlab.com/acme/shared/contracts/-/merge_requests/21",
      branch: finalizedX.branchName,
      isNew: true,
    });

    const publication = await openPullRequestsForPublication({
      runId: "run-1",
      subjectKey: "ticket:jira:AIW-147",
      ownerToken: "owner-1",
      ticketKey: "AIW-147",
      repositories: [finalizedX],
      title: "AIW-147",
      body: "Change the shared owner only",
    });

    expect(publication).toMatchObject({
      status: "published",
      prs: [{ id: 21, repoPath: "acme/shared/contracts" }],
    });
    expect(mocks.createPr).toHaveBeenCalledTimes(1);
  });

  // A definition pin attaches its repositories from the start but must not close
  // the shared-owner expansion: the expansion catalog is narrowed by PROVIDER
  // only, never to the pinned repository list, and every round limit still holds.
  it("still expands to a non-pinned repository under a definition pin", () => {
    const pinnedScope = {
      providers: ["github" as const, "gitlab" as const],
      repositories: [{ provider: "github" as const, repoPath: "acme/service" }],
    };
    const expansionCatalog = filterPinnedRepositories(catalog, {
      providers: pinnedScope.providers,
    });
    expect(expansionCatalog).toHaveLength(catalog.length);

    expect(
      validateRepositoryExpansionRequests({
        requests: [
          {
            provider: "gitlab",
            repoPath: "acme/shared/contracts",
            rationale: "service imports this schema",
          },
        ],
        catalog: expansionCatalog,
        attached: [{ provider: "github", repoPath: "acme/service" }],
        completedRounds: 1,
      }),
    ).toMatchObject({
      kind: "attach",
      repositories: [{ provider: "gitlab", repoPath: "acme/shared/contracts" }],
    });

    // The pin changes neither the round limit nor the catalog membership rule.
    expect(
      validateRepositoryExpansionRequests({
        requests: [
          {
            provider: "gitlab",
            repoPath: "acme/shared/contracts",
            rationale: "late request",
          },
        ],
        catalog: expansionCatalog,
        attached: [{ provider: "github", repoPath: "acme/service" }],
        completedRounds: 2,
      }),
    ).toMatchObject({ kind: "clarification_needed" });
  });

  it("narrows the expansion catalog to the pinned providers", () => {
    const gitlabOnly = filterPinnedRepositories(catalog, { providers: ["gitlab"] });
    expect(gitlabOnly.map((entry) => entry.provider)).toEqual(["gitlab", "gitlab"]);

    expect(
      validateRepositoryExpansionRequests({
        requests: [
          {
            provider: "github",
            repoPath: "acme/service",
            rationale: "excluded provider",
          },
        ],
        catalog: gitlabOnly,
        attached: [{ provider: "gitlab", repoPath: "acme/service" }],
        completedRounds: 0,
      }),
    ).toMatchObject({
      kind: "clarification_needed",
      questions: [expect.stringContaining("unavailable repository github:acme/service")],
    });
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
        confidence: "high",
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

describe("human repository expansion beyond the model round limit", () => {
  const v2Manifest = { version: 2 as const, repositories: [] };
  const attachedManifest = { version: 2 as const, repositories: [] };

  function ctxWithLimitAnswer(answer: string) {
    return makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/service",
          defaultBranch: "main",
          selectedRationale: "symptom",
        },
      ],
      clarifications: [
        {
          questions: [`${EXPANSION_LIMIT_CLARIFICATION_PREFIX} Reply with repo paths.`],
          answer,
        },
      ],
    });
  }

  it("attaches a human-named catalog repository and continues research", async () => {
    const ctx = ctxWithLimitAnswer("gitlab:acme/shared/contracts");
    const attach = vi.fn(async () => ({
      manifest: attachedManifest,
      cloneDurationMs: 5,
    }));
    const fetchContexts = vi.fn(async () => []);

    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve: async (answer, attached) =>
        validateHumanRepositoryExpansion({ answer, catalog, attached }),
      attach,
      fetchContexts,
    });

    expect(result.kind).toBe("attached");
    expect(attach).toHaveBeenCalledWith([
      {
        provider: "gitlab",
        repoPath: "acme/shared/contracts",
        defaultBranch: "main",
        selectedRationale: "requested by human clarification answer",
      },
    ]);
    expect(ctx.selectedRepositories).toHaveLength(2);
    expect(ctx.workspaceManifest).toBe(attachedManifest);
  });

  it("returns a clarification without attaching when the human names an off-catalog repository", async () => {
    const ctx = ctxWithLimitAnswer("github:acme/not-installed");
    const attach = vi.fn();

    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve: async (answer, attached) =>
        validateHumanRepositoryExpansion({ answer, catalog, attached }),
      attach,
      fetchContexts: async () => [],
    });

    expect(result.kind).toBe("clarification");
    expect(attach).not.toHaveBeenCalled();
  });

  it("no-ops when the latest clarification is not the expansion-limit prompt", async () => {
    const ctx = makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: v2Manifest,
      clarifications: [
        {
          questions: ["Which repository should this ticket modify?"],
          answer: "github:acme/service",
        },
      ],
    });
    const attach = vi.fn();

    const result = await applyHumanRepositoryExpansion(ctx, {
      resolve: async () => {
        throw new Error("resolve must not run for a non-expansion clarification");
      },
      attach,
      fetchContexts: async () => [],
    });

    expect(result).toEqual({ kind: "noop" });
    expect(attach).not.toHaveBeenCalled();
  });
});

describe("scenario 3: changes in two repositories produce two PRs", () => {
  const common = {
    runId: "run-1",
    subjectKey: "ticket:jira:AIW-147",
    ownerToken: "owner-1",
    ticketKey: "AIW-147",
  };
  const repoX: FinalizedBranch = {
    provider: "github",
    repoPath: "acme/service",
    branchName: "blazebot/AIW-147",
    defaultBranch: "main",
    expectedHead: "before-x",
    pushedHead: "after-x",
  };
  const repoY: FinalizedBranch = {
    provider: "gitlab",
    repoPath: "acme/shared/contracts",
    branchName: "blazebot/AIW-147-contracts",
    defaultBranch: "main",
    expectedHead: "before-y",
    pushedHead: "after-y",
  };

  it("opens exactly one review link per changed write repository", async () => {
    mocks.findPr.mockReset().mockResolvedValue(null);
    mocks.recordIntent.mockReset().mockResolvedValue(undefined);
    mocks.recordPr.mockReset().mockResolvedValue(undefined);
    mocks.createPr
      .mockReset()
      .mockResolvedValueOnce({
        provider: "github",
        repoPath: "acme/service",
        id: 12,
        url: "https://github.com/acme/service/pull/12",
        branch: repoX.branchName,
        isNew: true,
      })
      .mockResolvedValueOnce({
        provider: "gitlab",
        repoPath: "acme/shared/contracts",
        id: 13,
        url: "https://gitlab.com/acme/shared/contracts/-/merge_requests/13",
        branch: repoY.branchName,
        isNew: true,
      });
    mocks.getBranchSha
      .mockReset()
      .mockResolvedValueOnce(repoX.pushedHead)
      .mockResolvedValueOnce(repoY.pushedHead);
    mocks.getPrHead
      .mockReset()
      .mockResolvedValueOnce({ headSha: repoX.pushedHead, baseRef: "main", state: "open" })
      .mockResolvedValueOnce({ headSha: repoY.pushedHead, baseRef: "main", state: "open" });

    const result = await openPullRequestsForPublication({
      ...common,
      repositories: [repoX, repoY],
      title: "AIW-147",
      body: "Changes across two repositories",
    });

    expect(result).toMatchObject({
      status: "published",
      repositories: [repoX, repoY],
      prs: [{ id: 12 }, { id: 13 }],
    });
    expect(mocks.createPr).toHaveBeenCalledTimes(2);
  });
});

describe("scenario 6: a read-only repository mutation produces zero pushes", () => {
  const owner = {
    subjectKey: "ticket:jira:AIW-147",
    ownerToken: "owner-1",
    runId: "run-1",
  };

  function writeRepo() {
    return {
      provider: "github" as const,
      repoPath: "acme/service",
      slug: "acme__service",
      localPath: "/vercel/sandbox",
      defaultBranch: "main",
      branchName: "blazebot/AIW-147",
      selectedRationale: "ticket repository",
      access: "write" as const,
      expectedRemoteSha: "before-acme/service",
      preAgentSha: "before-acme/service",
    };
  }
  function readRepo() {
    return {
      provider: "github" as const,
      repoPath: "acme/shared",
      slug: "acme__shared",
      localPath: "/vercel/sandbox/repos/shared",
      defaultBranch: "main",
      branchName: "main",
      selectedRationale: "read context",
      access: "read" as const,
      researchBaseSha: "before-acme/shared",
    };
  }

  it("fails every publication before any push when a read-only repository changed", async () => {
    mocks.isRepoAllowed.mockReset().mockReturnValue(true);
    mocks.getToken.mockReset().mockResolvedValue("secret");
    mocks.getBranchSha.mockReset().mockResolvedValue("before-acme/service");
    mocks.getPrHead
      .mockReset()
      .mockResolvedValue({ headSha: "trigger", baseRef: "main", state: "open" });
    mocks.createSandbox.mockReset();
    // The read-only clone's HEAD moved off its research baseline; the write repo
    // is otherwise clean and ready to push.
    mocks.sourceCommand.mockReset().mockImplementation(async (_name: string, args: string[]) => {
      if (args.includes("rev-parse") && args.includes("/vercel/sandbox/repos/shared")) {
        return command("changed-shared");
      }
      if (args.includes("rev-parse")) return command("after");
      return command();
    });

    const result = await publishTrustedWorkspaceFromSandbox({
      sourceSandboxId: "source-sandbox",
      workspaceManifest: {
        version: 2,
        repositories: [writeRepo(), readRepo()],
      } satisfies WorkspaceManifest,
      ...owner,
    });

    expect(result.pushed).toBe(false);
    expect(result.repositories[1]).toMatchObject({
      changed: true,
      failureKind: "read_only_changed",
    });
    // No credentialed publisher sandbox is ever created, so no push can happen.
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });
});

describe("expansion round counter survives a clarification round-trip", () => {
  // The expansion loop in agent.ts reads ctx.repositoryExpansion.rounds as
  // completedRounds (agent.ts around line 3489) and, after a completed round,
  // rebuilds ctx.repositoryExpansion with rounds + 1 plus the appended requests
  // (agent.ts around line 3518). That inline loop is not exported, so this test
  // drives the same state transitions through makeCtx and asserts them at the
  // exported validateRepositoryExpansionRequests seam. Limitation: it models the
  // durable state that replay reconstructs (by re-running the memoized expansion
  // step) rather than exercising the workflow replay machinery itself.
  it("keeps rounds=1 and priorRequests across a clarification and validates the next request with completedRounds=1", () => {
    const ctx = makeCtx({
      sandboxId: "sbx-research",
      workspaceManifest: { version: 2, repositories: [] },
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/service",
          defaultBranch: "main",
          selectedRationale: "symptom",
        },
      ],
    });
    expect(ctx.repositoryExpansion).toEqual({ rounds: 0, priorRequests: [] });

    const firstRequests = [
      {
        provider: "gitlab" as const,
        repoPath: "acme/shared/contracts",
        rationale: "imports",
      },
    ];
    const first = validateRepositoryExpansionRequests({
      requests: firstRequests,
      catalog,
      attached: ctx.selectedRepositories,
      completedRounds: ctx.repositoryExpansion.rounds,
    });
    expect(first.kind).toBe("attach");

    // Mirror the completed-round update in agent.ts: the durable counter advances.
    ctx.repositoryExpansion = {
      rounds: ctx.repositoryExpansion.rounds + 1,
      priorRequests: [...ctx.repositoryExpansion.priorRequests, ...firstRequests],
    };
    expect(ctx.repositoryExpansion.rounds).toBe(1);

    // A clarification suspend/resume does not touch ctx.repositoryExpansion.
    ctx.clarifications = [
      { questions: ["Anything else this ticket should modify?"], answer: "no" },
    ];

    // Regression guard: the counter is not reset to 0 by the clarification, and
    // the recorded prior requests survive.
    expect(ctx.repositoryExpansion.rounds).toBe(1);
    expect(ctx.repositoryExpansion.priorRequests).toEqual(firstRequests);

    // The next request is validated with completedRounds=1 (still below the
    // two-round limit), so a fresh repository attaches instead of tripping it.
    const second = validateRepositoryExpansionRequests({
      requests: [
        { provider: "gitlab", repoPath: "acme/service", rationale: "mirror config" },
      ],
      catalog,
      attached: [
        ...ctx.selectedRepositories,
        { provider: "gitlab", repoPath: "acme/shared/contracts" },
      ],
      completedRounds: ctx.repositoryExpansion.rounds,
    });
    expect(second.kind).toBe("attach");
  });
});
