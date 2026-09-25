import { describe, expect, it } from "vitest";
import {
  canonicalSubjectKey,
  orgSubjectKey,
  prSubjectKey,
  repoSubjectKey,
  scheduleSubjectKey,
  ticketSubjectKey,
  webhookSubjectKey,
} from "./subject-key.js";

/**
 * The spelling of every subject key as runs, locks and records store it today.
 * A key is compared as an opaque string everywhere it is stored, so a change to
 * any of these spellings is a data migration, not a refactor.
 */
describe("subject key spellings", () => {
  it("spells a pull request with the repository path cased down, as the catalog key does", () => {
    expect(prSubjectKey("github", "Blazity/ai-workflow", 7)).toBe(
      "pr:github:blazity/ai-workflow#7",
    );
    expect(prSubjectKey("gitlab", "Group/Sub/App", 12)).toBe("pr:gitlab:group/sub/app#12");
  });

  it("gives one pull request reached in two spellings one key", () => {
    // The webhook carries the provider's spelling, a pasted URL the person's.
    expect(prSubjectKey("github", "Blazity/ai-workflow", 7)).toBe(
      prSubjectKey("github", "blazity/ai-workflow", 7),
    );
  });

  it("spells a ticket with the tracker lowercased and the key uppercased", () => {
    expect(ticketSubjectKey(" Jira ", " awp-235 ")).toBe("ticket:jira:AWP-235");
  });

  it("spells a webhook delivery and a schedule occurrence trimmed and otherwise as given", () => {
    expect(webhookSubjectKey(" wh_1 ", " Order-9 ")).toBe("webhook:wh_1:Order-9");
    expect(scheduleSubjectKey(" sch_1 ")).toBe("schedule:sch_1");
    expect(scheduleSubjectKey("sch_1", new Date("2026-09-25T10:00:00.000Z"))).toBe(
      "schedule:sch_1:1790330400000",
    );
  });

  it("spells a repository and an owner with the path exactly as it was given", () => {
    expect(repoSubjectKey("github", "Blazity/ai-workflow")).toBe("repo:github:Blazity/ai-workflow");
    expect(orgSubjectKey("github", "Blazity")).toBe("org:github:Blazity");
  });
});

describe("canonicalSubjectKey", () => {
  it("respells a pull request key stored before the path was cased down", () => {
    expect(canonicalSubjectKey("pr:github:Blazity/ai-workflow#7")).toBe(
      "pr:github:blazity/ai-workflow#7",
    );
    expect(canonicalSubjectKey("pr:gitlab:Group/Sub/App#12")).toBe(
      prSubjectKey("gitlab", "group/sub/app", 12),
    );
  });

  it("answers the builder's own spelling for every spelling of one pull request", () => {
    for (const path of ["Acme/API", "acme/api", "ACME/Api"]) {
      const key = prSubjectKey("github", path, 42);
      expect(canonicalSubjectKey(key)).toBe(key);
      expect(canonicalSubjectKey(`pr:github:${path}#42`)).toBe(key);
    }
  });

  it("respells a ticket key a person typed in another case, as the ticket builder does", () => {
    expect(canonicalSubjectKey("ticket:jira:awp-281")).toBe("ticket:jira:AWP-281");
    expect(canonicalSubjectKey(" ticket:Jira:Awp-281 ")).toBe(ticketSubjectKey("jira", "AWP-281"));
  });

  it("leaves every other kind of key as it is, case included", () => {
    for (const key of [
      "ticket:jira:AWP-235",
      "webhook:wh_1:Order-9",
      "schedule:sch_1:1790330400000",
      "repo:github:Blazity/ai-workflow",
      "org:github:Blazity",
      // No provider separator: not a key this builder ever wrote.
      "pr:Blazity",
    ]) {
      expect(canonicalSubjectKey(key)).toBe(key);
    }
  });
});
