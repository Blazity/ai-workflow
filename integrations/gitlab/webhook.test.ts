import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IntegrationContext } from "@integrations/sdk";
import { receiveGitLabWebhook } from "./webhook";
import type { manifest } from "./manifest";

const recorded = {
  mergeRequest: readFileSync(
    new URL("./test-fixtures/merge-request-hook.json", import.meta.url),
    "utf8",
  ),
  pipeline: readFileSync(
    new URL("./test-fixtures/pipeline-hook.json", import.meta.url),
    "utf8",
  ),
  note: readFileSync(
    new URL("./test-fixtures/note-hook.json", import.meta.url),
    "utf8",
  ),
};

function ctx(
  connection: Partial<IntegrationContext<typeof manifest>["connection"]> = {},
): IntegrationContext<typeof manifest> {
  return {
    connection: {
      token: "token",
      host: "https://gitlab.com",
      botLogin: undefined,
      webhookSecret: "secret",
      legacyProjectId: undefined,
      legacyBotLogin: undefined,
      ...connection,
    },
    http: { fetch },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: AbortSignal.timeout(1_000),
  };
}

async function receive(
  eventName: string,
  rawBody: string,
  connection: Partial<IntegrationContext<typeof manifest>["connection"]> = {},
) {
  return receiveGitLabWebhook(
    {
      method: "POST",
      rawBody,
      headers: {
        "x-gitlab-token": "secret",
        "x-gitlab-event": eventName,
        "x-gitlab-event-uuid": "7cdb1d4d-a1c5-4a2a-b35e-4f9a44506fe7",
      },
      query: {},
    },
    ctx(connection),
  );
}

describe("GitLab published webhook payload bytes", () => {
  it("keeps the downloaded examples byte-for-byte intact", () => {
    expect(createHash("sha256").update(recorded.mergeRequest).digest("hex")).toBe(
      "bf574be24690c6a19daf51e51a821607311d49c96c6ab68215d613d570e26baf",
    );
    expect(createHash("sha256").update(recorded.pipeline).digest("hex")).toBe(
      "5c5d889edcc3217581d957b316904db93059312c5fadd536ee31c8ddf6c83308",
    );
    expect(createHash("sha256").update(recorded.note).digest("hex")).toBe(
      "495e40107d5c1af6ee57b8145533b9c8f8fa523139f066faf91902b5015a469a",
    );
  });

  it("normalizes the published merge request delivery from its raw bytes", async () => {
    const result = await receive("Merge Request Hook", recorded.mergeRequest);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events.map((event) => event.triggerType)).toEqual([
      "trigger_pr_ready",
      "trigger_pr_created",
    ]);
    expect(result.legacyGate?.workflowInput.ownerRepo).toBe(
      "flightjs/flight-management",
    );
  });

  it("accepts the published successful pipeline bytes without inventing a failure", async () => {
    const result = await receive("Pipeline Hook", recorded.pipeline);
    expect(result).toMatchObject({
      kind: "trigger_events",
      events: [],
      response: { status: 202, body: { status: "ignored" } },
    });
  });

  it("normalizes the published merge request note from its raw bytes", async () => {
    const result = await receive("Note Hook", recorded.note);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events[0]).toMatchObject({
      triggerType: "trigger_pr_review",
      pr: { review: { state: "commented", body: "This MR needs work." } },
    });
  });

  it("maps a failed variant to an unknown head and the handle the adapter mints", async () => {
    const pipeline = JSON.parse(recorded.pipeline);
    pipeline.object_attributes.status = "failed";
    const result = await receive("Pipeline Hook", JSON.stringify(pipeline));
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    // The pipeline's own sha is the commit it ran on, which on a merged-results
    // pipeline is a temporary merge commit. The handle proves which pipeline
    // this is, and binding adopts the merge request's head from the provider.
    expect(result.events[0]?.pr.headSha).toBe("");
    expect(result.events[0]?.pr.failedChecks?.[0]).toMatchObject({
      handle: { kind: "job", container: 31, id: 378 },
      name: "test-build",
      conclusion: "failed",
    });
  });

  it("refuses the published bytes before parsing when the token is wrong", async () => {
    const result = await receiveGitLabWebhook(
      {
        method: "POST",
        rawBody: recorded.mergeRequest,
        headers: { "x-gitlab-token": "wrong", "x-gitlab-event": "Merge Request Hook" },
        query: {},
      },
      ctx(),
    );
    expect(result).toEqual({ kind: "refused", status: 401, reason: "Invalid webhook token" });
  });
});

/**
 * `GITLAB_PROJECT_ID` still names the one project a deployment that predates
 * the catalog meant, and a group webhook delivers every project in the group.
 * Both the workflow triggers and the legacy post-PR gate stay inside it, as
 * they did before GitLab was an integration (ADR-010, until R1).
 */
describe("a deployment that still names one legacy GitLab project", () => {
  it("skips a merge request from another project, gate included", async () => {
    const result = await receive("Merge Request Hook", recorded.mergeRequest, {
      legacyProjectId: "platform/api",
    });

    expect(result).toEqual({
      kind: "answered",
      response: { status: 202, body: { status: "ignored", reason: "other_project" } },
    });
  });

  it("skips a note from another project before it can start a review run", async () => {
    const result = await receive("Note Hook", recorded.note, { legacyProjectId: "platform/api" });

    expect(result).toMatchObject({ kind: "answered", response: { body: { reason: "other_project" } } });
  });

  it.each([
    ["its full path", "flightjs/flight-management"],
    ["its numeric id", "2"],
  ])("keeps the project it names by %s", async (_label, legacyProjectId) => {
    const result = await receive("Merge Request Hook", recorded.mergeRequest, { legacyProjectId });

    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.legacyGate?.workflowInput.ownerRepo).toBe("flightjs/flight-management");
  });
});
