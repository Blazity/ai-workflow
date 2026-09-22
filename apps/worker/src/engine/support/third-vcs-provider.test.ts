import { describe, expect, it, vi } from "vitest";
import type { IntegrationManifest } from "@integrations/sdk";

/**
 * The stage's verdict: a version control provider core has never heard of
 * works, and adding it takes no edit to core.
 *
 * `forgejo` is not GitHub with a different name. It is an id core contains
 * nowhere: not in a union, not in a branch, not in a constant. This file
 * registers it the way a real fourth integration would be registered, a
 * manifest in the registry plus a runtime, and then drives the real core code
 * a repository on it passes through:
 *
 * - the catalog's refusal of an unknown provider before anything is persisted,
 * - the path rules that decide whether `owner/name` is well formed,
 * - the link parser that says which provider a pasted URL belongs to,
 * - the per-repository runtime selection that hands work to an adapter,
 * - the automation account lookup that keeps a run from answering itself.
 *
 * What it deliberately does NOT do is assert that two shipped adapters come
 * back from a registry holding exactly those two. A surviving `if (provider ===
 * "github")` passes that test and fails this one.
 */

const forgejo = {
  id: "forgejo",
  name: "Forgejo",
  description: "A provider this build has never heard of.",
  connection: { fields: [] },
  capabilities: ["vcs"],
  blocks: [],
  pages: [],
  health: [],
  repositories: { host: "code.example.org", nestedPaths: false },
} as unknown as IntegrationManifest;

const shipped = vi.hoisted(() => ({ manifests: [] as unknown[] }));

// The real registry plus one more. Replacing it outright would hide a core
// branch on a shipped id behind a registry that no longer holds it, so what
// this build actually ships stays in the answer.
vi.mock("@integrations/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@integrations/registry")>();
  // Read per call, never captured: registering the provider is the event each
  // case turns on, so an answer frozen at import would make every case agree
  // with whichever one ran first.
  const all = () => [
    ...actual.integrationManifests,
    ...(shipped.manifests as IntegrationManifest[]),
  ];
  return {
    ...actual,
    get integrationManifests() {
      return all();
    },
    integrationManifest: (id: string) => all().find((manifest) => manifest.id === id),
    hasIntegration: (id: string) => all().some((manifest) => manifest.id === id),
    integrationsProviding: ((capability: string) =>
      all().filter((manifest) =>
        (manifest.capabilities as readonly string[]).includes(capability),
      )) as typeof actual.integrationsProviding,
  };
});

/** A second unknown provider, connected at the same time. Without one, "the
 *  repository's provider was chosen" and "the only connected provider was
 *  chosen" are the same sentence, and a resolver that ignored the repository
 *  entirely would pass. */
const gitea = {
  ...(forgejo as unknown as Record<string, unknown>),
  id: "gitea",
  name: "Gitea",
  repositories: { host: "git.example.net", nestedPaths: true },
} as unknown as IntegrationManifest;

/** Which integration's factory ran, and what it was asked for. `chosen` is read
 *  off the closure rather than off the argument: the argument carries the
 *  provider core was ASKED about, so recording that would report the question
 *  back as the answer and a resolver that ignored it would look right. */
const adapterCalls: Array<{ chosen: string; repoPath: string; baseBranch: string }> = [];
const getPRHead = vi.fn(async () => ({ headSha: "sha", baseRef: "main", state: "open" as const }));

/** Connected only while the registry ships it, which is what a deployment is. */
function connected() {
  const ids = new Set((shipped.manifests as IntegrationManifest[]).map((m) => m.id));
  return [usableForgejo, usableGitea].filter((entry) => ids.has(entry.manifest.id));
}

function usable(manifest: IntegrationManifest, botLogin: string) {
  return {
    manifest,
    runtime: {
      capabilities: {
        vcs: (_ctx: unknown, repository: { repoPath: string; baseBranch: string }) => {
          adapterCalls.push({
            chosen: manifest.id,
            repoPath: repository.repoPath,
            baseBranch: repository.baseBranch,
          });
          return { getPRHead };
        },
      },
    },
    ctx: { connection: { botLogin } },
  };
}

const usableForgejo = usable(forgejo, "forgejo-bot");
const usableGitea = usable(gitea, "gitea-bot");

// The connection store, not the thing under test: what a deployment has
// connected lives in the database, and this test is about what core does with
// the answer rather than about reading it.
const integrationStore = {
  resolveUsableIntegrations: async ({
    filter,
  }: { filter?: (manifest: IntegrationManifest) => boolean } = {}) => {
    const usable = connected().filter((entry) => !filter || filter(entry.manifest));
    return {
      readable: true,
      usable,
      states: new Map(
        usable.map((entry) => [
          entry.manifest.id,
          { usable: true, enabled: true, configuredFields: ["botLogin"] },
        ]),
      ),
    };
  },
  usableIntegrations: async () => connected(),
  checkIntegrationPin: () => ({ ok: true }),
};

vi.mock("../../services/integrations/runtime.js", () => integrationStore);
// `vcs-bot-login.ts` reads the store directly rather than through the facade,
// so both entrances are answered by the same fake.
vi.mock("../../services/integrations/usable.js", () => integrationStore);

vi.mock("../../infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// This deployment's own environment says nothing about which provider serves a
// repository, and reading it would only make the test need a database URL.
vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));

const { assertVcsProviderAvailable } = await import(
  "../../services/repository-catalog/provider-validation.js"
);
const { buildRepositoryCatalog } = await import("../repository-discovery/catalog.js");
const { PROVIDER_BY_HOST } = await import("../repository-discovery/runner.js");
const { providerNestsRepositoryPaths } = await import(
  "../repository-discovery/provider-shape.js"
);
const { createRepositoryVcsRuntime } = await import("./vcs-runtime.js");
const { getVcsBotLogin } = await import("../../services/integrations/vcs-bot-login.js");

function repository(repoPath: string) {
  return {
    provider: "forgejo",
    repoPath,
    name: repoPath.split("/").at(-1) ?? "",
    owner: repoPath.split("/")[0] ?? "",
    defaultBranch: "main",
    description: "",
    webUrl: `https://code.example.org/${repoPath}`,
    topics: [],
    archived: false,
    private: false,
  };
}

describe("a version control provider core has never heard of", () => {
  it("is refused before persistence while it is not registered", () => {
    shipped.manifests = [];
    expect(() => assertVcsProviderAvailable("forgejo", "import")).toThrow(/forgejo/u);
  });

  it("is accepted by the catalog the moment its manifest is in the registry", () => {
    shipped.manifests = [forgejo];
    expect(() => assertVcsProviderAvailable("forgejo", "import")).not.toThrow();
    // And an id nobody registered is still refused, so the check above is not
    // passing because the guard stopped guarding.
    expect(() => assertVcsProviderAvailable("subversion", "import")).toThrow(/subversion/u);
  });

  it("carries its repositories through the catalog under its own provider id", () => {
    shipped.manifests = [forgejo];
    const catalog = buildRepositoryCatalog([repository("acme/api")]);
    expect(catalog.map((entry) => `${entry.provider}:${entry.repoPath}`)).toEqual([
      "forgejo:acme/api",
    ]);
  });

  it("applies the path shape it declared rather than one core knows by name", () => {
    shipped.manifests = [forgejo];
    // It declared `nestedPaths: false`, so a nested path is not one of its
    // repositories and the catalog refuses it by name rather than quietly
    // carrying a path that points somewhere else.
    expect(() => buildRepositoryCatalog([repository("acme/team/api")])).toThrow(
      /Invalid forgejo repository path/u,
    );
    expect(providerNestsRepositoryPaths("forgejo")).toBe(false);
    // A provider that declares nothing, which is every future one until it
    // says otherwise, keeps the general rule.
    expect(providerNestsRepositoryPaths("nobody-ships-this")).toBe(true);
  });

  it("claims the links pointing at the host it declared", async () => {
    shipped.manifests = [forgejo];
    // The map is built once at import, so it is read from a fresh module.
    vi.resetModules();
    const runner = await import("../repository-discovery/runner.js");
    expect(runner.PROVIDER_BY_HOST.get("code.example.org")).toBe("forgejo");
    // The shipped providers are still in it: this did not replace them.
    expect(PROVIDER_BY_HOST.size).toBeGreaterThan(0);
  });

  it("is chosen per repository and handed the work, with no branch on its name", async () => {
    shipped.manifests = [forgejo, gitea];
    adapterCalls.length = 0;
    const runtime = createRepositoryVcsRuntime({
      provider: "forgejo",
      repoPath: "acme/api",
      baseBranch: "main",
    });

    await expect(runtime.vcs.getPRHead(7)).resolves.toMatchObject({ headSha: "sha" });

    // The repository's provider and not merely a connected one. The second
    // repository is the half that matters: taking whichever provider answered
    // first would send this one to Forgejo, and the run would open a pull
    // request against the wrong company's server.
    const other = createRepositoryVcsRuntime({
      provider: "gitea",
      repoPath: "acme/ops",
      baseBranch: "trunk",
    });
    await other.vcs.getPRHead(9);

    expect(adapterCalls).toEqual([
      { chosen: "forgejo", repoPath: "acme/api", baseBranch: "main" },
      { chosen: "gitea", repoPath: "acme/ops", baseBranch: "trunk" },
    ]);
    expect(getPRHead).toHaveBeenCalledWith(7);
  });

  it("resolves its automation account, so its own comments cannot start a run", async () => {
    shipped.manifests = [forgejo, gitea];
    await expect(getVcsBotLogin("forgejo")).resolves.toBe("forgejo-bot");
    await expect(getVcsBotLogin("gitea")).resolves.toBe("gitea-bot");
  });

  it("refuses work for a provider that is not registered at all", async () => {
    shipped.manifests = [];
    const runtime = createRepositoryVcsRuntime({
      provider: "forgejo",
      repoPath: "acme/api",
      baseBranch: "main",
    });
    await expect(runtime.vcs.getPRHead(7)).rejects.toThrow(/forgejo/u);
  });
});
