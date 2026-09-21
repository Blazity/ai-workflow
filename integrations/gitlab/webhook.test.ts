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

function ctx(): IntegrationContext<typeof manifest> {
  return {
    connection: {
      token: "token",
      host: "https://gitlab.com",
      botLogin: undefined,
      webhookSecret: "secret",
      legacyProjectId: undefined,
      legacyBotLogin: undefined,
    },
    http: { fetch },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: AbortSignal.timeout(1_000),
  };
}

async function receive(eventName: string, rawBody: string) {
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
    ctx(),
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

  it("maps a failed variant to the exact head and handle returned by the adapter", async () => {
    const pipeline = JSON.parse(recorded.pipeline);
    pipeline.object_attributes.status = "failed";
    const result = await receive("Pipeline Hook", JSON.stringify(pipeline));
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events[0]?.pr.headSha).toBe(
      "bcbb5ec396a2c0f828686f14fac9b80b780504f2",
    );
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
