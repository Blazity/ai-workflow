import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gateCheckName, gateCheckNameAliases } from "./workflow-naming.js";

/**
 * The names core gives the post-PR gate's own checks, against the rule each VCS
 * integration drops them by. A failed check of ours that became a trigger
 * would have the gate chase its own tail; the two sides used to keep their own
 * copies of the prefixes, and the copies had already started to disagree.
 */
const { normalizeGitHubEvents } = await import("../../../../../integrations/github/webhook.js");
const { normalizeGitLabEvents } = await import("../../../../../integrations/gitlab/webhook.js");

const checkRun = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../integrations/github/test-fixtures/check-run-completed-failure.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

function failedGitHubCheck(name: string) {
  const body = JSON.parse(JSON.stringify(checkRun));
  body.check_run.name = name;
  return normalizeGitHubEvents("check_run", body, { deliveryId: "d" });
}

function failedGitLabJob(name: string) {
  return normalizeGitLabEvents(
    "Pipeline Hook",
    {
      object_kind: "pipeline",
      project: { id: 1, path_with_namespace: "group/demo" },
      object_attributes: { id: 7, status: "failed", source: "merge_request_event" },
      merge_request: { iid: 3, source_branch: "ai-workflow/aiw-3", target_branch: "main" },
      builds: [{ id: 11, name, status: "failed" }],
    },
    { deliveryId: "d" },
  );
}

describe("the gate's own checks never become a trigger", () => {
  const ours = [gateCheckName("code-hygiene"), ...gateCheckNameAliases("code-hygiene")];

  it.each(ours)("GitHub drops %s", (name) => {
    expect(failedGitHubCheck(name)).toEqual([]);
  });

  it.each(ours)("GitLab drops %s", (name) => {
    expect(failedGitLabJob(name)).toEqual([]);
  });

  it("both still report a failure that is not ours", () => {
    expect(failedGitHubCheck("ci / build")).toHaveLength(1);
    expect(failedGitLabJob("build")).toHaveLength(1);
  });
});
