import type { JsonValue } from "./domain.js";

export const BUILTIN_HARNESS_PROFILE_IDS = {
  claude: "builtin-claude",
  codex: "builtin-codex",
} as const;

export type HarnessProvider = keyof typeof BUILTIN_HARNESS_PROFILE_IDS;
export type BuiltinHarnessProfileId =
  (typeof BUILTIN_HARNESS_PROFILE_IDS)[HarnessProvider];

export const HARNESS_TOOL_IDS = ["filesystem", "shell", "git"] as const;
export type HarnessToolId = (typeof HARNESS_TOOL_IDS)[number];

export const HARNESS_MCP_INTEGRATION_IDS = [] as const;
export type HarnessMcpIntegrationId =
  (typeof HARNESS_MCP_INTEGRATION_IDS)[number];

/** Exact immutable profile version pinned by a v2 agent block. */
export interface HarnessProfileReference {
  profileId: string;
  version: number;
}

export interface HarnessProfileHomeFile {
  path: string;
  content: string;
  mode: number;
}

export interface HarnessProfileSkillReference {
  artifactHash: string;
  name: string;
}

export interface HarnessProfileDraftManifestV1 {
  schemaVersion: 1;
  displayName: string;
  description: string;
  harness: {
    provider: HarnessProvider;
    packageName: string;
    cliVersion: string;
    protocolVersion: string;
  };
  model: {
    id: string;
    options: Record<string, JsonValue>;
  };
  homeFiles: HarnessProfileHomeFile[];
  context: {
    includeRepositoryInstructions: boolean;
    includeWorkflowData: boolean;
  };
  compaction: {
    mode: "provider_default";
  };
  subagents: {
    enabled: boolean;
    maxConcurrent: number;
  };
  limits: {
    maxDurationMs: number | null;
    maxTokens: number | null;
    maxCostUsd: number | null;
  };
  workspace: {
    mode: "managed";
    preserveAcrossBlocks: boolean;
  };
  instructions: string;
  skills: HarnessProfileSkillReference[];
  tools: string[];
  mcpIntegrations: string[];
  credentialReferences: string[];
}

export type HarnessReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface HarnessCapabilityOption {
  id: string;
  name: string;
  description: string | null;
}

export interface HarnessModelCapability {
  id: string;
  name: string;
  description: string | null;
  contextWindowTokens: number | null;
  reasoningEfforts: HarnessCapabilityOption[];
  defaultReasoningEffort: string | null;
  serviceTiers: HarnessCapabilityOption[];
  defaultServiceTier: string | null;
  verbosityOptions: HarnessCapabilityOption[];
  defaultVerbosity: string | null;
  compactionModes: Array<
    "model_default" | "custom_threshold" | "disabled"
  >;
}

export interface HarnessCapabilityCatalog {
  provider: HarnessProvider;
  packageName: string;
  cliVersion: string;
  protocolVersion: string;
  models: HarnessModelCapability[];
}

export interface HarnessCapabilitiesResponse
  extends HarnessCapabilityCatalog {
  catalogHash: string;
  fetchedAt: string;
  stale: boolean;
  refreshFailure: {
    occurredAt: string;
    message: string;
  } | null;
}

export interface HarnessProfileDraftManifestV2
  extends Omit<
    HarnessProfileDraftManifestV1,
    "schemaVersion" | "model" | "compaction"
  > {
  schemaVersion: 2;
  model: {
    id: string;
    reasoning: {
      /** "model_default" or an exact provider-advertised effort ID. */
      selection: string;
      effectiveEffort: string;
    };
    serviceTier: string;
    verbosity?: string;
    capability: HarnessModelCapability;
    catalogHash: string;
  };
  compaction:
    | { mode: "model_default" }
    | {
        mode: "custom_threshold";
        thresholdPercent: number;
        thresholdTokens: number;
      }
    | { mode: "disabled" };
}

export type HarnessProfileDraftManifest =
  | HarnessProfileDraftManifestV1
  | HarnessProfileDraftManifestV2;

/**
 * Complete non-secret manifest used by the code-owned PR4 compatibility
 * profiles. PR5 persists this same contract as an immutable profile version.
 */
export interface HarnessProfileManifestV1
  extends HarnessProfileDraftManifestV1 {
  profileId: string;
  version: number;
  slug: string;
  system: boolean;
}

export interface HarnessProfileManifestV2
  extends HarnessProfileDraftManifestV2 {
  profileId: string;
  version: number;
  slug: string;
  system: boolean;
}

export type HarnessProfileManifest =
  | HarnessProfileManifestV1
  | HarnessProfileManifestV2;

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function buildHarnessProfileDraftV2(
  draft: HarnessProfileDraftManifestV1,
  capabilities: HarnessCapabilitiesResponse,
): HarnessProfileDraftManifestV2 | null {
  const model = capabilities.models.find(
    (candidate) => candidate.id === draft.model.id,
  );
  const effectiveEffort =
    model?.defaultReasoningEffort ?? model?.reasoningEfforts[0]?.id;
  const serviceTier =
    model?.defaultServiceTier ?? model?.serviceTiers[0]?.id;
  if (!model || !effectiveEffort || !serviceTier) return null;
  return {
    ...structuredClone(draft),
    schemaVersion: 2,
    model: {
      id: model.id,
      reasoning: {
        selection: model.defaultReasoningEffort
          ? "model_default"
          : effectiveEffort,
        effectiveEffort,
      },
      serviceTier,
      ...(model.defaultVerbosity
        ? { verbosity: model.defaultVerbosity }
        : {}),
      capability: structuredClone(model),
      catalogHash: capabilities.catalogHash,
    },
    compaction: { mode: "model_default" },
  };
}

export interface HarnessProfileDto {
  id: string;
  organizationId: string | null;
  slug: string;
  system: boolean;
  readOnly: boolean;
  archivedAt: string | null;
  draftRevision: number;
  draftRestoredFromVersion: number | null;
  publishedVersion: number | null;
  draft: HarnessProfileDraftManifest;
  createdAt: string;
  updatedAt: string;
  createdById: string;
  updatedById: string;
}

export interface HarnessProfileVersionDto {
  profileId: string;
  version: number;
  manifest: HarnessProfileManifest;
  manifestHash: string;
  createdAt: string;
  createdById: string;
  restoredFromVersion: number | null;
}

export interface HarnessProfileResolvedVersion {
  manifest: HarnessProfileManifest;
  manifestHash: string;
  skillArtifacts: HarnessResolvedSkillArtifact[];
}

interface HarnessRunManifestCommon {
  profileId: string;
  version: number;
  slug: string;
  displayName: string;
  system: boolean;
  harness: HarnessProfileManifest["harness"];
  context: HarnessProfileManifest["context"];
  subagents: HarnessProfileManifest["subagents"];
  limits: HarnessProfileManifest["limits"];
  workspace: HarnessProfileManifest["workspace"];
  instructionsSha256: string;
  homeFiles: {
    count: number;
    totalBytes: number;
    sha256: string;
  };
  skills: HarnessProfileSkillReference[];
  tools: string[];
  mcpIntegrations: string[];
  credentialReferences: string[];
}

type HarnessRunManifest =
  | (HarnessRunManifestCommon & {
      schemaVersion: 1;
      model: HarnessProfileManifestV1["model"];
      compaction: HarnessProfileManifestV1["compaction"];
    })
  | (HarnessRunManifestCommon & {
      schemaVersion: 2;
      model: HarnessProfileManifestV2["model"];
      compaction: HarnessProfileManifestV2["compaction"];
    });

export interface HarnessRunManifestRecord {
  nodeId: string;
  reference: HarnessProfileReference;
  manifestHash: string;
  manifest: HarnessRunManifest;
  skills: Array<{
    artifactHash: string;
    name: string;
    source: HarnessSkillSource;
    fileCount: number;
    totalBytes: number;
  }>;
  declaredCapabilities: string[];
  effectiveCapabilities: string[];
  clippedCapabilities: string[];
}

export interface HarnessProfileCapabilities {
  requestedTools: string[];
  tools: HarnessToolId[];
  clippedTools: string[];
  requestedMcpIntegrations: string[];
  mcpIntegrations: HarnessMcpIntegrationId[];
  clippedMcpIntegrations: string[];
  subagents: {
    requested: boolean;
    enabled: boolean;
    maxConcurrent: number;
    clipped: boolean;
  };
}

export interface HarnessProfilesResponse {
  profiles: HarnessProfileDto[];
  canManageProfiles: boolean;
}

export interface HarnessProfileDetailResponse {
  profile: HarnessProfileDto;
  published: HarnessProfileVersionDto | null;
  versions: HarnessProfileVersionDto[];
  canManageProfile: boolean;
  canDeleteProfile: boolean;
  usage: HarnessProfileUsageDto[];
  /**
   * Where each skill the draft pins came from, looked up at read time. A pin
   * whose artifact row is gone is simply absent here.
   */
  skillSources: HarnessProfileSkillSourceDto[];
}

/**
 * Derived, never persisted. A skill reference inside a manifest stays exactly
 * `{artifactHash, name}` because the manifest is hashed whole, so growing it
 * would rehash every profile version already stored.
 */
export interface HarnessProfileSkillSourceDto {
  artifactHash: string;
  source: HarnessSkillSource;
}

export interface HarnessProfileUsageDto {
  definitionId: number;
  name: string;
  versions: number[];
  deployed: boolean;
}

export interface HarnessProfileMutationResponse {
  profile: HarnessProfileDto;
}

export interface HarnessProfilePublishResponse {
  profile: HarnessProfileDto;
  version: HarnessProfileVersionDto;
  changed: boolean;
}

/**
 * Frozen canonical shape. The source object is serialized whole into the
 * artifact hash that profiles pin, so adding, renaming or reordering a field
 * here rehashes every artifact already stored and unpins every profile.
 */
export interface HarnessGitHubSkillSource {
  owner: string;
  repository: string;
  path: string;
  commitSha: string;
}

/**
 * A skill read from the `skills/` directory of the deployment's own
 * repository. It has no commit and no repository to point at; its version is
 * the digest of its contents.
 */
export interface HarnessLocalSkillSource {
  path: string;
  contentSha256: string;
}

/**
 * The variants are told apart by which fields are present, never by a kind
 * tag inside the object: a tag would enter the hashed payload and break the
 * freeze above. A persisted kind belongs in a column beside the hash.
 */
export type HarnessSkillSource =
  | HarnessGitHubSkillSource
  | HarnessLocalSkillSource;

/**
 * Tells the variants apart by the field only the GitHub one carries. Every
 * caller that needs the GitHub coordinate goes through this rather than
 * reading a tag, because there is no tag to read.
 */
export function isHarnessGitHubSkillSource(
  source: HarnessSkillSource,
): source is HarnessGitHubSkillSource {
  return "commitSha" in source;
}

export interface HarnessSkillDiscovery {
  name: string;
  path: string;
  description: string | null;
}

export interface HarnessSkillDiscoveryResponse {
  source: Omit<HarnessGitHubSkillSource, "path">;
  skills: HarnessSkillDiscovery[];
}

export interface HarnessSkillDiscoverRequest {
  source: string;
}

export interface HarnessSkillImportRequest {
  source: Omit<HarnessGitHubSkillSource, "path">;
  paths: string[];
}

/**
 * Discovering deployment-local skills takes no repository coordinate: the
 * source is the deployment itself. `path` is the skill's directory name under
 * `skills/`.
 *
 * `artifactHash` is the identity the import would mint for the bytes on disk
 * right now. It travels because nothing else can answer whether a pinned skill
 * still matches the deployment: the pin is a hash, so without one to compare it
 * against, a stale pin is undetectable rather than merely unshown.
 */
export interface HarnessLocalSkillDiscovery extends HarnessSkillDiscovery {
  artifactHash: string;
}

/** A directory under `skills/` that cannot be offered, and why. */
export interface HarnessLocalSkillSkip {
  path: string;
  reason: string;
}

export interface HarnessLocalSkillDiscoveryResponse {
  /**
   * False when the deployment carries no `skills/` directory at all. That is a
   * different failure from a directory whose entries were all skipped, and the
   * two are indistinguishable from an empty list alone.
   */
  directoryPresent: boolean;
  skills: HarnessLocalSkillDiscovery[];
  skipped: HarnessLocalSkillSkip[];
}

/**
 * The hash comes back from discovery for the same reason the GitHub import
 * repeats an exact commit: a deployment promoted between the two calls swaps
 * the bytes under the selection, and the import must catch that instead of
 * storing content the operator never saw.
 */
export interface HarnessLocalSkillSelection {
  path: string;
  artifactHash: string;
}

export interface HarnessLocalSkillImportRequest {
  skills: HarnessLocalSkillSelection[];
}

export interface HarnessSkillArtifactFile {
  path: string;
  mode: number;
  sizeBytes: number;
  sha256: string;
}

export interface HarnessSkillArtifact {
  artifactHash: string;
  organizationId: string;
  name: string;
  description: string | null;
  /** Mirrors the persisted row, whose kind lives in a column beside the hash. */
  source: HarnessSkillSource;
  files: HarnessSkillArtifactFile[];
  createdAt: string;
  createdById: string;
}

export interface HarnessResolvedSkillArtifact
  extends HarnessSkillArtifact {
  files: Array<HarnessSkillArtifactFile & { contentBase64: string }>;
}

export interface HarnessSkillImportResponse {
  artifacts: HarnessSkillArtifact[];
}

export interface HarnessSkillRefreshRequest {
  expectedRevision: number;
  artifactHash: string;
}

export interface HarnessSkillRefreshResponse {
  profile: HarnessProfileDto;
  artifact: HarnessSkillArtifact;
  /**
   * False when the source still holds the bytes the profile already pinned.
   * Both outcomes are successes, and without this flag they are the same
   * response, so "the redeploy did not arrive" would look like "it did".
   */
  changed: boolean;
}

export const HARNESS_SKILL_IMPORT_LIMITS = {
  maxFiles: 500,
  maxFileBytes: 1024 * 1024,
  maxSkillBytes: 5 * 1024 * 1024,
} as const;

/**
 * A built-in manifest's version is its monotonic code-owned catalog revision.
 * Changing any persisted field requires increasing this value.
 */
const CLAUDE_COMPATIBILITY_MANIFEST = {
  schemaVersion: 1,
  profileId: BUILTIN_HARNESS_PROFILE_IDS.claude,
  version: 2,
  slug: "claude",
  displayName: "Claude",
  description: "Code-owned Claude compatibility profile.",
  system: true,
  harness: {
    provider: "claude",
    packageName: "@anthropic-ai/claude-code",
    cliVersion: "2.1.216",
    protocolVersion: "claude-json-2.1.216",
  },
  model: {
    id: "claude-opus-4-8",
    options: {},
  },
  homeFiles: [],
  context: {
    includeRepositoryInstructions: true,
    includeWorkflowData: true,
  },
  compaction: {
    mode: "provider_default",
  },
  subagents: {
    enabled: false,
    maxConcurrent: 0,
  },
  limits: {
    maxDurationMs: null,
    maxTokens: null,
    maxCostUsd: null,
  },
  workspace: {
    mode: "managed",
    preserveAcrossBlocks: true,
  },
  instructions:
    "Follow the block's fixed role, the repository instructions, and the supplied workflow data.",
  skills: [],
  tools: ["filesystem", "shell", "git"],
  mcpIntegrations: [],
  credentialReferences: ["anthropic"],
} as const satisfies HarnessProfileManifestV1;

const CODEX_COMPATIBILITY_MANIFEST = {
  schemaVersion: 1,
  profileId: BUILTIN_HARNESS_PROFILE_IDS.codex,
  version: 2,
  slug: "codex",
  displayName: "Codex",
  description: "Code-owned Codex compatibility profile.",
  system: true,
  harness: {
    provider: "codex",
    packageName: "@openai/codex",
    cliVersion: "0.144.6",
    protocolVersion: "codex-jsonl-0.144.6",
  },
  model: {
    id: "gpt-5.4",
    options: {},
  },
  homeFiles: [],
  context: {
    includeRepositoryInstructions: true,
    includeWorkflowData: true,
  },
  compaction: {
    mode: "provider_default",
  },
  subagents: {
    enabled: false,
    maxConcurrent: 0,
  },
  limits: {
    maxDurationMs: null,
    maxTokens: null,
    maxCostUsd: null,
  },
  workspace: {
    mode: "managed",
    preserveAcrossBlocks: true,
  },
  instructions:
    "Follow the block's fixed role, the repository instructions, and the supplied workflow data.",
  skills: [],
  tools: ["filesystem", "shell", "git"],
  mcpIntegrations: [],
  credentialReferences: ["openai"],
} as const satisfies HarnessProfileManifestV1;

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const BUILTIN_HARNESS_PROFILE_MANIFESTS = deepFreeze({
  [BUILTIN_HARNESS_PROFILE_IDS.claude]: CLAUDE_COMPATIBILITY_MANIFEST,
  [BUILTIN_HARNESS_PROFILE_IDS.codex]: CODEX_COMPATIBILITY_MANIFEST,
});

export function isHarnessProfileReference(
  value: unknown,
): value is HarnessProfileReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record.profileId === "string" &&
    record.profileId.trim() === record.profileId &&
    record.profileId.length > 0 &&
    typeof record.version === "number" &&
    Number.isInteger(record.version) &&
    record.version > 0
  );
}

export function builtinHarnessProfileReference(
  provider: HarnessProvider,
): HarnessProfileReference {
  const profileId = BUILTIN_HARNESS_PROFILE_IDS[provider];
  return {
    profileId,
    version: BUILTIN_HARNESS_PROFILE_MANIFESTS[profileId].version,
  };
}

export function resolveBuiltinHarnessProfile(
  reference: HarnessProfileReference,
): Readonly<HarnessProfileManifestV1> | null {
  const manifest =
    BUILTIN_HARNESS_PROFILE_MANIFESTS[
      reference.profileId as BuiltinHarnessProfileId
    ];
  return manifest?.version === reference.version ? manifest : null;
}
