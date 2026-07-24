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
  draft: HarnessProfileDraftManifestV1;
  createdAt: string;
  updatedAt: string;
  createdById: string;
  updatedById: string;
}

export interface HarnessProfileVersionDto {
  profileId: string;
  version: number;
  manifest: HarnessProfileManifestV1;
  manifestHash: string;
  createdAt: string;
  createdById: string;
  restoredFromVersion: number | null;
}

export interface HarnessProfileResolvedVersion {
  manifest: HarnessProfileManifestV1;
  manifestHash: string;
  skillArtifacts: HarnessResolvedSkillArtifact[];
}

export interface HarnessRunManifestRecord {
  nodeId: string;
  reference: HarnessProfileReference;
  manifestHash: string;
  manifest: {
    schemaVersion: 1;
    profileId: string;
    version: number;
    slug: string;
    displayName: string;
    system: boolean;
    harness: HarnessProfileManifestV1["harness"];
    model: HarnessProfileManifestV1["model"];
    context: HarnessProfileManifestV1["context"];
    compaction: HarnessProfileManifestV1["compaction"];
    subagents: HarnessProfileManifestV1["subagents"];
    limits: HarnessProfileManifestV1["limits"];
    workspace: HarnessProfileManifestV1["workspace"];
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
  };
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
}

export interface HarnessProfileMutationResponse {
  profile: HarnessProfileDto;
}

export interface HarnessProfilePublishResponse {
  profile: HarnessProfileDto;
  version: HarnessProfileVersionDto;
  changed: boolean;
}

export interface HarnessSkillSource {
  owner: string;
  repository: string;
  path: string;
  commitSha: string;
}

export interface HarnessSkillDiscovery {
  name: string;
  path: string;
  description: string | null;
}

export interface HarnessSkillDiscoveryResponse {
  source: Omit<HarnessSkillSource, "path">;
  skills: HarnessSkillDiscovery[];
}

export interface HarnessSkillDiscoverRequest {
  source: string;
}

export interface HarnessSkillImportRequest {
  source: Omit<HarnessSkillSource, "path">;
  paths: string[];
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
  version: 1,
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
    id: "claude-opus-4-6",
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
