import { describe, expect, it } from "vitest";
import { carriesWorkScope } from "./subject.js";

describe("carriesWorkScope", () => {
  it("carries a record for a ticket subject", () => {
    expect(
      carriesWorkScope({
        subjectKey: "ticket:jira:AWP-211",
        entryKind: "ticket",
        webhookSubjectResolved: false,
      }),
    ).toBe(true);
  });

  it("carries a record for a pull request subject", () => {
    expect(
      carriesWorkScope({
        subjectKey: "pr:github:acme/api#12",
        entryKind: "pr_trigger",
        webhookSubjectResolved: false,
      }),
    ).toBe(true);
  });

  it("carries a record for a webhook delivery whose subject id resolved", () => {
    expect(
      carriesWorkScope({
        subjectKey: "webhook:endpoint-1:ZD-42",
        entryKind: "webhook_trigger",
        webhookSubjectResolved: true,
      }),
    ).toBe(true);
  });

  it("carries no record for a webhook delivery without a resolved subject id", () => {
    expect(
      carriesWorkScope({
        subjectKey: "webhook:endpoint-1:delivery-9",
        entryKind: "webhook_trigger",
        webhookSubjectResolved: false,
      }),
    ).toBe(false);
  });

  it("carries no record for a schedule occurrence", () => {
    expect(
      carriesWorkScope({
        subjectKey: "schedule:nightly:1757894400000",
        entryKind: "schedule",
        webhookSubjectResolved: false,
      }),
    ).toBe(false);
  });

  it("carries no record for any other subject key", () => {
    expect(
      carriesWorkScope({
        subjectKey: "repo:github:acme/api",
        entryKind: "ticket",
        webhookSubjectResolved: true,
      }),
    ).toBe(false);
  });

  it("carries no record for an approved plan, even on a ticket subject", () => {
    expect(
      carriesWorkScope({
        subjectKey: "ticket:jira:AWP-211",
        entryKind: "plan_approved",
        webhookSubjectResolved: true,
      }),
    ).toBe(false);
  });
});
