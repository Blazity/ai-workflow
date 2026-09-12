import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createVCS: vi.fn(() => ({ kind: "default-vcs" })),
  createRepositoryVCS: vi.fn(() => ({ kind: "repo-vcs" })),
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    JIRA_BASE_URL: "https://jira.example.com",
    JIRA_API_TOKEN: "jira-token",
    JIRA_PROJECT_KEY: "AIW",
    CHAT_SDK_BOT_NAME: "ai-workflow",
  },
}));

vi.mock("../../adapters/issue-tracker/jira.js", () => ({
  JiraAdapter: vi.fn().mockImplementation((config) => ({ kind: "jira", config })),
}));

vi.mock("../../adapters/messaging/chatsdk.js", () => ({
  ChatSDKAdapter: vi.fn(),
}));

vi.mock("../../adapters/messaging/noop.js", () => ({
  NoopMessagingAdapter: vi.fn().mockImplementation(() => ({ kind: "noop" })),
}));

vi.mock("../../db/repositories/active-runs.js", () => ({
  createConnectedPostgresRunRegistry: vi.fn(() => ({ kind: "registry", db: "db" })),
}));

vi.mock("../../adapters/vcs/create-vcs.js", () => ({
  createVCS: mocks.createVCS,
}));

vi.mock("../../engine/support/vcs-runtime.js", () => ({
  createRepositoryVCS: mocks.createRepositoryVCS,
}));

import { createAdapters } from "./adapters.js";

describe("createAdapters", () => {
  it("refuses a VCS adapter when no repository was named", () => {
    const adapters = createAdapters();

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
    expect(mocks.createVCS).not.toHaveBeenCalled();
  });

  it("memoizes the selected repository VCS adapter per adapters instance", () => {
    const adapters = createAdapters({
      provider: "gitlab",
      repoPath: "group/api",
      baseBranch: "main",
    });

    expect(adapters.vcs).toBe(adapters.vcs);
    expect(mocks.createRepositoryVCS).toHaveBeenCalledTimes(1);
  });
});
