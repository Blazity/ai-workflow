import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createVCS: vi.fn(() => ({ kind: "default-vcs" })),
  createRepositoryVCS: vi.fn(() => ({ kind: "repo-vcs" })),
}));

vi.mock("../../env.js", () => ({
  env: {
    JIRA_BASE_URL: "https://jira.example.com",
    JIRA_API_TOKEN: "jira-token",
    JIRA_PROJECT_KEY: "AIW",
    CHAT_SDK_BOT_NAME: "ai-workflow",
  },
}));

vi.mock("../db/client.js", () => ({
  getDb: vi.fn(() => "db"),
}));

vi.mock("../adapters/issue-tracker/jira.js", () => ({
  JiraAdapter: vi.fn().mockImplementation((config) => ({ kind: "jira", config })),
}));

vi.mock("../adapters/messaging/chatsdk.js", () => ({
  ChatSDKAdapter: vi.fn(),
}));

vi.mock("../adapters/messaging/noop.js", () => ({
  NoopMessagingAdapter: vi.fn().mockImplementation(() => ({ kind: "noop" })),
}));

vi.mock("../adapters/run-registry/postgres.js", () => ({
  PostgresRunRegistry: vi.fn().mockImplementation((db) => ({ kind: "registry", db })),
}));

vi.mock("./create-vcs.js", () => ({
  createVCS: mocks.createVCS,
}));

vi.mock("./vcs-runtime.js", () => ({
  createRepositoryVCS: mocks.createRepositoryVCS,
}));

import { createAdapters } from "./adapters.js";

describe("createAdapters", () => {
  it("memoizes the legacy VCS adapter per adapters instance", () => {
    const adapters = createAdapters();

    expect(adapters.vcs).toBe(adapters.vcs);
    expect(mocks.createVCS).toHaveBeenCalledTimes(1);
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
