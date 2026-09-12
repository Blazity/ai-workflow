/**
 * The empty repository (matrix row S07).
 *
 * `suggest.test.ts` proves what a suggestion does with a bundle that HAS
 * something in it: a README to truncate, manifests to take commands from, a
 * provider that fails. The matrix found nothing covering the floor: a
 * repository with no README and no manifests at all. The documented behaviour
 * is that it still produces a proposal, from provider metadata alone, rather
 * than refusing or returning nothing.
 *
 * That matters because the alternative failure is silent. If an empty bundle
 * short-circuited, an operator would see a suggestion that never arrives and no
 * reason why; if it produced a proposal with commands the model invented out of
 * nothing, it would be worse than nothing. So this pins both halves: the call
 * completes, and the prompt says out loud that each source was empty.
 *
 * `vi.mock` is hoisted per file, so the mock block is restated; everything else
 * is imported.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: { ANTHROPIC_API_KEY: "anthropic-key" } as Record<string, string>,
  providers: [] as unknown[],
}));

const mocks = vi.hoisted(() => ({
  generateProviderText: vi.fn(),
  loadProfile: vi.fn(),
  userLabel: vi.fn(async () => "Admin"),
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: state.env,
  getConfiguredVcsProviders: () => state.providers,
  getVcsProviderConfig: () => state.providers[0],
}));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../infra/llm.js", () => ({
  generateProviderText: mocks.generateProviderText,
}));
vi.mock("../../adapters/vcs/create-vcs.js", () => ({
  createVCS: vi.fn(),
  createVCSForRepository: vi.fn(),
  createRepositoryProfileSource: vi.fn(() => ({ loadProfile: mocks.loadProfile })),
}));
vi.mock("../auth/index.js", () => ({
  getConnectedDashboardUserLabel: mocks.userLabel,
}));

const { resetRepositorySuggestionsInFlightForTests, suggestRepositoryProfile } =
  await import("./suggest.js");
const { upsertRepositoryProfile } = await import(
  "../../db/repositories/repository-catalog.js"
);
const { listRepositorySuggestions } = await import(
  "../../db/repositories/repository-suggestions.js"
);

const ADMIN = { role: "admin" as const, id: "user_admin" };

/** A repository with nothing in it. The provider still answers, and what it
 *  answers is metadata and empty lists: this is what the profile source hands
 *  back for a repository somebody created this morning. */
const EMPTY_BUNDLE = {
  provider: "github",
  repoPath: "acme/empty",
  defaultBranch: "main",
  description: "",
  readme: "",
  manifests: [],
  lockfiles: [],
  ciDefinitions: [],
  languages: [],
  truncated: [],
};

let db: Db;
let repositoryId: number;

beforeEach(async () => {
  vi.clearAllMocks();
  resetRepositorySuggestionsInFlightForTests();
  mocks.userLabel.mockResolvedValue("Admin");
  mocks.loadProfile.mockResolvedValue(EMPTY_BUNDLE);
  state.providers = [
    { kind: "github", auth: { appId: 1, privateKeyBase64: "cGVt", installationId: 2 } },
  ];
  db = await createTestDb();
  state.db = db;
  const saved = await upsertRepositoryProfile(db, {
    provider: "github",
    path: "acme/empty",
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: null,
    gateGroups: null,
    actorId: "user_admin",
    actorLabel: "Admin",
    reason: "",
  });
  repositoryId = saved.id;
});

describe("suggestRepositoryProfile against a repository with nothing in it", () => {
  it("S07: still calls the model and returns a proposal, from provider metadata alone", async () => {
    mocks.generateProviderText.mockResolvedValue({
      object: {
        description: "A repository with no code in it yet.",
        rules: "",
        groups: [],
      },
      text: "",
      usage: { inputTokens: 200, outputTokens: 12, cachedTokens: 0 },
    });

    const result = await suggestRepositoryProfile({ actor: ADMIN, repositoryId });

    expect(mocks.generateProviderText).toHaveBeenCalledTimes(1);
    expect(result.proposal).toEqual({
      source: "suggested",
      description: "A repository with no code in it yet.",
      rules: "",
      // No manifests and no CI means nothing to take a command from, and the
      // suggestion offers none rather than inventing one. An empty proposal is
      // still a proposal: the admin gets a description they can accept and an
      // empty Scripts draft, not an error.
      scriptGroups: [],
    });
    expect(result.droppedGroups).toEqual([]);

    // Recorded and billable like any other call: an empty repository is not a
    // free one, and the cost page has to be able to show it.
    const recorded = await listRepositorySuggestions(db, repositoryId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ outcome: "proposed", tokensInput: 200 });
  });

  it("S07: the prompt says each source was empty rather than leaving it out", async () => {
    mocks.generateProviderText.mockResolvedValue({
      object: { description: "Empty.", rules: "", groups: [] },
      text: "",
      usage: null,
    });

    await suggestRepositoryProfile({ actor: ADMIN, repositoryId });

    const prompt = mocks.generateProviderText.mock.calls[0]?.[0].prompt as string;
    // Said out loud, so the model answers "there is nothing here" instead of
    // treating an absent section as one it was not shown.
    expect(prompt).toContain("(none reported)");
    expect(prompt).toContain("(none)");
    // And nothing claims a bound cut anything: an empty bundle is complete.
    expect(prompt).not.toContain("kept ");
  });
});
