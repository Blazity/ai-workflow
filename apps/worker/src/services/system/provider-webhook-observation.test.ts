import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  record: vi.fn<() => Promise<void>>(),
  waitUntil: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: state.waitUntil }));
vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    GITHUB_WEBHOOK_SECRET: "github-secret",
    JIRA_WEBHOOK_SECRET: "jira-secret",
    RESEND_WEBHOOK_SECRET: "resend-secret",
  },
}));
vi.mock("./observations.js", () => ({
  recordSystemHealthObservation: state.record,
  systemHealthObservationScope: (secret: string | undefined) =>
    `scope:${secret ?? "unconfigured"}`,
}));
vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));

const { observeProviderWebhook } = await import("./provider-webhook-observation.js");

describe("provider webhook health observations", () => {
  beforeEach(() => {
    state.record.mockReset().mockResolvedValue();
    state.waitUntil.mockReset();
  });

  it("defers the database write outside the webhook response path", () => {
    expect(
      observeProviderWebhook("jira", "accepted", "deferred-test"),
    ).toBeUndefined();
    expect(state.record).toHaveBeenCalledOnce();
    expect(state.record).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "scope:jira-secret" }),
    );
    expect(state.waitUntil).toHaveBeenCalledOnce();
  });

  it("samples repeated unauthenticated failures instead of amplifying writes", () => {
    observeProviderWebhook("email", "rejected", "throttle-test");
    observeProviderWebhook("email", "rejected", "throttle-test");

    expect(state.record).toHaveBeenCalledOnce();
    expect(state.waitUntil).toHaveBeenCalledOnce();
  });

  it("never changes the provider response when persistence is unavailable", () => {
    state.record.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });

    expect(() =>
      observeProviderWebhook("email", "rejected", "failure-test"),
    ).not.toThrow();
    expect(state.waitUntil).not.toHaveBeenCalled();
  });
});
