import { describe, expect, it } from "vitest";
import {
  assertOpenSourcePullRequest,
  assertPublishableSourcePullRequest,
  type SourcePullRequestIdentity,
} from "./source-pull-request.js";

const source: SourcePullRequestIdentity = {
  provider: "github",
  repoPath: "acme/api",
  prId: 7,
  headSha: "trigger-head",
  baseRef: "main",
};

describe("assertPublishableSourcePullRequest", () => {
  it("accepts a head that moved after the trigger fired", () => {
    expect(() =>
      assertPublishableSourcePullRequest(source, {
        headSha: "pushed-by-this-run",
        baseRef: "main",
        state: "open",
      }),
    ).not.toThrow();
  });

  it("rejects a retargeted pull request", () => {
    expect(() =>
      assertPublishableSourcePullRequest(source, {
        headSha: "trigger-head",
        baseRef: "develop",
        state: "open",
      }),
    ).toThrow(/stale PR\/MR target/);
  });

  it("rejects a pull request that is no longer open", () => {
    expect(() =>
      assertPublishableSourcePullRequest(source, {
        headSha: "trigger-head",
        baseRef: "main",
        state: "closed",
      }),
    ).toThrow(/is closed/);
  });
});

describe("assertOpenSourcePullRequest", () => {
  it("still rejects a head other than the one it was given", () => {
    expect(() =>
      assertOpenSourcePullRequest(source, {
        headSha: "foreign-head",
        baseRef: "main",
        state: "open",
      }),
    ).toThrow(/stale PR\/MR head/);
  });

  it("accepts the exact head it was given", () => {
    expect(() =>
      assertOpenSourcePullRequest(source, {
        headSha: "trigger-head",
        baseRef: "main",
        state: "open",
      }),
    ).not.toThrow();
  });
});
