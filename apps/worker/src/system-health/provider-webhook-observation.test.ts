import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  record: vi.fn<() => Promise<void>>(),
  waitUntil: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: state.waitUntil }));
vi.mock("../../env.js", () => ({
  env: {
    GITHUB_WEBHOOK_SECRET: "github-secret",
    GITLAB_WEBHOOK_SECRET: "gitlab-secret",
    JIRA_WEBHOOK_SECRET: "jira-secret",
    SLACK_SIGNING_SECRET: "slack-secret",
    RESEND_WEBHOOK_SECRET: "resend-secret",
  },
}));
vi.mock("./observations.js", () => ({
  recordSystemHealthObservation: state.record,
  systemHealthObservationScope: (secret: string | undefined) =>
    `scope:${secret ?? "unconfigured"}`,
}));
vi.mock("../db/client.js", () => ({ getDb: () => ({}) }));

const { observeProviderWebhook } = await import("./provider-webhook-observation.js");

describe("provider webhook health observations", () => {
  beforeEach(() => {
    state.record.mockReset().mockResolvedValue();
    state.waitUntil.mockReset();
  });

  it("defers the database write outside the webhook response path", () => {
    expect(
      observeProviderWebhook("github", "accepted", "deferred-test"),
    ).toBeUndefined();
    expect(state.record).toHaveBeenCalledOnce();
    expect(state.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "scope:github-secret" }),
    );
    expect(state.waitUntil).toHaveBeenCalledOnce();
  });

  it("samples repeated unauthenticated failures instead of amplifying writes", () => {
    observeProviderWebhook("gitlab", "rejected", "throttle-test");
    observeProviderWebhook("gitlab", "rejected", "throttle-test");

    expect(state.record).toHaveBeenCalledOnce();
    expect(state.waitUntil).toHaveBeenCalledOnce();
  });

  it("never changes the provider response when persistence is unavailable", () => {
    state.record.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });

    expect(() =>
      observeProviderWebhook("slack", "rejected", "failure-test"),
    ).not.toThrow();
    expect(state.waitUntil).not.toHaveBeenCalled();
  });
});
