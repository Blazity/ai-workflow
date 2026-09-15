import { randomUUID } from "node:crypto";
import type {
  HarnessProfileManifest,
  HarnessProfileReference,
  HarnessRunManifestRecord,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import {
  isHarnessGitHubSkillSource,
  WORKFLOW_SCHEMA_VERSION,
} from "@shared/contracts";
import { CANARY_FIXTURE_MODELS } from "@shared/harness";
import { z } from "zod";

// Fixture identity (definition ids, the custom profile pin, its skill, one
// ticket per fixture) lives in engine-canary-fixtures.ts, not here. This
// schema is intentionally permissive about unknown keys: it parses
// process.env, which carries names this contract never claimed (PATH, CI,
// GITHUB_*, and, now, the fixture pin names ci.yml no longer forwards), and
// zod's default object mode strips those rather than rejecting them.
const schema = z
  .object({
    HARNESS_CANARY_BASE_URL: z.string().url(),
    HARNESS_CANARY_EXPECTED_HOST: z.string().trim().min(1),
    ENGINE_CANARY_MCP_CLIENT_ID: z.string().trim().min(1),
    ENGINE_CANARY_MCP_CLIENT_SECRET: z.string().min(20),
    HARNESS_CANARY_CONFIRM_PREVIEW_MUTATIONS: z.literal(
      "run-preview-harness-canary",
    ),
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
  });

export type HarnessCanaryEnv = z.infer<typeof schema>;

export function parseHarnessCanaryEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): HarnessCanaryEnv {
  return schema.parse(source);
}

export async function cancelTimedOutCanaryRun(
  mcp: {
    call<T>(name: string, args?: Record<string, unknown>): Promise<T>;
  },
  runId: string,
): Promise<void> {
  await mcp.call("runs.cancel", {
    runId,
    idempotencyKey: randomUUID(),
  });
}

export function assertMinimalCanaryWorkflow(
  detail: {
    id: number;
    enabled: boolean;
    deployedVersion: number | null;
    definition: WorkflowDefinitionV2 | null;
  },
  expected: HarnessProfileReference,
): WorkflowDefinitionV2 {
  if (detail.enabled) {
    throw new Error(`Workflow ${detail.id} must stay disabled`);
  }
  if (!detail.definition || detail.deployedVersion === null) {
    throw new Error(`Workflow ${detail.id} must have one selected deployment`);
  }
  if (detail.definition.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new Error(
      `Workflow ${detail.id} must deploy schema version ${WORKFLOW_SCHEMA_VERSION}`,
    );
  }
  const definition = detail.definition;
  if (definition.nodes.length !== 2 || definition.edges.length !== 1) {
    throw new Error(
      `Workflow ${detail.id} must contain only a trigger and one Generic Agent`,
    );
  }
  const trigger = definition.nodes.find(
    (node) => node.type === "trigger_ticket_ai",
  );
  const agent = definition.nodes.find((node) => node.type === "generic_agent");
  if (!trigger || !agent) {
    throw new Error(
      `Workflow ${detail.id} must contain trigger_ticket_ai -> generic_agent`,
    );
  }
  if (
    definition.edges[0]?.from !== trigger.id ||
    definition.edges[0]?.to !== agent.id
  ) {
    throw new Error(`Workflow ${detail.id} has an unsafe canary graph`);
  }
  if (agent.configuration.workspaceMode !== "none") {
    throw new Error(`Workflow ${detail.id} must use workspaceMode "none"`);
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
      `Workflow ${detail.id} does not pin ${expected.profileId}@${expected.version}`,
    );
  }
  return definition;
}

export function assertCustomProfilePin(
  detail: {
    id: string;
    organizationId: string | null;
    system: boolean;
    archivedAt: string | null;
    publishedVersion: number | null;
    manifest: HarnessProfileManifest | null;
  },
  expected: {
    profileId: string;
    version: number;
    artifactHash: string;
    skillName: string;
  },
): void {
  if (
    detail.id !== expected.profileId ||
    !detail.organizationId ||
    detail.system ||
    detail.archivedAt !== null ||
    detail.publishedVersion !== expected.version
  ) {
    throw new Error("Custom canary profile is not the exact active published profile");
  }
  if (
    !detail.manifest ||
    !detail.manifest.skills.some(
      (skill) =>
        skill.artifactHash === expected.artifactHash &&
        skill.name === expected.skillName,
    )
  ) {
    throw new Error("Custom canary profile does not pin the expected skill");
  }
  const cheapestModel = CANARY_FIXTURE_MODELS[detail.manifest.harness.provider];
  if (detail.manifest.model.id !== cheapestModel) {
    throw new Error(`Custom canary profile must use ${cheapestModel}`);
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
    // The canary pins a GitHub-imported skill; a deployment-local source in
    // this slot is itself the failure, not a shape to branch on.
    !isHarnessGitHubSkillSource(skill.source) ||
    skill.source.owner !== expected.skill.owner ||
    skill.source.repository !== expected.skill.repository ||
    skill.source.path !== expected.skill.path ||
    skill.source.commitSha !== expected.skill.commitSha
  ) {
    throw new Error("Run did not capture the expected pinned GitHub skill");
  }
}
