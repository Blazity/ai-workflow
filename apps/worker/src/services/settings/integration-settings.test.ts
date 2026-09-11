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
  providerWebhookSecret,
  slackAllowedUserIds,
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
    state.env.SLACK_ALLOWED_USER_IDS = "U1";
    expect(slackAllowedUserIds()).toEqual(["U1"]);

    state.env.SLACK_ALLOWED_USER_IDS = "U2";
    expect(slackAllowedUserIds()).toEqual(["U2"]);
  });

  it("treats a Slack allowlist of only separators as no allowlist", () => {
    // An empty list means the allowlist is not in force. A value of " , , "
    // is somebody clearing the variable badly, and reading it as "nobody is
    // allowed" would lock the whole workspace out of the slash command.
    state.env.SLACK_ALLOWED_USER_IDS = " , , ";
    expect(slackAllowedUserIds()).toEqual([]);

    state.env.SLACK_ALLOWED_USER_IDS = " U1 ,U2, ";
    expect(slackAllowedUserIds()).toEqual(["U1", "U2"]);
  });

  it("carries the backlog transition only where one is configured", () => {
    state.env.COLUMN_BACKLOG = "Backlog";
    expect(ticketBoardSettings().backlogTransitionId).toBeUndefined();

    state.env.JIRA_BACKLOG_TRANSITION_ID = "31";
    expect(ticketBoardSettings().backlogTransitionId).toBe("31");
  });

  it("answers with the secret belonging to the provider asked about", () => {
    state.env.GITHUB_WEBHOOK_SECRET = "gh";
    state.env.SLACK_SIGNING_SECRET = "sl";

    expect(providerWebhookSecret("github")).toBe("gh");
    expect(providerWebhookSecret("slack")).toBe("sl");
    // Unset is undefined and never the empty string: a health observation scoped
    // to "" would match every deployment that configured nothing.
    expect(providerWebhookSecret("jira")).toBeUndefined();
  });
});
