import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("../../infra/vcs-config.js", () => ({
  env: state.env,
  getConfiguredVcsProviders: () => [],
  getVcsProviderConfig: () => {
    throw new Error("not configured");
  },
}));

// The tracker half of a board comes from an integration's connection since
// S12, so each case says which deployment it is describing. Which integration
// is chosen, and what happens when two or none are connected, is proved
// against the real resolver in `engine/support/issue-tracker-runtime.test.ts`.
const resolveActiveIssueTracker = vi.hoisted(() => vi.fn());
vi.mock("../../engine/support/issue-tracker-runtime.js", () => ({
  resolveActiveIssueTracker,
  // The real derivation: a board and the reconciler both build this string,
  // and a cache written under one and read under the other has to agree.
  trackerIdentityOf: (id: string, baseUrl: string) =>
    `${id}\u0000${baseUrl.trim().toLowerCase()}`,
}));

function trackerConnected(wiring: Record<string, string>) {
  resolveActiveIssueTracker.mockResolvedValue({
    ok: true,
    id: "jira",
    name: "Jira",
    adapter: {},
    wiring: { projectKey: "PROJ", baseUrl: "", ...wiring },
  });
}

function noTrackerConnected(reason = "No issue tracker is connected on this deployment.") {
  resolveActiveIssueTracker.mockResolvedValue({ ok: false, refusal: "not_connected", reason });
}

import {
  issueTrackerBaseUrl,
  ticketBoardSettings,
} from "./integration-settings.js";

beforeEach(() => {
  for (const key of Object.keys(state.env)) delete state.env[key];
});

describe("integration settings", () => {
  it("follows the connection on every call, not a snapshot taken at import", async () => {
    // An operator can re-point the tracker at another site while the worker is
    // running. A module-level snapshot would keep publishing links to the old
    // one, and the failure would look like a caching problem rather than a
    // settings bug.
    trackerConnected({ baseUrl: "https://one.example" });
    expect(await issueTrackerBaseUrl()).toBe("https://one.example");

    trackerConnected({ baseUrl: "https://two.example" });
    expect(await issueTrackerBaseUrl()).toBe("https://two.example");
  });

  it("publishes no ticket link when no tracker is connected", async () => {
    // Deliberately an empty string rather than a throw: the callers are run
    // lists and run detail, each building a link beside something else it is
    // already showing. A refusal here would take away the page somebody needs
    // in order to see what happened.
    noTrackerConnected();
    expect(await issueTrackerBaseUrl()).toBe("");
  });

  it("carries the backlog transition only where the connection has one", async () => {
    const { testSettingsSnapshot } = await import("../../test-support/settings.js");
    const snapshot = testSettingsSnapshot({ COLUMN_BACKLOG: "Backlog" });

    trackerConnected({});
    expect((await ticketBoardSettings(snapshot)).backlogTransitionId).toBeUndefined();

    trackerConnected({ backlogTransitionId: "31" });
    expect((await ticketBoardSettings(snapshot)).backlogTransitionId).toBe("31");
  });

  it("joins the operator's columns to the connection's project in one place", async () => {
    // The one seam. The columns are operator behaviour and come from stored
    // settings; the project and the tracker's own name are provider wiring and
    // come from the connection. A caller that read either half separately is
    // how a poller comes to dispatch against a column the dashboard renamed.
    const { testSettingsSnapshot } = await import("../../test-support/settings.js");
    const snapshot = testSettingsSnapshot({
      COLUMN_AI: "Ai",
      COLUMN_AI_REVIEW: "Ai review",
      COLUMN_BACKLOG: "Backlog",
    });

    trackerConnected({ projectKey: "AWT" });
    const board = await ticketBoardSettings(snapshot);

    expect(board).toMatchObject({
      trackerName: "Jira",
      projectKey: "AWT",
      aiColumn: "Ai",
      aiReviewColumn: "Ai review",
      backlogColumn: "Backlog",
    });
  });

  it("refuses to describe a board when no tracker is connected", async () => {
    // The opposite answer to the link, and for the opposite reason: every
    // caller of this one is about to decide which tickets to pick up or where
    // to move one. Empty strings here would match no column on any board and
    // the deployment would ignore every ticket in silence.
    const { testSettingsSnapshot } = await import("../../test-support/settings.js");
    noTrackerConnected("No issue tracker is connected on this deployment.");

    await expect(ticketBoardSettings(testSettingsSnapshot({}))).rejects.toThrow(
      "No issue tracker is connected on this deployment.",
    );
  });
});
