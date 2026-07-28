import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RepositoryListingFailure,
  RepositoryMetadata,
} from "../../adapters/vcs/repository-directory.js";

const mocks = vi.hoisted(() => {
  const listRepositories = vi.fn();
  return {
    listRepositories,
    // Every provider answers unless a test says otherwise, so listRepositories
    // stays the one knob for the catalog.
    listRepositoriesAcrossProviders: vi.fn(
      async (): Promise<{
        repositories: RepositoryMetadata[];
        failures: RepositoryListingFailure[];
      }> => ({
        repositories: await listRepositories(),
        failures: [],
      }),
    ),
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
  listRepositoriesAcrossProviders: mocks.listRepositoriesAcrossProviders,
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

  it("resolves an incomplete catalog from an exact ticket mention", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Change the billing callback in acme/api.",
      repositories: repos,
      workflowOwnedBranches: [],
      incompleteCatalogProviders: ["gitlab"],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/api",
        selectedRationale: "ticket mentions repository path",
      }),
    ]);
  });

  it("resolves an incomplete catalog from this ticket's workflow-owned branch", () => {
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
      incompleteCatalogProviders: ["gitlab"],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories).toEqual([
      expect.objectContaining({
        repoPath: "acme/web",
        selectedRationale: "workflow-owned branch for this ticket",
      }),
    ]);
  });

  it("never hands an incomplete catalog to model discovery", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix billing webhook retry behavior",
      repositories: repos,
      workflowOwnedBranches: [],
      incompleteCatalogProviders: ["gitlab"],
    });

    expect(selected).toEqual({
      status: "catalog_incomplete",
      providers: ["gitlab"],
    });
  });

  // "Only accessible repository" is a claim about the whole catalog, and a partial
  // listing cannot support it.
  it("never calls the survivor of an incomplete catalog the only accessible repository", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Update copy",
      repositories: [repos[0]],
      workflowOwnedBranches: [],
      incompleteCatalogProviders: ["gitlab"],
    });

    expect(selected).toEqual({
      status: "catalog_incomplete",
      providers: ["gitlab"],
    });
  });

  it("never asks a human to choose from an incomplete catalog", () => {
    const many = Array.from({ length: 4 }, (_, index) => ({
      ...repos[0],
      repoPath: `acme/repo-${index}`,
      name: `repo-${index}`,
    }));

    expect(
      selectRepositoriesFromMetadata({
        ticketText: many.map((repo) => repo.repoPath).join(" "),
        repositories: many,
        workflowOwnedBranches: [],
        incompleteCatalogProviders: ["gitlab"],
      }),
    ).toEqual({ status: "catalog_incomplete", providers: ["gitlab"] });

    expect(
      selectRepositoriesFromMetadata({
        ticketText: "Update copy",
        repositories: repos,
        workflowOwnedBranches: [],
        repositoryScope: {
          repositories: [{ provider: "gitlab", repoPath: "acme/billing" }],
        },
        incompleteCatalogProviders: ["gitlab"],
      }),
    ).toEqual({ status: "catalog_incomplete", providers: ["gitlab"] });
  });

  // Invariant: a healthy listing must leave every existing path byte for byte intact.
  it("keeps every path identical when no provider is missing", () => {
    const cases = [
      { ticketText: "Fix billing webhook retry behavior", repositories: repos },
      { ticketText: "Change the billing callback in acme/api.", repositories: repos },
      { ticketText: "Update copy", repositories: [repos[0]] },
    ];

    for (const { ticketText, repositories } of cases) {
      expect(
        selectRepositoriesFromMetadata({
          ticketText,
          repositories,
          workflowOwnedBranches: [],
          incompleteCatalogProviders: [],
        }),
      ).toEqual(
        selectRepositoriesFromMetadata({
          ticketText,
          repositories,
          workflowOwnedBranches: [],
        }),
      );
    }
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

    expect(mocks.listRepositoriesAcrossProviders).toHaveBeenCalledWith([
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

    expect(mocks.listRepositoriesAcrossProviders).toHaveBeenCalledWith([
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

    expect(mocks.listRepositoriesAcrossProviders).toHaveBeenCalledWith([
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

describe("repoSelectionStep with a provider that never answered", () => {
  const timedOutGitLab: RepositoryListingFailure = {
    provider: "gitlab",
    message: "GitLab projects list timed out after 15000ms",
    error: new Error("GitLab projects list timed out after 15000ms"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({ db: true });
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([]);
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

  it("continues on a deterministic ticket mention and records the degradation", async () => {
    mocks.listRepositoriesAcrossProviders.mockResolvedValueOnce({
      repositories: repos,
      failures: [timedOutGitLab],
    });

    const result = await repoSelectionStep({
      context: {
        ticket: {
          identifier: "AIW-45",
          title: "Fix the billing callback in acme/api",
        },
        run: { branchName: "blazebot/aiw-45" },
      },
      config: undefined,
      step: { uses: "repo-selection", onFailure: "fail" },
    });

    expect(result.status).toBe("continue");
    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({
        provider: "github",
        repoPath: "acme/api",
        selectedRationale: "ticket mentions repository path",
      }),
    ]);
    expect(result.repositoryCatalogDegradation).toEqual({
      providers: ["gitlab"],
      outcome: "continued_degraded",
    });
  });

  it("fails closed and names the provider when no deterministic signal survives", async () => {
    mocks.listRepositoriesAcrossProviders.mockResolvedValueOnce({
      repositories: repos,
      failures: [timedOutGitLab],
    });

    const result = await repoSelectionStep({
      context: {
        ticket: { identifier: "AIW-45", title: "Fix billing webhook retry behavior" },
        run: { branchName: "blazebot/aiw-45" },
      },
      config: undefined,
      step: { uses: "repo-selection", name: "Select repositories", onFailure: "fail" },
    });

    expect(result).toMatchObject({
      status: "halt",
      outcome: "failed",
      repositoryCatalogDegradation: {
        providers: ["gitlab"],
        outcome: "failed_closed",
      },
    });
    if (result.status !== "halt") throw new Error("expected halt");
    // Operators grep the run reason by step name, so a step that stops itself must
    // still say which step it was.
    expect(result.message).toContain("Select repositories failed:");
    expect(result.message).toContain("gitlab");
    expect(result.message).toContain("incomplete");
    expect(result.message).toContain("GitLab projects list timed out after 15000ms");
    expect(result.selectedRepositories).toBeUndefined();
    expect(result.repositoryDiscovery).toBeUndefined();
    expect(result.questions).toBeUndefined();
  });

  it("continues normally when the pin already excluded the failed provider", async () => {
    mocks.listRepositoriesAcrossProviders.mockResolvedValueOnce({
      repositories: repos,
      failures: [timedOutGitLab],
    });

    const result = await repoSelectionStep({
      context: {
        ticket: { identifier: "AIW-45", title: "Update copy" },
        run: { branchName: "blazebot/aiw-45" },
        // No provider list, so GitLab is still queried, but nothing it could have
        // returned survives this pin.
        repositoryScope: {
          repositories: [{ provider: "github", repoPath: "acme/api" }],
        },
      },
      config: undefined,
      step: { uses: "repo-selection", onFailure: "fail" },
    });

    expect(result.status).toBe("continue");
    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({
        provider: "github",
        repoPath: "acme/api",
        selectedRationale: "pinned to this workflow",
      }),
    ]);
    expect(result.repositoryCatalogDegradation).toEqual({
      providers: ["gitlab"],
      outcome: "continued_degraded",
    });
  });

  // The provider is queried past the pin precisely so an in-flight pull request is
  // not stranded, so its silence is never harmless.
  it("fails closed when the failed provider carries this ticket's workflow-owned branch", async () => {
    mocks.listRepositoriesAcrossProviders.mockResolvedValueOnce({
      repositories: repos,
      failures: [timedOutGitLab],
    });
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([
      {
        ticketKey: "AIW-45",
        provider: "gitlab",
        repoPath: "acme/api",
        branchName: "blazebot/aiw-45",
        pr: null,
      },
    ]);

    const result = await repoSelectionStep({
      context: {
        ticket: { identifier: "AIW-45", title: "Address review feedback" },
        run: { branchName: "blazebot/aiw-45" },
        repositoryScope: { providers: ["github"] },
      },
      config: undefined,
      step: { uses: "repo-selection", onFailure: "fail" },
    });

    expect(result).toMatchObject({
      status: "halt",
      outcome: "failed",
      repositoryCatalogDegradation: {
        providers: ["gitlab"],
        outcome: "failed_closed",
      },
    });
  });

  it("records no degradation when every provider answers", async () => {
    mocks.listRepositories.mockResolvedValueOnce(repos);

    const result = await repoSelectionStep({
      context: {
        ticket: {
          identifier: "AIW-45",
          title: "Fix the billing callback in acme/api",
        },
        run: { branchName: "blazebot/aiw-45" },
      },
      config: undefined,
      step: { uses: "repo-selection", onFailure: "fail" },
    });

    expect(result.status).toBe("continue");
    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({ provider: "github", repoPath: "acme/api" }),
    ]);
    expect(result).not.toHaveProperty("repositoryCatalogDegradation");
  });
});
