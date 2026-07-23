import { describe, expect, it } from "vitest";
import type {
  HarnessProfileDetailResponse,
  HarnessRunManifestRecord,
  WorkflowDefinitionDetailResponse,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import {
  assertCustomProfilePin,
  assertMinimalCanaryWorkflow,
  assertRunHarnessManifest,
  parseHarnessCanaryEnv,
} from "../e2e/harness-profiles/canary-contract.js";

const completeEnv = {
  HARNESS_CANARY_BASE_URL: "https://preview.example.test",
  HARNESS_CANARY_EXPECTED_HOST: "preview.example.test",
  HARNESS_CANARY_SESSION_TOKEN: "session-token-with-enough-length",
  HARNESS_CANARY_CONFIRM_PREVIEW_MUTATIONS: "run-preview-harness-canary",
  HARNESS_CANARY_RESTORE_WORKFLOW_ID: "1",
  HARNESS_CANARY_CLAUDE_WORKFLOW_ID: "2",
  HARNESS_CANARY_CODEX_WORKFLOW_ID: "3",
  HARNESS_CANARY_CUSTOM_WORKFLOW_ID: "4",
  HARNESS_CANARY_CUSTOM_PROFILE_ID: "custom-profile",
  HARNESS_CANARY_CUSTOM_PROFILE_VERSION: "7",
  HARNESS_CANARY_CUSTOM_SKILL_ARTIFACT_HASH: "a".repeat(64),
  HARNESS_CANARY_CUSTOM_SKILL_NAME: "canary-skill",
  HARNESS_CANARY_CUSTOM_SKILL_SOURCE_OWNER: "acme",
  HARNESS_CANARY_CUSTOM_SKILL_SOURCE_REPOSITORY: "skills",
  HARNESS_CANARY_CUSTOM_SKILL_SOURCE_PATH: "canary",
  HARNESS_CANARY_CUSTOM_SKILL_SOURCE_COMMIT_SHA: "b".repeat(40),
  JIRA_BASE_URL: "https://jira.example.test",
  JIRA_API_TOKEN: "jira-token",
  JIRA_PROJECT_KEY: "AIW",
  COLUMN_AI: "AI",
  COLUMN_BACKLOG: "Backlog",
  CRON_SECRET: "cron-token",
  DATABASE_URL: "postgresql://test:test@example.test/test",
  VERCEL_ENV: "preview",
  VERCEL_AUTOMATION_BYPASS_SECRET: "preview-bypass",
  NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED: "0",
};

function workflowDetail(
  reference = { profileId: "builtin-codex", version: 1 },
): WorkflowDefinitionDetailResponse {
  const definition: WorkflowDefinitionV2 = {
    schemaVersion: 2,
    nodes: [
      {
        id: "trigger",
        type: "trigger_ticket_ai" as const,
        x: 0,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "agent",
        type: "generic_agent" as const,
        x: 1,
        y: 0,
        configuration: {
          workspaceMode: "none",
          harnessProfile: reference,
          prompt: "Return the canary result.",
        },
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [{ id: "edge", from: "trigger", to: "agent" }],
  };
  return {
    meta: {
      id: 2,
      name: "Canary",
      enabled: false,
      triggerTypes: ["trigger_ticket_ai"],
      currentVersion: 1,
      draftRevision: 1,
      layoutRevision: 0,
      deployedVersion: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    draft: definition,
    layout: { nodes: {}, edges: {} },
    deployed: {
      definitionId: 2,
      version: 1,
      definition,
      createdAt: new Date(0).toISOString(),
      createdById: "user",
      createdByLabel: "User",
      restoredFromVersion: null,
    },
    current: null,
    versions: [],
  };
}

describe("Harness Profile preview canary dry checks", () => {
  it("fails closed on missing confirmation, wrong host, or enabled authoring", () => {
    expect(() =>
      parseHarnessCanaryEnv({
        ...completeEnv,
        HARNESS_CANARY_CONFIRM_PREVIEW_MUTATIONS: undefined,
      }),
    ).toThrow();
    expect(() =>
      parseHarnessCanaryEnv({
        ...completeEnv,
        HARNESS_CANARY_EXPECTED_HOST: "production.example.test",
      }),
    ).toThrow();
    expect(() =>
      parseHarnessCanaryEnv({
        ...completeEnv,
        NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED: "1",
      }),
    ).toThrow();
  });

  it("accepts only a deployed trigger-to-agent workspace-free workflow", () => {
    const detail = workflowDetail();
    expect(
      assertMinimalCanaryWorkflow(detail, {
        profileId: "builtin-codex",
        version: 1,
      }),
    ).toBe(detail.deployed?.definition);
    const unsafe = workflowDetail();
    const unsafeDefinition = unsafe.deployed!
      .definition as WorkflowDefinitionV2;
    (
      unsafeDefinition.nodes[1]!.configuration as Record<
        string,
        unknown
      >
    ).workspaceMode = "read_write";
    expect(() =>
      assertMinimalCanaryWorkflow(unsafe, {
        profileId: "builtin-codex",
        version: 1,
      }),
    ).toThrow(/workspaceMode/);
  });

  it("requires the exact custom profile, skill pin, and run provenance", () => {
    const profile = {
      profile: {
        id: "custom-profile",
        system: false,
        archivedAt: null,
        publishedVersion: 7,
      },
      published: {
        version: 7,
        manifest: {
          skills: [{ artifactHash: "a".repeat(64), name: "canary-skill" }],
        },
      },
    } as HarnessProfileDetailResponse;
    expect(() =>
      assertCustomProfilePin(profile, {
        profileId: "custom-profile",
        version: 7,
        artifactHash: "a".repeat(64),
        skillName: "canary-skill",
      }),
    ).not.toThrow();

    const records = [
      {
        reference: { profileId: "custom-profile", version: 7 },
        manifest: { harness: { provider: "codex" } },
        skills: [
          {
            artifactHash: "a".repeat(64),
            name: "canary-skill",
            source: {
              owner: "acme",
              repository: "skills",
              path: "canary",
              commitSha: "b".repeat(40),
            },
          },
        ],
      },
    ] as HarnessRunManifestRecord[];
    expect(() =>
      assertRunHarnessManifest(records, {
        reference: { profileId: "custom-profile", version: 7 },
        provider: "codex",
        skill: {
          artifactHash: "a".repeat(64),
          name: "canary-skill",
          owner: "acme",
          repository: "skills",
          path: "canary",
          commitSha: "b".repeat(40),
        },
      }),
    ).not.toThrow();
  });
});
