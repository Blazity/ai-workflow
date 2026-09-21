import { describe, expect, it } from "vitest";
import { BLOCK_TYPE_SPECS, type WorkflowBlockType } from "@shared/contracts";
import { BLOCK_PARAMS_SCHEMAS } from "./block-params-schemas.js";
import { BLOCK_PARAM_SCHEMAS as MANIFEST_PARAM_SCHEMAS } from "./params.generated.js";

/**
 * The `satisfies` in the map is the compile-time half of this. This is the
 * run-time half: a type added to the catalog without an entry here would parse
 * against nothing, and a definition naming it would deploy unchecked.
 */
describe("block params schemas", () => {
  it("has a parser for every block type in the catalog", () => {
    const catalogTypes = Object.keys(BLOCK_TYPE_SPECS).sort() as WorkflowBlockType[];
    expect(catalogTypes.length).toBeGreaterThan(0);
    expect(Object.keys(BLOCK_PARAMS_SCHEMAS).sort()).toEqual(catalogTypes);
    for (const type of catalogTypes) {
      expect(typeof BLOCK_PARAMS_SCHEMAS[type].safeParse, type).toBe("function");
    }
  });
});

describe("trigger repository policy parameter", () => {
  const POLICY_TRIGGER_TYPES = [
    "trigger_ticket_ai",
    "trigger_pr_created",
    "trigger_pr_ready",
    "trigger_pr_updated",
    "trigger_pr_checks_failed",
    "trigger_pr_review",
    "trigger_pr_merged",
    "trigger_webhook",
    "trigger_schedule",
  ] as const;
  const policy = {
    candidates: { kind: "listed", repositoryKeys: ["github:blazity/ai-workflow-demo"] },
    expansion: "never",
  };

  it("accepts a policy on each of the nine trigger types that start a run", () => {
    for (const type of POLICY_TRIGGER_TYPES) {
      const parsed = BLOCK_PARAMS_SCHEMAS[type].safeParse({ repositoryPolicy: policy });
      expect(parsed.success, type).toBe(true);
      expect(parsed.data?.repositoryPolicy, type).toEqual(policy);
    }
  });

  it("normalises the listed keys the way the catalog spells them", () => {
    const parsed = BLOCK_PARAMS_SCHEMAS.trigger_ticket_ai.safeParse({
      repositoryPolicy: {
        candidates: { kind: "listed", repositoryKeys: [" GitHub:Blazity/AI-Workflow-Demo "] },
        expansion: "attach",
      },
    });
    expect(parsed.data?.repositoryPolicy).toEqual({
      candidates: { kind: "listed", repositoryKeys: ["github:blazity/ai-workflow-demo"] },
      expansion: "attach",
    });
  });

  it("refuses a policy on an approved plan, which carries its own frozen scope", () => {
    expect(
      BLOCK_PARAMS_SCHEMAS.trigger_plan_approved.safeParse({ repositoryPolicy: policy }).success,
    ).toBe(false);
  });

  it("refuses a key inside the policy that the policy does not own", () => {
    expect(
      BLOCK_PARAMS_SCHEMAS.trigger_ticket_ai.safeParse({
        repositoryPolicy: { ...policy, maxRepositories: 3 },
      }).success,
    ).toBe(false);
    expect(
      BLOCK_PARAMS_SCHEMAS.trigger_ticket_ai.safeParse({
        repositoryPolicy: { candidates: { kind: "enabled_catalog", repositoryKeys: [] }, expansion: "attach" },
      }).success,
    ).toBe(false);
  });

  // The canonical JSON of a stored definition feeds its graph hash, so a
  // configuration saved before the policy existed has to come out byte for
  // byte the way it did: no added key, not even an undefined one.
  it("parses a configuration without a policy exactly as before", () => {
    const expected: Record<(typeof POLICY_TRIGGER_TYPES)[number], unknown> = {
      trigger_ticket_ai: {},
      trigger_pr_created: { providers: [], scope: "workflow_owned" },
      trigger_pr_ready: { providers: [], scope: "any" },
      trigger_pr_updated: { providers: [], scope: "any" },
      trigger_pr_checks_failed: {
        providers: [],
        scope: "workflow_owned",
        checkNames: [],
        ignoreCheckNames: [],
        trustedProducers: [],
        maxFixAttemptsPerPr: 2,
      },
      trigger_pr_review: {
        providers: [],
        on: ["changes_requested"],
        scope: "workflow_owned",
        maxRunsPerPr: 10,
      },
      trigger_pr_merged: { providers: [], scope: "workflow_owned" },
      trigger_webhook: {},
      trigger_schedule: {
        cron: "",
        timezone: "UTC",
        overlapPolicy: "skip",
        catchUpGraceMinutes: 60,
        taskTitle: "",
        taskDescription: "",
      },
    };
    for (const type of POLICY_TRIGGER_TYPES) {
      expect(BLOCK_PARAMS_SCHEMAS[type].parse({}), type).toStrictEqual(expected[type]);
    }
    expect(
      BLOCK_PARAMS_SCHEMAS.trigger_ticket_ai.parse({ rateLimitMax: 5, rateLimitWindow: "hour" }),
    ).toStrictEqual({ rateLimitMax: 5, rateLimitWindow: "hour" });
    expect(
      BLOCK_PARAMS_SCHEMAS.trigger_webhook.parse({ subjectPath: "ticket.id", authScheme: "shared_token" }),
    ).toStrictEqual({ subjectPath: "ticket.id", authScheme: "shared_token" });
  });

  it("upgrades stored provider-specific producer filters without operator edits", () => {
    expect(
      BLOCK_PARAMS_SCHEMAS.trigger_pr_checks_failed.parse({
        githubAppSlugs: ["github-actions"],
        gitlabPipelineSources: ["merge_request_event"],
      }),
    ).toMatchObject({
      trustedProducers: ["github-actions", "merge_request_event"],
    });
  });

  it("is declared by the nine trigger manifests and refused by the plan approved one", () => {
    for (const type of POLICY_TRIGGER_TYPES) {
      expect(MANIFEST_PARAM_SCHEMAS[type].safeParse({ repositoryPolicy: policy }).success, type).toBe(true);
    }
    expect(
      MANIFEST_PARAM_SCHEMAS.trigger_plan_approved.safeParse({ repositoryPolicy: policy }).success,
    ).toBe(false);
  });
});
