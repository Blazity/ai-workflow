import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_BRIDGE_REPOSITORY_ACCESS } from "../../test-support/settings.js";

/**
 * What the two expansion steps do when one connected provider does not answer.
 *
 * Both hand their catalog straight to a validator whose only vocabulary for a
 * repository it cannot find is "not on the accessible repository catalog".
 * Neither carries a partial catalog anywhere, so a listing that quietly drops a
 * provider's failure tells a person their repository does not exist when the
 * truth is that we could not see it, and lets the run carry on with half a
 * workspace. The directory these steps read before S11 threw for exactly that
 * reason; this is that contract, kept.
 */
const listVcsRepositories = vi.hoisted(() => vi.fn());

vi.mock("../support/vcs-runtime.js", () => ({ listVcsRepositories }));

const { listFreshRepositoryCatalogStep, resolveHumanRepositoryExpansionStep } =
  await import("./phase.js");

const GITLAB_REPO = {
  provider: "gitlab",
  repoPath: "acme/web",
  name: "web",
  owner: "acme",
  defaultBranch: "main",
  description: "",
  webUrl: "https://gitlab.com/acme/web",
  topics: [],
  archived: false,
  private: true,
};

function listingWithGitHubDown() {
  return {
    repositories: [GITLAB_REPO],
    providers: ["github", "gitlab"],
    failures: [
      {
        provider: "github",
        message: "GitHub repository list failed: 401 Unauthorized",
        error: new Error("GitHub repository list failed: 401 Unauthorized"),
      },
    ],
  };
}

describe("the catalog the expansion steps read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses to build one while a connected provider is unreachable", async () => {
    listVcsRepositories.mockResolvedValue(listingWithGitHubDown());

    await expect(
      listFreshRepositoryCatalogStep(TEST_BRIDGE_REPOSITORY_ACCESS),
    ).rejects.toThrow("GitHub repository list failed: 401 Unauthorized");
  });

  it("refuses the same way when a person's answer is being resolved against it", async () => {
    // The worse of the two: the person just named a repository, and a silent
    // partial catalog answers that the one they named is not available.
    listVcsRepositories.mockResolvedValue(listingWithGitHubDown());

    await expect(
      resolveHumanRepositoryExpansionStep(
        "use github:acme/api",
        [],
        ["Which repository should this work use?"],
        TEST_BRIDGE_REPOSITORY_ACCESS,
      ),
    ).rejects.toThrow("GitHub repository list failed: 401 Unauthorized");
  });

  it("builds the catalog when every provider answered", async () => {
    listVcsRepositories.mockResolvedValue({
      repositories: [GITLAB_REPO],
      providers: ["gitlab"],
      failures: [],
    });

    const catalog = await listFreshRepositoryCatalogStep(TEST_BRIDGE_REPOSITORY_ACCESS);

    expect(catalog.map((entry) => `${entry.provider}:${entry.repoPath}`)).toEqual([
      "gitlab:acme/web",
    ]);
  });
});
