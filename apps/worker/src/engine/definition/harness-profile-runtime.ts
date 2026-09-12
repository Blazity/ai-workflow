import type {
  HarnessProfileReference,
  HarnessProfileResolvedVersion,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import {
  isHarnessProfileReference,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  builtinHarnessProfileReference,
} from "@shared/harness";
import { dedupeWorkflowDefinitionIssues } from "@shared/workflow-graph";
import type { Db } from "../../db/types.js";
import { createAuthRepository } from "../../db/repositories/auth.js";
import {
  resolveHarnessRuntime,
  type ResolvedHarnessRuntime,
} from "../../sandbox/harness-runtime.js";
import { hashHarnessProfileManifest } from "../../harness-profiles/manifest.js";
import { resolveVerifiedHarnessProfileVersion } from "../../harness-profiles/resolved-version.js";

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
  const row = await createAuthRepository(db).findOrganizationBySlug(
    organizationSlug,
  );
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
    providerOverride?: "claude" | "codex" | null;
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
        pending = resolveVerifiedHarnessProfileVersion(db, {
          organizationId: input.organizationId,
          profileId,
          version,
        });
        versions.set(key, pending);
      }
      return pending;
    },
    input.providerOverride ?? null,
  );
}

export async function resolveConnectedHarnessRuntimesForDefinition(input: {
  definition: WorkflowDefinition;
  organizationSlug: string;
  defaultProvider: "claude" | "codex";
  providerOverride?: "claude" | "codex" | null;
}): Promise<Record<string, ResolvedHarnessRuntime>> {
  const { createConnectedAuthRepository } = await import("../../db/repositories/auth.js");
  const { resolveConnectedVerifiedHarnessProfileVersion } = await import(
    "../../harness-profiles/resolved-version.js"
  );
  const organization = await createConnectedAuthRepository().findOrganizationBySlug(
    input.organizationSlug,
  );
  if (!organization) {
    throw new Error(`Dashboard organization "${input.organizationSlug}" is unavailable.`);
  }
  return resolveHarnessRuntimesWithLoader(
    input.definition,
    input.defaultProvider,
    ({ profileId, version }) =>
      resolveConnectedVerifiedHarnessProfileVersion({
        organizationId: organization.id,
        profileId,
        version,
      }),
    input.providerOverride ?? null,
  );
}

/**
 * `providerOverride` is the provider a ticket's `agent:<kind>` label demanded.
 * It is deliberately separate from `defaultProvider`: the default is consulted
 * only when a block pins nothing, whereas the label has to beat a pin.
 */
export async function resolveHarnessRuntimesWithLoader(
  definition: WorkflowDefinition,
  defaultProvider: "claude" | "codex",
  load: HarnessProfileVersionLoader,
  providerOverride: "claude" | "codex" | null = null,
): Promise<Record<string, ResolvedHarnessRuntime>> {
  const runtimes: Record<string, ResolvedHarnessRuntime> = {};
  for (const node of definition.nodes) {
    if (!AGENT_BLOCK_TYPES.has(node.type)) continue;
    const configuration: Record<string, unknown> = node.configuration;
    const workspaceMode =
      node.type === "generic_agent"
        ? configuration.workspaceMode
        : "read_write";

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
    const pinned =
      (await load(reference)) ??
      (!explicitReference
        ? builtinResolvedVersion(reference.profileId)
        : null);
    if (!pinned) {
      throw new Error(
        `Harness Profile "${reference.profileId}" version ${reference.version} is unavailable for block "${node.id}".`,
      );
    }
    // A v2 block must pin an exact published profile, and that pin answers the
    // provider question before any run-wide default is consulted. So the only
    // way to honour a ticket's `agent:<kind>` label is to resolve a different
    // profile: the system one of the demanded provider. A pin that already runs
    // on the demanded provider is kept as authored, because the label asks for a
    // provider and has no quarrel with that profile's skills or instructions.
    const overridden =
      providerOverride !== null &&
      pinned.manifest.harness.provider !== providerOverride
        ? await systemProfileForProvider(providerOverride, node.id, load)
        : null;
    const effectiveReference = overridden?.reference ?? reference;
    const resolved = overridden?.resolved ?? pinned;
    if (
      codeWorkspaceRequired(node.type, workspaceMode) &&
      !resolved.manifest.workspace.preserveAcrossBlocks
    ) {
      throw new Error(
        `Harness Profile "${effectiveReference.profileId}" version ${effectiveReference.version} cannot be used by block "${node.id}" because its managed workspace is not preserved across blocks.`,
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
  return validateHarnessProfileReferencesWithLoader(
    input.definition,
    ({ profileId, version }) =>
      resolveVerifiedHarnessProfileVersion(db, {
        organizationId: input.organizationId,
        profileId,
        version,
      }),
  );
}

export async function validateHarnessProfileReferencesWithLoader(
  definition: WorkflowDefinition,
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
  return dedupeWorkflowDefinitionIssues(issues);
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

/**
 * The system profile a ticket label redirects a block to. A run that cannot get
 * it must fail loudly: a label the run accepted and then dropped would send the
 * work to the provider the operator explicitly steered away from.
 */
async function systemProfileForProvider(
  provider: "claude" | "codex",
  nodeId: string,
  load: HarnessProfileVersionLoader,
): Promise<{
  reference: HarnessProfileReference;
  resolved: HarnessProfileResolvedVersion;
}> {
  const reference = builtinHarnessProfileReference(provider);
  const resolved = await load(reference);
  if (!resolved) {
    throw new Error(
      `The "agent:${provider}" label cannot be honoured for block "${nodeId}" because Harness Profile "${reference.profileId}" version ${reference.version} is unavailable.`,
    );
  }
  return { reference, resolved };
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
