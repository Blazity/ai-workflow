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
    // Both routing kill switches. Off in every pre-existing test, which is what
    // makes those tests the flag-off regression proof.
    env: { ENABLE_REPO_MEMORY: false, ENABLE_REPO_ROUTING_MEMORY: false },
    getMemoryDocument: vi.fn(),
    upsertMemoryDocument: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
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
  env: mocks.env,
  getConfiguredVcsProviders: mocks.getConfiguredVcsProviders,
}));

vi.mock("../../db/client.js", () => ({
  getDb: mocks.getDb,
}));

vi.mock("../../db/queries/workflow-owned-branches.js", () => ({
  listWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
}));

// The store is mocked, the routing document format is not: mocking the render and
// parse would hide the round trip the read path depends on.
vi.mock("../../memory/store.js", () => ({
  getMemoryDocument: mocks.getMemoryDocument,
  upsertMemoryDocument: mocks.upsertMemoryDocument,
}));

vi.mock("../../lib/logger.js", () => ({ logger: mocks.logger }));

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
    // Pinned off, so no describe order can leak a flag into this block.
    mocks.env.ENABLE_REPO_MEMORY = false;
    mocks.env.ENABLE_REPO_ROUTING_MEMORY = false;
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

  it("selects an exact workflow pin outside the global allowlist", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "acme/api";
    mocks.listRepositories.mockResolvedValueOnce([
      repos[0],
      repos[1],
      { ...repos[0], provider: "gitlab", repoPath: "group/tool" },
    ]);
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValueOnce([]);

    try {
      const result = await repoSelectionStep({
        context: {
          ticket: {
            identifier: "AIW-45",
            title: "Fix group/tool",
          },
          run: { branchName: "blazebot/aiw-45" },
          repositoryScope: {
            repositories: [
              { provider: "gitlab", repoPath: "group/tool" },
            ],
          },
        },
        config: undefined,
        step: { uses: "repo-selection", onFailure: "fail" },
      });

      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({
          provider: "gitlab",
          repoPath: "group/tool",
        }),
      ]);
      expect(result.repositoryScopeNarrowing).toEqual({
        catalogSize: 2,
        scopedCatalogSize: 1,
      });
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
  });

  it("does not expose an outside repository through provider-only scope", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "acme/api";
    mocks.listRepositories.mockResolvedValueOnce([
      repos[1],
      { ...repos[0], provider: "gitlab", repoPath: "group/tool" },
    ]);
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValueOnce([]);

    try {
      const result = await repoSelectionStep({
        context: {
          ticket: {
            identifier: "AIW-45",
            title: "Fix group/tool",
          },
          run: { branchName: "blazebot/aiw-45" },
          repositoryScope: { providers: ["gitlab"] },
        },
        config: undefined,
        step: { uses: "repo-selection", onFailure: "fail" },
      });

      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery?.catalog).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
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
    mocks.env.ENABLE_REPO_MEMORY = false;
    mocks.env.ENABLE_REPO_ROUTING_MEMORY = false;
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

/**
 * Remembered routing: the org-scoped label answer that stands in for the
 * "which repository?" question a non-technical ticket author would otherwise be
 * asked again on every ticket.
 *
 * The safety property under test is that a remembered entry may ONLY ever replace
 * that question. It is structural, not ordering: selectRepositoriesFromMetadata
 * does not take the entries as an argument, and the read is reachable only from
 * inside the discovery_needed branch of the step, which every deterministic signal
 * returns before. The tests below hold the property from the outside anyway, so a
 * later edit that moves the call cannot pass them.
 */
describe("repoSelectionStep remembered repository routing", () => {
  /** Two satellites plus a monorepo, the client shape this feature exists for:
   *  nothing in the ticket text names a repository, so selection falls through to
   *  discovery and a human gets asked. */
  const catalog: RepositoryMetadata[] = [
    { ...repos[0]!, repoPath: "acme/web", name: "web" },
    { ...repos[1]!, repoPath: "acme/api", name: "api" },
    { ...repos[0]!, repoPath: "acme/monorepo", name: "monorepo" },
  ];

  /** Corroborated by two distinct tickets, which is what an entry needs before it
   *  may select anything. */
  const ROUTING_DOC = "- billing -> github:acme/api (tickets: AIW-1, AIW-7)\n";
  /** One ticket only: stored so a second can confirm it, never eligible to select. */
  const UNCORROBORATED_DOC = "- billing -> github:acme/api (tickets: AIW-1)\n";

  function routingDocument(body: string, version = 3) {
    return {
      content: `# Repo routing: acme\n<!-- blazebot:repo-routing v1 -->\n\n${body}`,
      bytes: body.length,
      updatedAt: new Date("2026-07-29T00:00:00.000Z"),
      sourceRunId: "presandbox:blazebot/aiw-1",
      version,
    };
  }

  async function run(
    ticket: Record<string, unknown>,
    repositoryScope?: Record<string, unknown>,
    clarification?: Record<string, unknown>,
  ) {
    return repoSelectionStep({
      context: {
        ticket: ticket as never,
        run: { branchName: "blazebot/aiw-45" },
        ...(repositoryScope ? { repositoryScope: repositoryScope as never } : {}),
        ...(clarification ? { clarification: clarification as never } : {}),
      },
      config: undefined,
      step: { uses: "repo-selection", onFailure: "fail" },
    });
  }

  /**
   * A human answering the which-repo question. prepare-workspace appends the reply as
   * a synthetic comment, which is what the selection scan reads, AND sets the
   * structural clarification field, which is what tells this step the reply is
   * testimony about repositories rather than an answer to some other question.
   */
  const answer = (body: string) => [{ author: "Human clarification", body }];
  const resolvesRepositories = (body: string) => ({
    answer: body,
    resolves: "repository_selection",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.ENABLE_REPO_MEMORY = true;
    mocks.env.ENABLE_REPO_ROUTING_MEMORY = true;
    mocks.getDb.mockReturnValue({ db: true });
    mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([]);
    mocks.listRepositories.mockResolvedValue(catalog);
    mocks.getMemoryDocument.mockResolvedValue(null);
    mocks.upsertMemoryDocument.mockResolvedValue({ applied: true, version: 1 });
    mocks.getConfiguredVcsProviders.mockReturnValue([
      {
        kind: "github",
        auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
        host: "https://github.com",
        legacyBaseBranch: "main",
      },
    ]);
  });

  describe("reading", () => {
    it("resolves a ticket that would otherwise ask", async () => {
      // Without the entry this ticket reaches discovery, which is what asks.
      mocks.env.ENABLE_REPO_MEMORY = false;
      const asked = await run({ identifier: "AIW-1", title: "Invoices are wrong", labels: ["billing"] });
      expect(asked.selectedRepositories).toBeUndefined();
      expect(asked.repositoryDiscovery).toBeDefined();

      mocks.env.ENABLE_REPO_MEMORY = true;
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));
      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });

      expect(mocks.getMemoryDocument).toHaveBeenCalledWith({ db: true }, "org:github:acme", "routing");
      expect(result.status).toBe("continue");
      expect(result.repositoryDiscovery).toBeUndefined();
      expect(result.selectedRepositories).toEqual([
        {
          provider: "github",
          repoPath: "acme/api",
          defaultBranch: "main",
          selectedRationale: "remembered from a human answer for a matching ticket label",
        },
      ]);
      // The label is a ticket author's text and never reaches a prompt.
      expect(result.promptAdditions?.[0]?.content).toBe(
        "- github:acme/api: remembered from a human answer for a matching ticket label",
      );
      expect(result.promptAdditions?.[0]?.content).not.toContain("billing");
    });

    it("matches a label case insensitively and ignores unrelated labels", async () => {
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));
      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["needs-triage", "BILLING"],
      });
      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({ repoPath: "acme/api" }),
      ]);
    });

    it("never reads for a ticket with no labels", async () => {
      const result = await run({ identifier: "AIW-1", title: "Invoices are wrong", labels: [] });
      expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
      expect(result.repositoryDiscovery).toBeDefined();
    });

    it("does not change a selection an owned branch already made", async () => {
      mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([
        {
          ticketKey: "AIW-1",
          provider: "github",
          repoPath: "acme/web",
          branchName: "blazebot/aiw-1",
          pr: null,
        },
      ]);
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });

      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({
          repoPath: "acme/web",
          selectedRationale: "workflow-owned branch for this ticket",
        }),
      ]);
      expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not change a selection the definition pin already made", async () => {
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));

      const result = await run(
        { identifier: "AIW-1", title: "Invoices are wrong", labels: ["billing"] },
        { repositories: [{ provider: "github", repoPath: "acme/web" }] },
      );

      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({
          repoPath: "acme/web",
          selectedRationale: "pinned to this workflow",
        }),
      ]);
      expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not change a selection ticket-text matching already made", async () => {
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong in acme/web",
        labels: ["billing"],
      });

      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({
          repoPath: "acme/web",
          selectedRationale: "ticket mentions repository path",
        }),
      ]);
      expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not change the only-accessible-repository shortcut", async () => {
      mocks.listRepositories.mockResolvedValue([catalog[0]!]);
      mocks.getMemoryDocument.mockResolvedValue(routingDocument("- billing -> github:acme/api (tickets: AIW-1, AIW-7)\n"));

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });

      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({
          repoPath: "acme/web",
          selectedRationale: "only accessible repository",
        }),
      ]);
      expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not rescue a run that failed closed on an incomplete catalog", async () => {
      mocks.listRepositoriesAcrossProviders.mockResolvedValueOnce({
        repositories: catalog,
        failures: [
          {
            provider: "gitlab",
            message: "GitLab projects list timed out",
            error: new Error("GitLab projects list timed out"),
          },
        ],
      });
      mocks.getConfiguredVcsProviders.mockReturnValue([
        {
          kind: "github",
          auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
          host: "https://github.com",
          legacyBaseBranch: "main",
        },
        { kind: "gitlab", token: "glpat", host: "https://gitlab.example.com", legacyBaseBranch: "main" },
      ]);
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });

      expect(result).toMatchObject({ status: "halt", outcome: "failed" });
      expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
    });

    it("ignores a remembered repository that has left the catalog", async () => {
      mocks.getMemoryDocument.mockResolvedValue(routingDocument("- billing -> github:acme/gone (tickets: AIW-1, AIW-7)\n"));
      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });
      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
    });

    it("ignores a remembered repository that is no longer usable", async () => {
      // No default branch, so the catalog marks it unusable and no workspace can
      // clone it.
      mocks.listRepositories.mockResolvedValue([
        catalog[0]!,
        { ...catalog[1]!, defaultBranch: "" },
        catalog[2]!,
      ]);
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));
      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });
      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
    });

    it("ignores a remembered repository the pin excludes", async () => {
      // A provider-only pin leaves selection falling through to discovery, so the
      // read does run, and the pinned catalog is what the entry is checked against.
      mocks.getConfiguredVcsProviders.mockReturnValue([
        { kind: "gitlab", token: "glpat", host: "https://gitlab.example.com", legacyBaseBranch: "main" },
      ]);
      // Two GitLab repositories, so the pinned catalog does not collapse into the
      // only-accessible-repository shortcut and the run really does reach discovery.
      mocks.listRepositories.mockResolvedValue([
        ...catalog,
        { ...catalog[1]!, provider: "gitlab", repoPath: "acme/api" },
        { ...catalog[0]!, provider: "gitlab", repoPath: "acme/web" },
      ]);
      mocks.getMemoryDocument.mockResolvedValue(routingDocument("- billing -> github:acme/api (tickets: AIW-1, AIW-7)\n"));

      const result = await run(
        { identifier: "AIW-1", title: "Invoices are wrong", labels: ["billing"] },
        { providers: ["gitlab"] },
      );

      expect(mocks.getMemoryDocument).toHaveBeenCalledWith(
        { db: true },
        "org:gitlab:acme",
        "routing",
      );
      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
    });

    it("ignores an entry naming a repository outside the document's own owner", async () => {
      // The cross-tenant path: a document under one owning namespace may never
      // route a ticket to a repository belonging to a sibling.
      mocks.listRepositories.mockResolvedValue([
        ...catalog,
        { ...catalog[1]!, repoPath: "other/api" },
      ]);
      mocks.getMemoryDocument.mockImplementation(async (_db, subjectKey: string) =>
        subjectKey === "org:github:acme" ? routingDocument("- billing -> github:other/api (tickets: AIW-1, AIW-7)\n") : null,
      );

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });
      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
    });

    it("asks when two labels remember two different repositories", async () => {
      mocks.getMemoryDocument.mockResolvedValue(
        routingDocument(
          "- billing -> github:acme/api (tickets: AIW-1, AIW-7)\n" +
            "- storefront -> github:acme/web (tickets: AIW-2, AIW-8)\n",
        ),
      );

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing", "storefront"],
      });

      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
      expect(mocks.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ repositories: expect.arrayContaining(["github:acme/api"]) }),
        "repo_routing_ambiguous",
      );
    });

    it("resolves when two labels remember the same repository", async () => {
      mocks.getMemoryDocument.mockResolvedValue(
        routingDocument(
          "- billing -> github:acme/api (tickets: AIW-1, AIW-7)\n" +
            "- invoices -> github:acme/api (tickets: AIW-2, AIW-8)\n",
        ),
      );

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing", "invoices"],
      });

      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({ repoPath: "acme/api" }),
      ]);
    });

    it("asks when a disagreeing label points at a repository that has left the catalog", async () => {
      // Liveness is a property of the repository, not of the testimony. The
      // "billing" answer asserted "not acme/api"; finding its own target renamed
      // away makes that assertion unactionable, it does not make it agree, so
      // resolving to the survivor would be the inference the harm asymmetry forbids.
      mocks.getMemoryDocument.mockResolvedValue(
        routingDocument(
          "- billing -> github:acme/gone (tickets: AIW-1, AIW-7)\n" +
            "- invoices -> github:acme/api (tickets: AIW-2, AIW-8)\n",
        ),
      );

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing", "invoices"],
      });

      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
      expect(mocks.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          repositories: expect.arrayContaining(["github:acme/gone", "github:acme/api"]),
        }),
        "repo_routing_ambiguous",
      );
    });

    it("asks when the disagreeing owner has no usable repository left at all", async () => {
      // Owners are enumerated from the whole catalog, unusable entries included. A
      // veto that vanished the moment the repository it names became unclonable would
      // be a veto that disappears exactly when it matters most.
      mocks.listRepositories.mockResolvedValue([
        { ...repos[0]!, repoPath: "acme/dead", defaultBranch: "" },
        { ...repos[1]!, repoPath: "other/api" },
        { ...repos[0]!, repoPath: "other/web" },
      ]);
      mocks.getMemoryDocument.mockImplementation(async (_db, subjectKey: string) => {
        if (subjectKey === "org:github:acme") {
          return routingDocument("- checkout -> github:acme/dead (tickets: AIW-1, AIW-7)\n");
        }
        if (subjectKey === "org:github:other") {
          return routingDocument("- billing -> github:other/api (tickets: AIW-2, AIW-8)\n");
        }
        return null;
      });

      const result = await run({
        identifier: "AIW-30",
        title: "Invoices are wrong",
        labels: ["billing", "checkout"],
      });

      expect(mocks.getMemoryDocument.mock.calls.map((call) => call[1])).toEqual([
        "org:github:acme",
        "org:github:other",
      ]);
      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
    });

    it("asks when an entry has only one confirming ticket", async () => {
      // One human answer is an observation, not evidence. This is what stops a
      // generic label such as "bug" from being bound by a single answer and then
      // routing every later ticket that happens to carry it.
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(UNCORROBORATED_DOC));

      const result = await run({
        identifier: "AIW-9",
        title: "Invoices are wrong",
        labels: ["billing"],
      });

      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
      expect(mocks.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ repository: "github:acme/api" }),
        "repo_routing_uncorroborated",
      );
    });

    it("asks for a label bound by a single answer even when it is the only match", async () => {
      // The polluted-label case end to end: one ticket answered "acme/api" while
      // carrying a generic label, and an unrelated later ticket carrying only that
      // label must still be asked.
      mocks.getMemoryDocument.mockResolvedValue(
        routingDocument("- bug -> github:acme/api (tickets: AIW-1)\n"),
      );

      const result = await run({
        identifier: "AIW-40",
        title: "App crashes on launch",
        labels: ["bug"],
      });

      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
    });

    it("keeps tenants under one top-level namespace in separate documents", async () => {
      // Per-owner containment depends on repoOwner being the OWNING NAMESPACE rather
      // than the first path segment. On a self-hosted GitLab one top-level group
      // routinely holds a subgroup per customer, and grouping on the first segment
      // would put both of these in one document with no per-tenant inspection.
      mocks.getConfiguredVcsProviders.mockReturnValue([
        { kind: "gitlab", token: "glpat", host: "https://gitlab.example.com", legacyBaseBranch: "main" },
      ]);
      // Nested namespaces are a GitLab shape; the catalog requires exactly two
      // segments on GitHub.
      mocks.listRepositories.mockResolvedValue([
        { ...repos[0]!, provider: "gitlab", repoPath: "acme/customer-a/web" },
        { ...repos[1]!, provider: "gitlab", repoPath: "acme/customer-b/web" },
      ]);
      mocks.getMemoryDocument.mockImplementation(async (_db, subjectKey: string) =>
        subjectKey === "org:gitlab:acme/customer-a"
          ? routingDocument("- billing -> gitlab:acme/customer-b/web (tickets: AIW-1, AIW-7)\n")
          : null,
      );

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });

      // Two documents, one per tenant, and neither may name the other's repository.
      expect(mocks.getMemoryDocument.mock.calls.map((call) => call[1])).toEqual([
        "org:gitlab:acme/customer-a",
        "org:gitlab:acme/customer-b",
      ]);
      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
    });

    it("ignores an entry naming the same path on the other provider", async () => {
      // The provider half of containment: one owner name on two forges is two
      // owners, so a GitHub document may not route to the GitLab repository of the
      // same path.
      mocks.getConfiguredVcsProviders.mockReturnValue([
        {
          kind: "github",
          auth: { appId: 1, privateKeyBase64: "pem", installationId: 2 },
          host: "https://github.com",
          legacyBaseBranch: "main",
        },
        { kind: "gitlab", token: "glpat", host: "https://gitlab.example.com", legacyBaseBranch: "main" },
      ]);
      mocks.listRepositories.mockResolvedValue([
        ...catalog,
        { ...catalog[1]!, provider: "gitlab", repoPath: "acme/api" },
      ]);
      mocks.getMemoryDocument.mockImplementation(async (_db, subjectKey: string) =>
        subjectKey === "org:github:acme"
          ? routingDocument("- billing -> gitlab:acme/api (tickets: AIW-1, AIW-7)\n")
          : null,
      );

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });

      expect(result.selectedRepositories).toBeUndefined();
      expect(result.repositoryDiscovery).toBeDefined();
    });

    it("bounds the organisation documents one run reads", async () => {
      // The read sits on the critical path before the model or the human is asked,
      // so a catalog spanning many owners must not turn into many round trips. The
      // tail is lost, which costs a question and never a wrong repository.
      mocks.listRepositories.mockResolvedValue(
        Array.from({ length: 8 }, (_, index) => ({
          ...repos[0]!,
          repoPath: `owner${index}/service`,
        })),
      );

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });

      expect(mocks.getMemoryDocument).toHaveBeenCalledTimes(5);
      expect(result.repositoryDiscovery).toBeDefined();
    });

    it("asks when a read fails instead of failing the run", async () => {
      mocks.getMemoryDocument.mockRejectedValue(new Error("neon: connection reset"));

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
      });

      expect(result.status).toBe("continue");
      expect(result.repositoryDiscovery).toBeDefined();
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining("connection reset") }),
        "repo_routing_read_failed",
      );
    });
  });

  describe("writing", () => {
    function storedContent(): string {
      return mocks.upsertMemoryDocument.mock.calls.at(-1)?.[1]?.content ?? "";
    }

    it("remembers each label against the repository the human named", async () => {
      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing", "Area: Invoices"],
        comments: answer("acme/api"),
      }, undefined, resolvesRepositories("acme/api"));

      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({
          repoPath: "acme/api",
          selectedRationale: "ticket mentions repository path",
        }),
      ]);
      expect(mocks.upsertMemoryDocument).toHaveBeenCalledWith(
        { db: true },
        expect.objectContaining({
          subjectKey: "org:github:acme",
          docPath: "routing",
          ticketKey: null,
          sourceRunId: "presandbox:blazebot/aiw-45",
          expectedVersion: 0,
        }),
      );
      expect(storedContent()).toContain("- billing -> github:acme/api");
      expect(storedContent()).toContain("- Area: Invoices -> github:acme/api");
    });

    it("merges onto the stored document at the version it read", async () => {
      mocks.getMemoryDocument.mockResolvedValue(
        routingDocument("- storefront -> github:acme/web\n", 7),
      );

      await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
        comments: answer("acme/api"),
      }, undefined, resolvesRepositories("acme/api"));

      expect(mocks.upsertMemoryDocument).toHaveBeenCalledWith(
        { db: true },
        expect.objectContaining({ expectedVersion: 7 }),
      );
      expect(storedContent()).toContain("- storefront -> github:acme/web");
      expect(storedContent()).toContain("- billing -> github:acme/api");
    });

    it("retries a lost compare-and-swap against the fresh document", async () => {
      mocks.getMemoryDocument
        .mockResolvedValueOnce(routingDocument("- storefront -> github:acme/web\n", 7))
        .mockResolvedValueOnce(routingDocument("- docs -> github:acme/monorepo\n", 8));
      mocks.upsertMemoryDocument
        .mockResolvedValueOnce({ applied: false, version: null })
        .mockResolvedValueOnce({ applied: true, version: 9 });

      await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
        comments: answer("acme/api"),
      }, undefined, resolvesRepositories("acme/api"));

      expect(mocks.upsertMemoryDocument).toHaveBeenCalledTimes(2);
      expect(mocks.upsertMemoryDocument.mock.calls[1]?.[1]).toMatchObject({ expectedVersion: 8 });
      // Re-merged onto what the winner stored, so the winner's entry survives.
      expect(storedContent()).toContain("- docs -> github:acme/monorepo");
      expect(storedContent()).not.toContain("acme/web");
    });

    it("gives up after the bounded compare-and-swap rounds", async () => {
      mocks.getMemoryDocument.mockResolvedValue(routingDocument("- storefront -> github:acme/web\n"));
      mocks.upsertMemoryDocument.mockResolvedValue({ applied: false, version: null });

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
        comments: answer("acme/api"),
      }, undefined, resolvesRepositories("acme/api"));

      expect(result.status).toBe("continue");
      expect(mocks.upsertMemoryDocument).toHaveBeenCalledTimes(3);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ attempts: 3 }),
        "repo_routing_write_contended",
      );
    });

    it("writes nothing when the entry is already stored", async () => {
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));

      await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
        comments: answer("acme/api"),
      }, undefined, resolvesRepositories("acme/api"));

      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
    });

    it("caps the labels written in one run and evicts the oldest entries", async () => {
      const existing = Array.from(
        { length: 50 },
        (_, index) => `- old-${index} -> github:acme/web\n`,
      ).join("");
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(existing));

      await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["l1", "l2", "l3", "l4", "l5", "l6", "l7"],
        comments: answer("acme/api"),
      }, undefined, resolvesRepositories("acme/api"));

      const bullets = storedContent()
        .split("\n")
        .filter((line) => line.startsWith("- "));
      expect(bullets).toHaveLength(50);
      // Five labels this run, oldest five stored entries evicted, and the eviction
      // is deterministic: it always takes the head of the list.
      expect(bullets.filter((line) => line.includes("-> github:acme/api"))).toEqual([
        "- l1 -> github:acme/api (tickets: AIW-1)",
        "- l2 -> github:acme/api (tickets: AIW-1)",
        "- l3 -> github:acme/api (tickets: AIW-1)",
        "- l4 -> github:acme/api (tickets: AIW-1)",
        "- l5 -> github:acme/api (tickets: AIW-1)",
      ]);
      expect(bullets[0]).toBe("- old-5 -> github:acme/web");
      expect(storedContent()).not.toContain("- old-4 ");
      expect(storedContent()).not.toContain("- l6 ");
    });

    it("scrubs a configured secret out of a label before storing it", async () => {
      // Everything reaching the store goes through prepareMemoryContent first, so a
      // label that happens to quote a configured secret cannot persist it.
      const original = process.env.ROUTING_TEST_SECRET_TOKEN;
      process.env.ROUTING_TEST_SECRET_TOKEN = "sk-live-abc123";
      try {
        await run({
          identifier: "AIW-1",
          title: "Invoices are wrong",
          labels: ["leak sk-live-abc123"],
          comments: answer("acme/api"),
        }, undefined, resolvesRepositories("acme/api"));
        expect(mocks.upsertMemoryDocument).toHaveBeenCalled();
        expect(storedContent()).not.toContain("sk-live-abc123");
        expect(storedContent()).toContain("-> github:acme/api");
      } finally {
        if (original === undefined) delete process.env.ROUTING_TEST_SECRET_TOKEN;
        else process.env.ROUTING_TEST_SECRET_TOKEN = original;
      }
    });

    it("does not write when only the comment sentinel is present", async () => {
      // The display name on a tracker comment is user controlled, so matching on it
      // authenticates nothing. Without the structural field, which prepare-workspace
      // sets only when the block that raised the clarification owns repository
      // selection, this reply is not testimony.
      await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
        comments: answer("acme/api"),
      });

      expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not write when the clarification resolved something other than repositories", async () => {
      // A reply to a different question that happens to quote a path.
      await run(
        {
          identifier: "AIW-1",
          title: "Invoices are wrong",
          labels: ["billing"],
          comments: answer("copy the config from acme/api"),
        },
        undefined,
        { answer: "copy the config from acme/api", resolves: "cache_backend" },
      );

      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not write when the ticket cannot be identified", async () => {
      // Corroboration counts distinct tickets, so an unidentifiable ticket would
      // either never corroborate or corroborate itself.
      await run(
        { title: "Invoices are wrong", labels: ["billing"], comments: answer("acme/api") },
        undefined,
        resolvesRepositories("acme/api"),
      );

      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
      // A clean skip, not a swallowed crash: both write nothing, and only one of
      // them is the behaviour this refusal is supposed to have.
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it("does not write when the ticket identifier is not a tracker key", async () => {
      await run(
        {
          identifier: "AIW 1 (urgent)",
          title: "Invoices are wrong",
          labels: ["billing"],
          comments: answer("acme/api"),
        },
        undefined,
        resolvesRepositories("acme/api"),
      );

      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
      expect(mocks.logger.warn).not.toHaveBeenCalled();
    });

    it("stores the answering ticket, and a second ticket lifts the entry to eligible", async () => {
      // The whole corroboration cycle end to end. First ticket writes an entry that
      // cannot select; a second, distinct ticket agreeing makes it eligible; the
      // third run reads it back and resolves without asking.
      await run(
        {
          identifier: "AIW-1",
          title: "Invoices are wrong",
          labels: ["billing"],
          comments: answer("acme/api"),
        },
        undefined,
        resolvesRepositories("acme/api"),
      );
      const first = storedContent();
      expect(first).toContain("- billing -> github:acme/api (tickets: AIW-1)");

      mocks.getMemoryDocument.mockResolvedValue({
        content: first,
        bytes: first.length,
        updatedAt: new Date("2026-07-29T00:00:00.000Z"),
        sourceRunId: "presandbox:blazebot/aiw-1",
        version: 1,
      });
      await run(
        {
          identifier: "AIW-7",
          title: "Invoices are still wrong",
          labels: ["billing"],
          comments: answer("acme/api"),
        },
        undefined,
        resolvesRepositories("acme/api"),
      );
      const second = storedContent();
      expect(second).toContain("- billing -> github:acme/api (tickets: AIW-1, AIW-7)");

      mocks.getMemoryDocument.mockResolvedValue({
        content: second,
        bytes: second.length,
        updatedAt: new Date("2026-07-29T00:00:00.000Z"),
        sourceRunId: "presandbox:blazebot/aiw-7",
        version: 2,
      });
      const resolved = await run({
        identifier: "AIW-9",
        title: "Invoices are wrong again",
        labels: ["billing"],
      });
      expect(resolved.selectedRepositories).toEqual([
        expect.objectContaining({
          repoPath: "acme/api",
          selectedRationale: "remembered from a human answer for a matching ticket label",
        }),
      ]);
    });

    it("does not let one ticket corroborate its own entry across rounds", async () => {
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(UNCORROBORATED_DOC, 1));

      await run(
        {
          identifier: "AIW-1",
          title: "Invoices are wrong",
          labels: ["billing"],
          comments: answer("acme/api"),
        },
        undefined,
        resolvesRepositories("acme/api"),
      );

      // Nothing changed, so nothing was written, and the entry is still one ticket.
      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not write when there is no human clarification reply", async () => {
      await run({
        identifier: "AIW-1",
        title: "Invoices are wrong in acme/api",
        labels: ["billing"],
        comments: [{ author: "Jane", body: "acme/api is the one" }],
      });

      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
      expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not write when the reply names no repository in the selection", async () => {
      await run({
        identifier: "AIW-1",
        title: "Invoices are wrong in acme/api",
        labels: ["billing"],
        comments: answer("use Redis for the cache"),
      }, undefined, resolvesRepositories("use Redis for the cache"));

      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not write a repository the human did not choose", async () => {
      // The pin decided this, not the reply, even though the reply names it.
      const result = await run(
        {
          identifier: "AIW-1",
          title: "Invoices are wrong",
          labels: ["billing"],
          comments: answer("acme/api"),
        },
        { repositories: [{ provider: "github", repoPath: "acme/api" }] },
        resolvesRepositories("acme/api"),
      );

      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({ selectedRationale: "pinned to this workflow" }),
      ]);
      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not write when the reply names two repositories", async () => {
      // One label mapping to two repositories is not a routing answer, so it is
      // never stored rather than stored ambiguously.
      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
        comments: answer("acme/api and acme/web"),
      }, undefined, resolvesRepositories("acme/api and acme/web"));

      expect(result.selectedRepositories).toHaveLength(2);
      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not write for a ticket with no labels", async () => {
      await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: [],
        comments: answer("acme/api"),
      }, undefined, resolvesRepositories("acme/api"));

      expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
    });

    it("does not fail the run when the write throws", async () => {
      mocks.upsertMemoryDocument.mockRejectedValue(new Error("neon: statement timeout"));

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
        comments: answer("acme/api"),
      }, undefined, resolvesRepositories("acme/api"));

      expect(result.status).toBe("continue");
      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({ repoPath: "acme/api" }),
      ]);
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining("statement timeout") }),
        "repo_routing_write_failed",
      );
    });

    it("does not fail the run when the read before the write throws", async () => {
      mocks.getMemoryDocument.mockRejectedValue(new Error("neon: connection reset"));

      const result = await run({
        identifier: "AIW-1",
        title: "Invoices are wrong",
        labels: ["billing"],
        comments: answer("acme/api"),
      }, undefined, resolvesRepositories("acme/api"));

      expect(result.status).toBe("continue");
      expect(result.selectedRepositories).toEqual([
        expect.objectContaining({ repoPath: "acme/api" }),
      ]);
    });
  });

  describe("with the kill switch off", () => {
    /** Every branch of the step, so the flag-off comparison below covers the whole
     *  surface rather than one path. */
    const scenarios: Array<{
      name: string;
      ticket: Record<string, unknown> & { comments?: unknown };
      scope?: Record<string, unknown>;
    }> = [
      {
        name: "discovery fallback",
        ticket: { identifier: "AIW-1", title: "Invoices are wrong", labels: ["billing"] },
      },
      {
        name: "ticket text match plus a human reply",
        ticket: {
          identifier: "AIW-1",
          title: "Invoices are wrong",
          labels: ["billing"],
          comments: [{ author: "Human clarification", body: "acme/api" }],
        },
      },
      {
        name: "definition pin",
        ticket: { identifier: "AIW-1", title: "Invoices are wrong", labels: ["billing"] },
        scope: { repositories: [{ provider: "github", repoPath: "acme/web" }] },
      },
      {
        name: "pin the listing cannot satisfy",
        ticket: { identifier: "AIW-1", title: "Invoices are wrong", labels: ["billing"] },
        scope: { repositories: [{ provider: "github", repoPath: "acme/gone" }] },
      },
    ];

    /** Both switches have to be on. ENABLE_REPO_ROUTING_MEMORY exists because a
     *  routing document is org scoped, which on a forge where one top-level namespace
     *  holds several tenants is a tenancy decision an operator makes on its own. */
    const switchStates: Array<[string, boolean, boolean]> = [
      ["both off", false, false],
      ["only the feature switch on", true, false],
      ["only the routing switch on", false, true],
    ];

    it.each(switchStates)(
      "touches no memory with %s",
      async (_name, repoMemory, routingMemory) => {
        mocks.env.ENABLE_REPO_MEMORY = repoMemory;
        mocks.env.ENABLE_REPO_ROUTING_MEMORY = routingMemory;
        mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));

        for (const { ticket, scope } of scenarios) {
          await run(
            ticket,
            scope,
            ticket.comments ? resolvesRepositories("acme/api") : undefined,
          );
        }

        expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
        expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
      },
    );

    it.each(scenarios)("touches no memory on the $name branch", async ({ ticket, scope }) => {
      mocks.env.ENABLE_REPO_MEMORY = false;
      mocks.env.ENABLE_REPO_ROUTING_MEMORY = false;
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));

      await run(ticket, scope, ticket.comments ? resolvesRepositories("acme/api") : undefined);

      expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
      expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
    });

    it("produces the same result as it does with a stored document present", async () => {
      // A stored entry that WOULD resolve the discovery fallback, proving the flags
      // and not the absence of data are what keep the output unchanged.
      const ticket = { identifier: "AIW-1", title: "Invoices are wrong", labels: ["billing"] };

      mocks.env.ENABLE_REPO_MEMORY = false;
      mocks.env.ENABLE_REPO_ROUTING_MEMORY = false;
      mocks.getMemoryDocument.mockResolvedValue(routingDocument(ROUTING_DOC));
      const off = await run(ticket);

      mocks.env.ENABLE_REPO_MEMORY = true;
      mocks.env.ENABLE_REPO_ROUTING_MEMORY = true;
      const on = await run(ticket);

      expect(off.selectedRepositories).toBeUndefined();
      expect(on.selectedRepositories).toEqual([expect.objectContaining({ repoPath: "acme/api" })]);
    });
  });
});
