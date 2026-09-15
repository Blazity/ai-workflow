import { describe, expect, it, vi } from "vitest";
import type {
  HarnessProfileManifest,
  HarnessRunManifestRecord,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import {
  assertCustomProfilePin,
  assertMinimalCanaryWorkflow,
  assertRunHarnessManifest,
  cancelTimedOutCanaryRun,
  parseHarnessCanaryEnv,
} from "../e2e/harness-profiles/canary-contract.js";

const completeEnv = {
  HARNESS_CANARY_BASE_URL: "https://preview.example.test",
  HARNESS_CANARY_EXPECTED_HOST: "preview.example.test",
  ENGINE_CANARY_MCP_CLIENT_ID: "engine-canary-client",
  ENGINE_CANARY_MCP_CLIENT_SECRET: "machine-secret-with-enough-length",
  HARNESS_CANARY_CONFIRM_PREVIEW_MUTATIONS: "run-preview-harness-canary",
  HARNESS_CANARY_CLAUDE_WORKFLOW_ID: "2",
  HARNESS_CANARY_CODEX_WORKFLOW_ID: "3",
  HARNESS_CANARY_CUSTOM_WORKFLOW_ID: "4",
  HARNESS_CANARY_TICKET_KEY: "AIW-999",
  HARNESS_CANARY_CUSTOM_PROFILE_ID: "custom-profile",
  HARNESS_CANARY_CUSTOM_PROFILE_VERSION: "7",
  HARNESS_CANARY_CUSTOM_SKILL_ARTIFACT_HASH: "a".repeat(64),
  HARNESS_CANARY_CUSTOM_SKILL_NAME: "canary-skill",
  HARNESS_CANARY_CUSTOM_SKILL_SOURCE_OWNER: "acme",
  HARNESS_CANARY_CUSTOM_SKILL_SOURCE_REPOSITORY: "skills",
  HARNESS_CANARY_CUSTOM_SKILL_SOURCE_PATH: "canary",
  HARNESS_CANARY_CUSTOM_SKILL_SOURCE_COMMIT_SHA: "b".repeat(40),
  DATABASE_URL: "postgresql://test:test@example.test/test",
  VERCEL_ENV: "preview",
  VERCEL_AUTOMATION_BYPASS_SECRET: "preview-bypass",
  NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED: "0",
};

function workflowDetail(
  reference = { profileId: "builtin-codex", version: 1 },
): {
  id: number;
  enabled: boolean;
  deployedVersion: number;
  definition: WorkflowDefinitionV2;
} {
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
    id: 2,
    enabled: false,
    deployedVersion: 1,
    definition,
  };
}

describe("Harness Profile preview canary dry checks", () => {
  it("fails closed on missing confirmation, wrong host, or enabled authoring", () => {
    expect(parseHarnessCanaryEnv(completeEnv)).toMatchObject({
      ENGINE_CANARY_MCP_CLIENT_ID: "engine-canary-client",
      HARNESS_CANARY_TICKET_KEY: "AIW-999",
      HARNESS_CANARY_TIMEOUT_MS: 900_000,
    });
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
    expect(() =>
      parseHarnessCanaryEnv({
        ...completeEnv,
        ENGINE_CANARY_MCP_CLIENT_ID: undefined,
      }),
    ).toThrow();
    expect(() =>
      parseHarnessCanaryEnv({
        ...completeEnv,
        HARNESS_CANARY_TICKET_KEY: "not-a-ticket",
      }),
    ).toThrow();
  });

  it("accepts only a disabled deployed trigger-to-agent workspace-free workflow", () => {
    const detail = workflowDetail();
    expect(
      assertMinimalCanaryWorkflow(detail, {
        profileId: "builtin-codex",
        version: 1,
      }),
    ).toBe(detail.definition);
    const enabled = workflowDetail();
    enabled.enabled = true;
    expect(() =>
      assertMinimalCanaryWorkflow(enabled, {
        profileId: "builtin-codex",
        version: 1,
      }),
    ).toThrow(/disabled/);
    const unsafe = workflowDetail();
    const unsafeDefinition = unsafe.definition;
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
      id: "custom-profile",
      organizationId: "org-canary",
      system: false,
      archivedAt: null,
      publishedVersion: 7,
      manifest: {
        harness: { provider: "codex" },
        model: { id: "gpt-5.4-mini" },
        skills: [{ artifactHash: "a".repeat(64), name: "canary-skill" }],
      } as HarnessProfileManifest,
    };
    expect(() =>
      assertCustomProfilePin(profile, {
        profileId: "custom-profile",
        version: 7,
        artifactHash: "a".repeat(64),
        skillName: "canary-skill",
      }),
    ).not.toThrow();

    const expensiveProfile = structuredClone(profile);
    expensiveProfile.manifest!.model.id = "gpt-5.4";
    expect(() =>
      assertCustomProfilePin(expensiveProfile, {
        profileId: "custom-profile",
        version: 7,
        artifactHash: "a".repeat(64),
        skillName: "canary-skill",
      }),
    ).toThrow(/gpt-5\.4-mini/);

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

  it("cancels a run when the canary deadline expires", async () => {
    const call = vi.fn().mockResolvedValue({ outcome: "cancelled" });

    await cancelTimedOutCanaryRun({ call } as never, "wrun_timeout");

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("runs.cancel", {
      runId: "wrun_timeout",
      idempotencyKey: expect.any(String),
    });
  });
});
