import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("../../infra/vcs-config.js", () => ({
  env: state.env,
  getConfiguredVcsProviders: () => [],
  getVcsProviderConfig: () => {
    throw new Error("not configured");
  },
}));

import {
  issueTrackerBaseUrl,
  providerWebhookSecret,
  ticketBoardSettings,
} from "./integration-settings.js";

beforeEach(() => {
  for (const key of Object.keys(state.env)) delete state.env[key];
});

describe("integration settings", () => {
  it("reads the environment on every call, not once at import", () => {
    // The worker's tests replace the environment per case. A module-level
    // snapshot would freeze whatever the first test happened to set, and the
    // failure would look like a test ordering problem rather than a settings bug.
    state.env.JIRA_BASE_URL = "https://one.example";
    expect(issueTrackerBaseUrl()).toBe("https://one.example");

    state.env.JIRA_BASE_URL = "https://two.example";
    expect(issueTrackerBaseUrl()).toBe("https://two.example");
  });

  it("carries the backlog transition only where one is configured", async () => {
    const { testSettingsSnapshot } = await import("../../test-support/settings.js");
    const snapshot = testSettingsSnapshot({ COLUMN_BACKLOG: "Backlog" });
    expect(ticketBoardSettings(snapshot).backlogTransitionId).toBeUndefined();

    state.env.JIRA_BACKLOG_TRANSITION_ID = "31";
    expect(ticketBoardSettings(snapshot).backlogTransitionId).toBe("31");
  });

  it("answers with the secret belonging to the provider asked about", () => {
    state.env.GITHUB_WEBHOOK_SECRET = "gh";
    state.env.GITLAB_WEBHOOK_SECRET = "gl";

    expect(providerWebhookSecret("github")).toBe("gh");
    expect(providerWebhookSecret("gitlab")).toBe("gl");
    // Unset is undefined and never the empty string: a health observation scoped
    // to "" would match every deployment that configured nothing.
    expect(providerWebhookSecret("jira")).toBeUndefined();
  });
});
