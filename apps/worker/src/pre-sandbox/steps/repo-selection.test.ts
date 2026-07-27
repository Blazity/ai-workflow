import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryMetadata } from "../../adapters/vcs/repository-directory.js";

const mocks = vi.hoisted(() => {
  const listRepositories = vi.fn();
  return {
    listRepositories,
    createRepositoryDirectoryForProviders: vi.fn(() => ({ listRepositories })),
    getConfiguredVcsProviders: vi.fn(),
    getDb: vi.fn(),
    listWorkflowOwnedBranchesForTicket: vi.fn(),
  };
});

// The pin filter is a pure helper in the same module and stays real: mocking it
// would hide the intersection this suite is asserting.
vi.mock("../../adapters/vcs/repository-directory.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../adapters/vcs/repository-directory.js")
  >()),
  createRepositoryDirectory: vi.fn(() => ({
    listRepositories: mocks.listRepositories,
  })),
  createRepositoryDirectoryForProviders: mocks.createRepositoryDirectoryForProviders,
}));

vi.mock("../../../env.js", () => ({
  getConfiguredVcsProviders: mocks.getConfiguredVcsProviders,
}));

vi.mock("../../db/client.js", () => ({
  getDb: mocks.getDb,
}));

vi.mock("../../db/queries/workflow-owned-branches.js", () => ({
  listWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
}));

import { repoSelectionStep, selectRepositoriesFromMetadata } from "./repo-selection.js";
import { MAX_ACCESSIBLE_REPOSITORIES } from "../../repository-discovery/catalog.js";

const repos: RepositoryMetadata[] = [
  {
    provider: "github",
    repoPath: "acme/web",
    name: "web",
    owner: "acme",
    defaultBranch: "main",
    description: "Next.js storefront",
    webUrl: "https://github.com/acme/web",
    topics: ["frontend"],
    archived: false,
    private: true,
  },
  {
    provider: "github",
    repoPath: "acme/api",
    name: "api",
    owner: "acme",
    defaultBranch: "main",
    description: "Billing API and webhook handlers",
    webUrl: "https://github.com/acme/api",
    topics: ["backend"],
    archived: false,
    private: true,
  },
];

describe("selectRepositoriesFromMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects repositories with exact path matches", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Change the billing callback in acme/api.",
      repositories: repos,
      workflowOwnedBranches: [],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories.map((r) => r.repoPath)).toEqual(["acme/api"]);
  });

  it("does not treat embedded repository path prefixes as exact matches", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "The failure mentions xxacme/apiary.",
      repositories: repos,
      workflowOwnedBranches: [],
    });

    expect(selected).toMatchObject({
      status: "discovery_needed",
      mandatoryRepositories: [],
    });
  });

  it("defers ambiguous selection to bounded model discovery", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix billing webhook retry behavior",
      repositories: repos,
      workflowOwnedBranches: [],
    });

    expect(selected).toMatchObject({
      status: "discovery_needed",
      catalog: [
        expect.objectContaining({ repoPath: "acme/api" }),
        expect.objectContaining({ repoPath: "acme/web" }),
      ],
      mandatoryRepositories: [],
    });
  });

  it("does not manufacture a clarification question before discovery runs", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix billing webhook retry behavior",
      repositories: repos,
      workflowOwnedBranches: [],
    });

    expect(selected.status).toBe("discovery_needed");
  });

  it("requests discovery when no repository matches", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Update data warehouse model",
      repositories: repos,
      workflowOwnedBranches: [],
    });

    expect(selected).toMatchObject({
      status: "discovery_needed",
      mandatoryRepositories: [],
    });
  });

  it("selects the only accessible repository when no text matches", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Update copy",
      repositories: [repos[0]],
      workflowOwnedBranches: [],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/web",
        selectedRationale: "only accessible repository",
      }),
    ]);
  });

  it("force-includes repositories with workflow-owned branches", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Address review feedback",
      repositories: repos,
      workflowOwnedBranches: [
        {
          provider: "github",
          repoPath: "acme/web",
          branch: {
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

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories[0]).toMatchObject({
      repoPath: "acme/web",
      workflowOwnedBranch: {
        branchName: "blazebot/aiw-45",
        pr: { id: 42 },
      },
    });
  });

  it("asks for clarification when deterministic matches exceed the initial limit", () => {
    const many = Array.from({ length: 4 }, (_, index) => ({
      ...repos[0],
      repoPath: `acme/repo-${index}`,
      name: `repo-${index}`,
    }));
    const selected = selectRepositoriesFromMetadata({
      ticketText: many.map((repo) => repo.repoPath).join(" "),
      repositories: many,
      workflowOwnedBranches: [],
    });

    expect(selected).toMatchObject({ status: "clarification_needed" });
  });

  it("never deterministically selects archived or uninitialized repositories", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix acme/archived and acme/empty",
      repositories: [
        { ...repos[0], repoPath: "acme/archived", archived: true },
        { ...repos[1], repoPath: "acme/empty", defaultBranch: "" },
      ],
      workflowOwnedBranches: [],
    });

    expect(selected).toMatchObject({
      status: "discovery_needed",
      mandatoryRepositories: [],
    });
  });

  it("selects an exact repository mention even above the catalog limit", () => {
    const many = Array.from(
      { length: MAX_ACCESSIBLE_REPOSITORIES + 1 },
      (_, index) => ({
        ...repos[0],
        repoPath: `acme/repo-${index}`,
        name: `repo-${index}`,
      }),
    );

    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix the billing callback in acme/repo-137.",
      repositories: many,
      workflowOwnedBranches: [],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories.map((r) => r.repoPath)).toEqual(["acme/repo-137"]);
  });

  it("force-includes a workflow-owned branch even above the catalog limit", () => {
    const many = Array.from(
      { length: MAX_ACCESSIBLE_REPOSITORIES + 1 },
      (_, index) => ({
        ...repos[0],
        repoPath: `acme/repo-${index}`,
        name: `repo-${index}`,
      }),
    );

    const selected = selectRepositoriesFromMetadata({
      ticketText: "Address review feedback",
      repositories: many,
      workflowOwnedBranches: [
        {
          provider: "github",
          repoPath: "acme/repo-5",
          branch: {
            branchName: "blazebot/aiw-99",
            pr: {
              id: 7,
              url: "https://github.com/acme/repo-5/pull/7",
              branch: "blazebot/aiw-99",
            },
          },
        },
      ],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/repo-5",
        workflowOwnedBranch: expect.objectContaining({ branchName: "blazebot/aiw-99" }),
      }),
    ]);
  });

  it("still fails closed on an over-limit catalog when discovery is required", () => {
    const many = Array.from(
      { length: MAX_ACCESSIBLE_REPOSITORIES + 1 },
      (_, index) => ({
        ...repos[0],
        repoPath: `acme/repo-${index}`,
        name: `repo-${index}`,
      }),
    );

    expect(() =>
      selectRepositoriesFromMetadata({
        ticketText: "Improve overall reliability",
        repositories: many,
        workflowOwnedBranches: [],
      }),
    ).toThrow("Accessible repository catalog exceeds 200 entries");
  });

  it("attaches every pinned repository without discovery or clarification", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix billing webhook retry behavior",
      repositories: repos,
      workflowOwnedBranches: [],
      repositoryScope: {
        repositories: [
          { provider: "github", repoPath: "acme/api" },
          { provider: "github", repoPath: "acme/web" },
        ],
      },
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/web",
        selectedRationale: "pinned to this workflow",
      }),
      expect.objectContaining({
        repoPath: "acme/api",
        selectedRationale: "pinned to this workflow",
      }),
    ]);
  });

  it("matches a pinned repository stored in a different case", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Update copy",
      repositories: repos,
      workflowOwnedBranches: [],
      repositoryScope: {
        repositories: [{ provider: "github", repoPath: "Acme/Web" }],
      },
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories.map((repo) => repo.repoPath)).toEqual(["acme/web"]);
  });

  it("does not apply the initial-match limit to an explicit pin", () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      ...repos[0],
      repoPath: `acme/repo-${index}`,
      name: `repo-${index}`,
    }));

    const selected = selectRepositoriesFromMetadata({
      ticketText: "Improve overall reliability",
      repositories: many,
      workflowOwnedBranches: [],
      repositoryScope: {
        repositories: many.map((repo) => ({
          provider: "github" as const,
          repoPath: repo.repoPath,
        })),
      },
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories).toHaveLength(5);
  });

  it("attaches a workflow-owned branch outside the pin alongside the pinned repositories", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Address review feedback",
      repositories: repos,
      workflowOwnedBranches: [
        {
          provider: "github",
          repoPath: "acme/web",
          branch: { branchName: "blazebot/aiw-45" },
        },
      ],
      repositoryScope: {
        repositories: [{ provider: "github", repoPath: "acme/api" }],
      },
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/web",
        selectedRationale: "workflow-owned branch for this ticket",
        workflowOwnedBranch: expect.objectContaining({ branchName: "blazebot/aiw-45" }),
      }),
      expect.objectContaining({
        repoPath: "acme/api",
        selectedRationale: "pinned to this workflow",
      }),
    ]);
  });

  it("clarifies by name when one pinned repository is unusable", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix billing webhook retry behavior",
      repositories: [repos[0], { ...repos[1], archived: true }],
      workflowOwnedBranches: [],
      repositoryScope: {
        repositories: [
          { provider: "github", repoPath: "acme/web" },
          { provider: "github", repoPath: "acme/api" },
        ],
      },
    });

    expect(selected.status).toBe("clarification_needed");
    if (selected.status !== "clarification_needed") {
      throw new Error("expected clarification");
    }
    expect(selected.questions[0]).toContain("github:acme/api");
    expect(selected.questions[0]).not.toContain("acme/web");
  });

  it("clarifies instead of discovering when no pinned repository is usable", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix billing webhook retry behavior",
      repositories: repos,
      workflowOwnedBranches: [],
      repositoryScope: {
        repositories: [{ provider: "github", repoPath: "acme/warehouse" }],
      },
    });

    expect(selected).toMatchObject({
      status: "clarification_needed",
      questions: [expect.stringContaining("github:acme/warehouse")],
    });
  });

  // The allowlist is applied by the repository directory, so an excluded
  // repository never reaches selection. The pin must not be able to bring it back.
  it("cannot resurrect a pinned repository the allowlist dropped", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix acme/secret",
      repositories: [repos[0]],
      workflowOwnedBranches: [],
      repositoryScope: {
        repositories: [
          { provider: "github", repoPath: "acme/web" },
          { provider: "github", repoPath: "acme/secret" },
        ],
      },
    });

    expect(selected.status).toBe("clarification_needed");
    if (selected.status !== "clarification_needed") {
      throw new Error("expected clarification");
    }
    expect(selected.questions[0]).toContain("github:acme/secret");
  });

  it("never lists another provider's repositories under a provider pin", () => {
    const mixed = [
      repos[0],
      { ...repos[1], provider: "gitlab" as const, repoPath: "acme/api" },
    ];

    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix the billing callback in acme/api.",
      repositories: mixed,
      workflowOwnedBranches: [],
      repositoryScope: { providers: ["gitlab"] },
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories).toEqual([
      expect.objectContaining({ provider: "gitlab", repoPath: "acme/api" }),
    ]);
  });

  it("narrows the discovery catalog to the pinned providers", () => {
    const mixed = [
      repos[0],
      { ...repos[1], provider: "gitlab" as const, repoPath: "acme/billing" },
      { ...repos[1], provider: "gitlab" as const, repoPath: "acme/payments" },
    ];

    const selected = selectRepositoriesFromMetadata({
      ticketText: "Improve overall reliability",
      repositories: mixed,
      workflowOwnedBranches: [],
      repositoryScope: { providers: ["gitlab"] },
    });

    expect(selected).toMatchObject({
      status: "discovery_needed",
      catalog: [
        expect.objectContaining({ provider: "gitlab", repoPath: "acme/billing" }),
        expect.objectContaining({ provider: "gitlab", repoPath: "acme/payments" }),
      ],
    });
  });

  // Invariant: an absent pin must leave every existing path byte for byte intact.
  it("keeps the unpinned path identical when the scope is absent or empty", () => {
    const ticketText = "Fix billing webhook retry behavior";
    const unpinned = selectRepositoriesFromMetadata({
      ticketText,
      repositories: repos,
      workflowOwnedBranches: [],
    });

    expect(
      selectRepositoriesFromMetadata({
        ticketText,
        repositories: repos,
        workflowOwnedBranches: [],
        repositoryScope: {},
      }),
    ).toEqual(unpinned);
    expect(
      selectRepositoriesFromMetadata({
        ticketText,
        repositories: repos,
        workflowOwnedBranches: [],
        repositoryScope: { repositories: [], providers: [] },
      }),
    ).toEqual(unpinned);
    expect(unpinned.status).toBe("discovery_needed");
  });

  it("selects the single usable repository regardless of archived catalog volume", () => {
    const archived = Array.from(
      { length: MAX_ACCESSIBLE_REPOSITORIES + 1 },
      (_, index) => ({
        ...repos[0],
        repoPath: `acme/archived-${index}`,
        name: `archived-${index}`,
        archived: true,
      }),
    );

    const selected = selectRepositoriesFromMetadata({
      ticketText: "Update copy",
      repositories: [repos[0], ...archived],
      workflowOwnedBranches: [],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/web",
        selectedRationale: "only accessible repository",
      }),
    ]);
  });
});

describe("repoSelectionStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.getConfiguredVcsProviders.mockReturnValue([
      {
        kind: "github",
        auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
        host: "https://github.com",
        legacyBaseBranch: "main",
      },
      {
        kind: "gitlab",
        token: "glpat",
        host: "https://gitlab.example.com",
        legacyBaseBranch: "main",
      },
    ]);
  });

  it("selects repositories using provider metadata and workflow-owned branches", async () => {
    mocks.listRepositories.mockResolvedValueOnce(repos);
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValueOnce([
      {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        pr: {
          id: 42,
          url: "https://github.com/acme/web/pull/42",
          branch: "blazebot/aiw-45",
        },
      },
    ]);

    const result = await repoSelectionStep({
      context: {
        ticket: {
          identifier: "AIW-45",
          title: "Address review feedback",
          description: "",
          acceptanceCriteria: "",
          comments: [],
          labels: [],
        },
        run: {
          branchName: "blazebot/aiw-45",
        },
      },
      config: undefined,
      step: { uses: "repo-selection", onFailure: "fail" },
    });

    expect(mocks.listWorkflowOwnedBranchesForTicket).toHaveBeenCalledWith({ db: true }, "AIW-45");
    expect(result.status).toBe("continue");
    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/web",
        workflowOwnedBranch: expect.objectContaining({ branchName: "blazebot/aiw-45" }),
      }),
    ]);
    expect(result.promptAdditions?.[0]?.content).toContain("github:acme/web");
  });

  it("queries only the pinned providers and reports the narrowing", async () => {
    mocks.listRepositories.mockResolvedValueOnce([
      { ...repos[0], provider: "gitlab", repoPath: "acme/web" },
      { ...repos[1], provider: "gitlab", repoPath: "acme/api" },
    ]);
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValueOnce([]);

    const result = await repoSelectionStep({
      context: {
        ticket: { identifier: "AIW-45", title: "Update copy" },
        run: { branchName: "blazebot/aiw-45" },
        repositoryScope: {
          providers: ["gitlab"],
          repositories: [{ provider: "gitlab", repoPath: "acme/api" }],
        },
      },
      config: undefined,
      step: { uses: "repo-selection", onFailure: "fail" },
    });

    expect(mocks.createRepositoryDirectoryForProviders).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "gitlab" }),
    ]);
    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({ provider: "gitlab", repoPath: "acme/api" }),
    ]);
    expect(result.repositoryScopeNarrowing).toEqual({
      catalogSize: 2,
      scopedCatalogSize: 1,
    });
  });

  it("keeps listing a provider that carries a workflow-owned branch for this ticket", async () => {
    mocks.listRepositories.mockResolvedValueOnce(repos);
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValueOnce([
      {
        ticketKey: "AIW-45",
        provider: "github",
        repoPath: "acme/web",
        branchName: "blazebot/aiw-45",
        pr: null,
      },
    ]);

    await repoSelectionStep({
      context: {
        ticket: { identifier: "AIW-45", title: "Address review feedback" },
        run: { branchName: "blazebot/aiw-45" },
        repositoryScope: { providers: ["gitlab"] },
      },
      config: undefined,
      step: { uses: "repo-selection", onFailure: "fail" },
    });

    expect(mocks.createRepositoryDirectoryForProviders).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "github" }),
      expect.objectContaining({ kind: "gitlab" }),
    ]);
  });

  it("reports no narrowing and queries every provider without a pin", async () => {
    mocks.listRepositories.mockResolvedValueOnce([repos[0]]);
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValueOnce([]);

    const result = await repoSelectionStep({
      context: {
        ticket: { identifier: "AIW-45", title: "Update copy" },
        run: { branchName: "blazebot/aiw-45" },
      },
      config: undefined,
      step: { uses: "repo-selection", onFailure: "fail" },
    });

    expect(mocks.createRepositoryDirectoryForProviders).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "github" }),
      expect.objectContaining({ kind: "gitlab" }),
    ]);
    expect(result.repositoryScopeNarrowing).toBeUndefined();
    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/web",
        selectedRationale: "only accessible repository",
      }),
    ]);
  });

  it("keeps workflow-owned branches provider-scoped when repo paths overlap", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Address review feedback",
      repositories: [
        {
          ...repos[0],
          provider: "github",
          repoPath: "acme/app",
        },
        {
          ...repos[1],
          provider: "gitlab",
          repoPath: "acme/app",
        },
      ],
      workflowOwnedBranches: [
        {
          provider: "gitlab",
          repoPath: "acme/app",
          branch: {
            branchName: "blazebot/aiw-45",
            pr: {
              id: 42,
              url: "https://gitlab.example.com/acme/app/-/merge_requests/42",
              branch: "blazebot/aiw-45",
            },
          },
        },
      ],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories).toEqual([
      expect.objectContaining({
        provider: "gitlab",
        repoPath: "acme/app",
        workflowOwnedBranch: expect.objectContaining({ branchName: "blazebot/aiw-45" }),
      }),
    ]);
  });
});
