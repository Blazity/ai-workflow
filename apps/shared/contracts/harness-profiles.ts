import type { JsonValue } from "./domain.js";

export const BUILTIN_HARNESS_PROFILE_IDS = {
  claude: "builtin-claude",
  codex: "builtin-codex",
} as const;

export type HarnessProvider = keyof typeof BUILTIN_HARNESS_PROFILE_IDS;
export type BuiltinHarnessProfileId =
  (typeof BUILTIN_HARNESS_PROFILE_IDS)[HarnessProvider];

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

/**
 * Complete non-secret manifest used by the code-owned PR4 compatibility
 * profiles. PR5 persists this same contract as an immutable profile version.
 */
export interface HarnessProfileManifestV1 {
  schemaVersion: 1;
  profileId: BuiltinHarnessProfileId;
  version: 1;
  slug: string;
  displayName: string;
  description: string;
  system: true;
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
  tools: [],
  mcpIntegrations: [],
  credentialReferences: ["anthropic"],
} as const satisfies HarnessProfileManifestV1;

const CODEX_COMPATIBILITY_MANIFEST = {
  schemaVersion: 1,
  profileId: BUILTIN_HARNESS_PROFILE_IDS.codex,
  version: 1,
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
    id: "gpt-5-codex",
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
  tools: [],
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
  return {
    profileId: BUILTIN_HARNESS_PROFILE_IDS[provider],
    version: 1,
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
