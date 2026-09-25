/**
 * CHARACTERIZATION: the path repository selection takes with routing memory
 * off, which is production's state and the only path left once stage 10
 * removes routing memory. Stage 10's definition of done is that these tests
 * pass unchanged.
 *
 * Deliberately written without naming the routing switch or the routing
 * module: the settings are the registry's defaults (routing memory off) with
 * repository memory switched on, so this file still compiles and still means
 * the same thing after the switch and the module are deleted. What it observes
 * about memory is the store's own read and write entry points, which outlive
 * routing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryMetadata } from "../../../adapters/vcs/repository-directory.js";

const mocks = vi.hoisted(() => ({
  listRepositories: vi.fn(),
  getDb: vi.fn(),
  listWorkflowOwnedBranchesForTicket: vi.fn(),
  getMemoryDocument: vi.fn(),
  upsertMemoryDocument: vi.fn(),
}));

vi.mock("../../support/vcs-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../support/vcs-runtime.js")>()),
  listVcsRepositories: async () => ({ repositories: await mocks.listRepositories(), failures: [] }),
}));
vi.mock("../../../infra/vcs-config.js", () => ({ env: {} }));
vi.mock("../../../services/integrations/runtime.js", () => ({
  resolveUsableIntegrations: vi.fn(async () => ({ readable: true, usable: [], states: new Map() })),
  checkIntegrationPin: vi.fn(() => ({ ok: true })),
  knownSecretValues: async () => [],
}));
vi.mock("../../../db/client.js", () => ({ getDb: mocks.getDb }));
vi.mock("../../../db/repositories/runs.js", () => ({
  listWorkflowOwnedBranchesForTicket: mocks.listWorkflowOwnedBranchesForTicket,
  listConnectedWorkflowOwnedBranchesForTicket: (ticketKey: string) =>
    mocks.listWorkflowOwnedBranchesForTicket(mocks.getDb(), ticketKey),
}));
vi.mock("../../../db/repositories/repository-catalog.js", () => ({
  listConnectedRepositoryRules: async () => [],
  listConnectedRepositoryCatalogMapRows: async () => [],
}));
// Every memory document read or write this step could make goes through here.
vi.mock("../../../db/repositories/memory.js", () => ({
  getConnectedMemoryDocument: (subjectKey: string, docPath: string) =>
    mocks.getMemoryDocument(subjectKey, docPath),
  upsertConnectedMemoryDocument: (input: unknown) => mocks.upsertMemoryDocument(input),
}));
vi.mock("../../../memory/store.js", () => ({
  getMemoryDocument: (_db: unknown, subjectKey: string, docPath: string) =>
    mocks.getMemoryDocument(subjectKey, docPath),
  upsertMemoryDocument: (_db: unknown, input: unknown) => mocks.upsertMemoryDocument(input),
}));
vi.mock("../../../infra/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { TEST_BRIDGE_REPOSITORY_ACCESS, testSettingsSnapshot } from "../../../test-support/settings.js";
import { repoSelectionStep } from "./repo-selection.js";

function repository(repoPath: string, description: string): RepositoryMetadata {
  const [owner, name] = repoPath.split("/");
  return {
    provider: "github",
    repoPath,
    name: name!,
    owner: owner!,
    defaultBranch: "main",
    description,
    webUrl: `https://github.com/${repoPath}`,
    topics: [],
    archived: false,
    private: true,
  };
}

/** Nothing in "Invoices are wrong" names one of these, so selection cannot decide. */
const CATALOG = [
  repository("acme/web", "Next.js storefront"),
  repository("acme/api", "Billing API and webhook handlers"),
  repository("acme/monorepo", "Shared packages"),
];

/**
 * A routing document an earlier deployment could have left, corroborated by
 * two tickets. With routing memory on it would pick acme/api for any ticket
 * labelled "billing"; with it off nothing may read it.
 */
const LEFTOVER_ROUTING = {
  content:
    "# Repo routing: acme\n<!-- blazebot:repo-routing v1 -->\n\n- billing -> github:acme/api (tickets: AIW-1, AIW-7)\n",
  bytes: 120,
  updatedAt: new Date("2026-07-29T00:00:00.000Z"),
  sourceRunId: "presandbox:ai/aiw-1",
  version: 3,
};

function select(
  ticket: Record<string, unknown>,
  options: { repoMemory?: boolean; clarification?: Record<string, unknown> } = {},
) {
  return repoSelectionStep({
    context: {
      repositoryAccess: TEST_BRIDGE_REPOSITORY_ACCESS,
      // Registry defaults, repository memory switched on; routing memory stays
      // at its default, off.
      settings: testSettingsSnapshot({ ENABLE_REPO_MEMORY: options.repoMemory ?? true }),
      ticket: ticket as never,
      run: { branchName: "ai/aiw-45" },
      ...(options.clarification ? { clarification: options.clarification as never } : {}),
    },
    config: undefined,
    step: { uses: "repo-selection", onFailure: "fail" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDb.mockReturnValue({ db: true });
  mocks.listWorkflowOwnedBranchesForTicket.mockResolvedValue([]);
  mocks.listRepositories.mockResolvedValue(CATALOG);
  mocks.getMemoryDocument.mockResolvedValue(LEFTOVER_ROUTING);
  mocks.upsertMemoryDocument.mockResolvedValue({ applied: true, version: 1 });
});

describe("repository selection with routing memory off (stage 10 keeps this path unchanged)", () => {
  it("sends a labelled ticket that names no repository to discovery over the whole catalog, reading no memory", async () => {
    // Mistake that turns this red: consulting a label-to-repository document
    // (or anything else in memory) before falling back to discovery.
    const result = await select({ identifier: "AIW-45", title: "Invoices are wrong", labels: ["billing"] });

    expect(result.status).toBe("continue");
    expect(result.selectedRepositories).toBeUndefined();
    expect(result.repositoryDiscovery?.mandatoryRepositories).toEqual([]);
    // The whole catalog, sorted by path rather than in listing order.
    expect(result.repositoryDiscovery?.catalog.map((entry) => entry.repoPath)).toEqual([
      "acme/api",
      "acme/monorepo",
      "acme/web",
    ]);
    expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
    expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
  });

  it("takes exactly the same path with repository memory switched off entirely", async () => {
    const ticket = { identifier: "AIW-45", title: "Invoices are wrong", labels: ["billing"] };

    const withMemory = await select(ticket);
    const withoutMemory = await select(ticket, { repoMemory: false });

    expect(withoutMemory).toEqual(withMemory);
  });

  it("selects the repository a ticket names, and remembers nothing about its labels", async () => {
    const result = await select({
      identifier: "AIW-46",
      title: "Change the billing callback in acme/api.",
      labels: ["billing"],
    });

    expect(result.status).toBe("continue");
    expect(result.selectedRepositories?.map((repo) => repo.repoPath)).toEqual(["acme/api"]);
    expect(result.repositoryDiscovery).toBeUndefined();
    expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
    expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
  });

  it("selects the repository a person named in answer to the question, and remembers nothing about the ticket's labels", async () => {
    const result = await select(
      { identifier: "AIW-47", title: "Invoices are wrong", labels: ["billing", "Area: Invoices"], comments: [] },
      { clarification: { answer: "acme/api", resolves: "repository_selection" } },
    );

    expect(result.selectedRepositories).toEqual([
      expect.objectContaining({ repoPath: "acme/api", selectedRationale: "human clarification answer" }),
    ]);
    expect(mocks.getMemoryDocument).not.toHaveBeenCalled();
    expect(mocks.upsertMemoryDocument).not.toHaveBeenCalled();
  });
});
