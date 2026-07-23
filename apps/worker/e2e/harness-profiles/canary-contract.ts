import type {
  HarnessProfileDetailResponse,
  HarnessProfileReference,
  HarnessRunManifestRecord,
  WorkflowDefinitionDetailResponse,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);

const schema = z
  .object({
    HARNESS_CANARY_BASE_URL: z.string().url(),
    HARNESS_CANARY_EXPECTED_HOST: z.string().trim().min(1),
    HARNESS_CANARY_SESSION_TOKEN: z.string().min(20),
    HARNESS_CANARY_CONFIRM_PREVIEW_MUTATIONS: z.literal(
      "run-preview-harness-canary",
    ),
    HARNESS_CANARY_RESTORE_WORKFLOW_ID: positiveInteger,
    HARNESS_CANARY_CLAUDE_WORKFLOW_ID: positiveInteger,
    HARNESS_CANARY_CODEX_WORKFLOW_ID: positiveInteger,
    HARNESS_CANARY_CUSTOM_WORKFLOW_ID: positiveInteger,
    HARNESS_CANARY_CUSTOM_PROFILE_ID: z.string().trim().min(1),
    HARNESS_CANARY_CUSTOM_PROFILE_VERSION: positiveInteger,
    HARNESS_CANARY_CUSTOM_SKILL_ARTIFACT_HASH: sha256,
    HARNESS_CANARY_CUSTOM_SKILL_NAME: z.string().trim().min(1),
    HARNESS_CANARY_CUSTOM_SKILL_SOURCE_OWNER: z.string().trim().min(1),
    HARNESS_CANARY_CUSTOM_SKILL_SOURCE_REPOSITORY: z.string().trim().min(1),
    HARNESS_CANARY_CUSTOM_SKILL_SOURCE_PATH: z.string().trim().min(1),
    HARNESS_CANARY_CUSTOM_SKILL_SOURCE_COMMIT_SHA: gitSha,
    JIRA_BASE_URL: z.string().url(),
    JIRA_API_TOKEN: z.string().min(1),
    JIRA_PROJECT_KEY: z.string().trim().min(1),
    COLUMN_AI: z.string().trim().min(1),
    COLUMN_BACKLOG: z.string().trim().min(1),
    CRON_SECRET: z.string().min(1),
    DATABASE_URL: z.string().url(),
    VERCEL_ENV: z.literal("preview"),
    VERCEL_AUTOMATION_BYPASS_SECRET: z.string().min(1),
    NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED: z.union([
      z.literal("0"),
      z.literal("false"),
    ]),
    HARNESS_CANARY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(3_600_000)
      .default(900_000),
  })
  .superRefine((value, context) => {
    const base = new URL(value.HARNESS_CANARY_BASE_URL);
    if (base.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["HARNESS_CANARY_BASE_URL"],
        message: "The canary must target an HTTPS preview",
      });
    }
    if (base.host !== value.HARNESS_CANARY_EXPECTED_HOST) {
      context.addIssue({
        code: "custom",
        path: ["HARNESS_CANARY_EXPECTED_HOST"],
        message: `Expected ${value.HARNESS_CANARY_EXPECTED_HOST}, received ${base.host}`,
      });
    }
    const workflowIds = [
      value.HARNESS_CANARY_RESTORE_WORKFLOW_ID,
      value.HARNESS_CANARY_CLAUDE_WORKFLOW_ID,
      value.HARNESS_CANARY_CODEX_WORKFLOW_ID,
      value.HARNESS_CANARY_CUSTOM_WORKFLOW_ID,
    ];
    if (new Set(workflowIds).size !== workflowIds.length) {
      context.addIssue({
        code: "custom",
        path: ["HARNESS_CANARY_CLAUDE_WORKFLOW_ID"],
        message: "Restore and canary workflow IDs must all be distinct",
      });
    }
  });

export type HarnessCanaryEnv = z.infer<typeof schema>;

export function parseHarnessCanaryEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): HarnessCanaryEnv {
  return schema.parse(source);
}

export function assertMinimalCanaryWorkflow(
  detail: WorkflowDefinitionDetailResponse,
  expected: HarnessProfileReference,
): WorkflowDefinitionV2 {
  if (!detail.deployed || detail.meta.deployedVersion !== detail.deployed.version) {
    throw new Error(`Workflow ${detail.meta.id} must have one selected deployment`);
  }
  const definition = detail.deployed.definition;
  if (definition.schemaVersion !== 2) {
    throw new Error(`Workflow ${detail.meta.id} must deploy schema version 2`);
  }
  if (definition.nodes.length !== 2 || definition.edges.length !== 1) {
    throw new Error(
      `Workflow ${detail.meta.id} must contain only a trigger and one Generic Agent`,
    );
  }
  const trigger = definition.nodes.find(
    (node) => node.type === "trigger_ticket_ai",
  );
  const agent = definition.nodes.find((node) => node.type === "generic_agent");
  if (!trigger || !agent) {
    throw new Error(
      `Workflow ${detail.meta.id} must contain trigger_ticket_ai -> generic_agent`,
    );
  }
  if (
    definition.edges[0]?.from !== trigger.id ||
    definition.edges[0]?.to !== agent.id
  ) {
    throw new Error(`Workflow ${detail.meta.id} has an unsafe canary graph`);
  }
  if (agent.configuration.workspaceMode !== "none") {
    throw new Error(`Workflow ${detail.meta.id} must use workspaceMode "none"`);
  }
  const reference = agent.configuration.harnessProfile;
  if (
    !reference ||
    typeof reference !== "object" ||
    Array.isArray(reference) ||
    reference.profileId !== expected.profileId ||
    reference.version !== expected.version
  ) {
    throw new Error(
      `Workflow ${detail.meta.id} does not pin ${expected.profileId}@${expected.version}`,
    );
  }
  return definition;
}

export function assertCustomProfilePin(
  detail: HarnessProfileDetailResponse,
  expected: {
    profileId: string;
    version: number;
    artifactHash: string;
    skillName: string;
  },
): void {
  if (
    detail.profile.id !== expected.profileId ||
    detail.profile.system ||
    detail.profile.archivedAt !== null ||
    detail.profile.publishedVersion !== expected.version
  ) {
    throw new Error("Custom canary profile is not the exact active published profile");
  }
  if (
    detail.published?.version !== expected.version ||
    !detail.published.manifest.skills.some(
      (skill) =>
        skill.artifactHash === expected.artifactHash &&
        skill.name === expected.skillName,
    )
  ) {
    throw new Error("Custom canary profile does not pin the expected skill");
  }
}

export function assertRunHarnessManifest(
  records: HarnessRunManifestRecord[] | null,
  expected: {
    reference: HarnessProfileReference;
    provider: "claude" | "codex";
    skill?: {
      artifactHash: string;
      name: string;
      owner: string;
      repository: string;
      path: string;
      commitSha: string;
    };
  },
): void {
  const record = records?.find(
    (candidate) =>
      candidate.reference.profileId === expected.reference.profileId &&
      candidate.reference.version === expected.reference.version,
  );
  if (!record || record.manifest.harness.provider !== expected.provider) {
    throw new Error("Run did not capture the expected exact Harness Profile");
  }
  if (!expected.skill) return;
  const skill = record.skills.find(
    (candidate) =>
      candidate.artifactHash === expected.skill?.artifactHash &&
      candidate.name === expected.skill.name,
  );
  if (
    !skill ||
    skill.source.owner !== expected.skill.owner ||
    skill.source.repository !== expected.skill.repository ||
    skill.source.path !== expected.skill.path ||
    skill.source.commitSha !== expected.skill.commitSha
  ) {
    throw new Error("Run did not capture the expected pinned GitHub skill");
  }
}
