import { eq } from "drizzle-orm";
import type {
  HarnessProfileResolvedVersion,
  HarnessRunManifestRecord,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionNode,
  WorkflowDefinitionValidationIssue,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  builtinHarnessProfileReference,
  isHarnessProfileReference,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import { organization } from "../db/schema.js";
import {
  resolveHarnessRuntime,
  type ResolvedHarnessRuntime,
} from "../sandbox/harness-runtime.js";
import { hashHarnessProfileManifest } from "../harness-profiles/manifest.js";
import { resolveHarnessProfileVersion } from "../harness-profiles/store.js";

const AGENT_BLOCK_TYPES = new Set<WorkflowBlockType>([
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "fix_agent",
  "generic_agent",
]);

const CODE_WORKSPACE_AGENT_BLOCK_TYPES = new Set<WorkflowBlockType>([
  "implementation_agent",
  "review_agent",
  "fix_agent",
]);

export type HarnessProfileVersionLoader = (input: {
  profileId: string;
  version: number;
}) => Promise<HarnessProfileResolvedVersion | null>;

export async function dashboardOrganizationId(
  db: Db,
  organizationSlug: string,
): Promise<string> {
  const [row] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, organizationSlug))
    .limit(1);
  if (!row) {
    throw new Error(
      `Dashboard organization "${organizationSlug}" is unavailable.`,
    );
  }
  return row.id;
}

export async function resolveHarnessRuntimesForDefinition(
  db: Db,
  input: {
    definition: WorkflowDefinition;
    organizationId: string;
    defaultProvider: "claude" | "codex";
  },
): Promise<Record<string, ResolvedHarnessRuntime>> {
  const versions = new Map<
    string,
    Promise<HarnessProfileResolvedVersion | null>
  >();
  return resolveHarnessRuntimesWithLoader(
    input.definition,
    input.defaultProvider,
    ({ profileId, version }) => {
      const key = `${profileId}:${version}`;
      let pending = versions.get(key);
      if (!pending) {
        pending = resolveHarnessProfileVersion(db, {
          organizationId: input.organizationId,
          profileId,
          version,
        });
        versions.set(key, pending);
      }
      return pending;
    },
  );
}

export async function resolveHarnessRuntimesWithLoader(
  definition: WorkflowDefinition,
  defaultProvider: "claude" | "codex",
  load: HarnessProfileVersionLoader,
): Promise<Record<string, ResolvedHarnessRuntime>> {
  const runtimes: Record<string, ResolvedHarnessRuntime> = {};
  for (const node of definition.nodes) {
    if (!AGENT_BLOCK_TYPES.has(node.type)) continue;
    const configuration: Record<string, unknown> =
      definition.schemaVersion === 2
        ? (node as WorkflowDefinitionV2Node).configuration
        : (node as WorkflowDefinitionNode).params;
    const workspaceMode =
      node.type === "generic_agent"
        ? configuration.workspaceMode
        : "read_write";

    if (definition.schemaVersion === 1) {
      // V1 keeps its current shared-home interpreter. This virtual manifest is
      // captured for auditability only; execution deliberately does not consume
      // its hash-addressed paths or disable the historical skills.sh setup.
      const provider =
        configuration.provider === "claude" ||
        configuration.provider === "codex"
          ? configuration.provider
          : defaultProvider;
      const codeOwned =
        provider === "claude"
          ? BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-claude"]
          : BUILTIN_HARNESS_PROFILE_MANIFESTS["builtin-codex"];
      const model =
        typeof configuration.model === "string" &&
        configuration.model.trim().length > 0
          ? configuration.model.trim()
          : codeOwned.model.id;
      const manifest = {
        ...structuredClone(codeOwned),
        profileId: `virtual-v1-${provider}`,
        slug: `virtual-v1-${provider}`,
        displayName: `V1 ${codeOwned.displayName} compatibility`,
        model: { id: model, options: {} },
      };
      const resolved: HarnessProfileResolvedVersion = {
        manifest,
        manifestHash: hashHarnessProfileManifest(manifest),
        skillArtifacts: [],
      };
      runtimes[node.id] = resolveHarnessRuntime({
        nodeId: node.id,
        nodeType: node.type,
        workspaceMode,
        resolved,
        legacyDynamicSkills: true,
      });
      continue;
    }

    const reference = isHarnessProfileReference(
      configuration.harnessProfile,
    )
      ? configuration.harnessProfile
      : builtinHarnessProfileReference(
          configuration.provider === "claude" ||
            configuration.provider === "codex"
            ? configuration.provider
            : defaultProvider,
        );
    const explicitReference = isHarnessProfileReference(
      configuration.harnessProfile,
    );
    const resolved =
      (await load(reference)) ??
      (!explicitReference
        ? builtinResolvedVersion(reference.profileId)
        : null);
    if (!resolved) {
      throw new Error(
        `Harness Profile "${reference.profileId}" version ${reference.version} is unavailable for block "${node.id}".`,
      );
    }
    if (
      codeWorkspaceRequired(node.type, workspaceMode) &&
      !resolved.manifest.workspace.preserveAcrossBlocks
    ) {
      throw new Error(
        `Harness Profile "${reference.profileId}" version ${reference.version} cannot be used by block "${node.id}" because its managed workspace is not preserved across blocks.`,
      );
    }
    runtimes[node.id] = resolveHarnessRuntime({
      nodeId: node.id,
      nodeType: node.type,
      workspaceMode,
      resolved,
      legacyDynamicSkills: false,
    });
  }
  return runtimes;
}

export async function validateHarnessProfileReferences(
  db: Db,
  input: {
    definition: WorkflowDefinition;
    organizationId: string;
  },
): Promise<WorkflowDefinitionValidationIssue[]> {
  if (input.definition.schemaVersion !== 2) return [];
  return validateHarnessProfileReferencesWithLoader(
    input.definition,
    ({ profileId, version }) =>
      resolveHarnessProfileVersion(db, {
        organizationId: input.organizationId,
        profileId,
        version,
      }),
  );
}

export async function validateHarnessProfileReferencesWithLoader(
  definition: Extract<WorkflowDefinition, { schemaVersion: 2 }>,
  load: HarnessProfileVersionLoader,
): Promise<WorkflowDefinitionValidationIssue[]> {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [index, node] of definition.nodes.entries()) {
    if (!AGENT_BLOCK_TYPES.has(node.type)) continue;
    const path = `/nodes/${index}/configuration/harnessProfile`;
    const reference = node.configuration.harnessProfile;
    if (!isHarnessProfileReference(reference)) {
      issues.push({
        code: "harness_profile_required",
        severity: "error",
        nodeId: node.id,
        path,
        message:
          `Block "${node.id}" must pin an exact published Harness Profile version.`,
      });
      continue;
    }
    const resolved = await load(reference);
    if (!resolved) {
      issues.push({
        code: "harness_profile_unavailable",
        severity: "error",
        nodeId: node.id,
        path,
        message:
          `Harness Profile "${reference.profileId}" version ${reference.version} is unavailable.`,
      });
      continue;
    }
    const workspaceMode =
      node.type === "generic_agent"
        ? node.configuration.workspaceMode
        : "read_write";
    if (
      codeWorkspaceRequired(node.type, workspaceMode) &&
      !resolved.manifest.workspace.preserveAcrossBlocks
    ) {
      issues.push({
        code: "harness_profile_workspace_incompatible",
        severity: "error",
        nodeId: node.id,
        path,
        message:
          `Harness Profile "${reference.profileId}" version ${reference.version} does not preserve the managed workspace required by this block.`,
      });
      continue;
    }
    try {
      resolveHarnessRuntime({
        nodeId: node.id,
        nodeType: node.type,
        workspaceMode,
        resolved,
      });
    } catch (error) {
      issues.push({
        code: "harness_profile_runtime_unsupported",
        severity: "error",
        nodeId: node.id,
        path,
        message:
          error instanceof Error
            ? error.message
            : "The pinned Harness Profile is unsupported by the current runtime.",
      });
    }
  }
  return dedupeIssues(issues);
}

export function harnessRunManifests(
  runtimes: Readonly<Record<string, ResolvedHarnessRuntime>>,
): HarnessRunManifestRecord[] {
  return Object.values(runtimes)
    .map((runtime) => structuredClone(runtime.safeManifest))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function codeWorkspaceRequired(
  nodeType: WorkflowBlockType,
  workspaceMode: unknown,
): boolean {
  return (
    CODE_WORKSPACE_AGENT_BLOCK_TYPES.has(nodeType) ||
    (nodeType === "generic_agent" && workspaceMode !== "none")
  );
}

function builtinResolvedVersion(
  profileId: string,
): HarnessProfileResolvedVersion | null {
  const manifest =
    BUILTIN_HARNESS_PROFILE_MANIFESTS[
      profileId as keyof typeof BUILTIN_HARNESS_PROFILE_MANIFESTS
    ];
  if (!manifest) return null;
  const cloned = structuredClone(manifest);
  return {
    manifest: cloned,
    manifestHash: hashHarnessProfileManifest(cloned),
    skillArtifacts: [],
  };
}

function dedupeIssues(
  issues: readonly WorkflowDefinitionValidationIssue[],
): WorkflowDefinitionValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = JSON.stringify([
      issue.code,
      issue.nodeId,
      issue.path ?? null,
      issue.message,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
