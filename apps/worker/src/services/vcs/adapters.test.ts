import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRepositoryVCS: vi.fn(() => ({ kind: "repo-vcs" })),
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    JIRA_BASE_URL: "https://jira.example.com",
    JIRA_API_TOKEN: "jira-token",
    JIRA_PROJECT_KEY: "AIW",
  },
}));

vi.mock("../../db/repositories/active-runs.js", () => ({
  createConnectedPostgresRunRegistry: vi.fn(() => ({ kind: "registry", db: "db" })),
}));

vi.mock("../../engine/support/vcs-runtime.js", () => ({
  createRepositoryVCS: mocks.createRepositoryVCS,
}));

// This deployment has an issue tracker connected. Which one, and what it is
// wired to, is an integration connection since S12 and is resolved from the
// database; this suite is about what happens to a RUN, so it says the one
// thing it means and leaves the resolution to its own tests.
vi.mock("../../engine/support/issue-tracker-runtime.js", async () => {
  const support = await import("../../test-support/issue-tracker.js");
  return support.connectedIssueTracker({});
});

import { createAdapters } from "./adapters.js";

describe("createAdapters", () => {
  it("refuses a VCS adapter when no repository was named", async () => {
    const adapters = await createAdapters();

    // The legacy single-repository adapter is gone with stage H1: its
    // repository came from the deployment's variables and its base branch from
    // a default in a tier that cannot read the settings registry. Every caller
    // that reads this getter holds a pull request or a repository already, so
    // the ones that never touch it (the issue tracker, messaging and the run
    // registry) keep working and a caller that does gets told what to pass.
    // Reading it is safe, so destructuring and enumeration do not explode;
    // every method refuses with the same sentence.
    expect(() => adapters.vcs.findPR("feature/x")).toThrow(
      "adapters.vcs needs a repository",
    );
    expect(() => adapters.vcs.getBranchSha("main")).toThrow(
      "adapters.vcs needs a repository",
    );
    // And no adapter was built for it: the refusal comes before a provider is
    // ever resolved.
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });

  it("memoizes the selected repository VCS adapter per adapters instance", async () => {
    const adapters = await createAdapters({
      provider: "gitlab",
      repoPath: "group/api",
      baseBranch: "main",
    });

    expect(adapters.vcs).toBe(adapters.vcs);
    expect(mocks.createRepositoryVCS).toHaveBeenCalledTimes(1);
  });
});
