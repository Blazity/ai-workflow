import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryMetadata } from "../../adapters/vcs/repository-directory.js";

const mocks = vi.hoisted(() => ({
  listRepositories: vi.fn(),
  getConfiguredVcsProviders: vi.fn(),
  getDb: vi.fn(),
  listWorkflowOwnedBranchesForTicket: vi.fn(),
}));

vi.mock("../../adapters/vcs/repository-directory.js", () => ({
  createRepositoryDirectory: vi.fn(() => ({
    listRepositories: mocks.listRepositories,
  })),
  createRepositoryDirectoryForProviders: vi.fn(() => ({
    listRepositories: mocks.listRepositories,
  })),
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

  it("selects repositories by name and description terms", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Fix billing webhook retry behavior",
      repositories: repos,
      workflowOwnedBranches: [],
    });

    expect(selected.status).toBe("selected");
    if (selected.status !== "selected") throw new Error("expected selected");
    expect(selected.repositories.map((r) => r.repoPath)).toEqual(["acme/api"]);
  });

  it("asks clarification when no repository matches", () => {
    const selected = selectRepositoriesFromMetadata({
      ticketText: "Update data warehouse model",
      repositories: repos,
      workflowOwnedBranches: [],
    });

    expect(selected).toEqual({
      status: "clarification_needed",
      questions: ["Which repository should this ticket modify?"],
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
    expect(result.promptAdditions?.[0]?.content).toContain("acme/web");
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
