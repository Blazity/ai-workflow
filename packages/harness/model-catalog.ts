import {
  BUILTIN_HARNESS_PROFILE_IDS,
  type BuiltinHarnessProfileId,
  type HarnessProfileManifestV1,
  type HarnessProfileReference,
  type HarnessProvider,
} from "@shared/contracts";

export { BUILTIN_HARNESS_PROFILE_IDS } from "@shared/contracts";

export const recognised = {
  claude: [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  ],
  codex: ["gpt-5.4", "gpt-5", "gpt-5-mini"],
} as const satisfies Record<HarnessProvider, readonly string[]>;

export const DEFAULT_MODELS = {
  claude: "claude-opus-4-8",
  codex: "gpt-5.4",
} as const satisfies Record<HarnessProvider, string>;

export const CALL_LLM_DEFAULT_MODEL = "claude-haiku-4-5";
export const CODE_HYGIENE_DEFAULT_MODEL = "claude-haiku-4-5";
export const REPO_MEMORY_DISTILL_CODEX_MODEL = "gpt-5-mini";

export function resolveModelDefaults(overrides: {
  claude?: string;
  codex?: string;
}): Record<HarnessProvider, string> {
  return {
    claude: overrides.claude ?? DEFAULT_MODELS.claude,
    codex: overrides.codex ?? DEFAULT_MODELS.codex,
  };
}

export interface ModelProviderContract {
  provider: HarnessProvider;
  modelIds: readonly string[];
}

export function isRecognisedModel(
  provider: HarnessProvider,
  modelId: string,
): boolean {
  return (recognised[provider] as readonly string[]).includes(modelId);
}

export function selectable(
  providerContract: ModelProviderContract,
): string[] {
  const seen = new Set<string>();
  return providerContract.modelIds.filter((modelId) => {
    if (seen.has(modelId) || !isRecognisedModel(providerContract.provider, modelId)) {
      return false;
    }
    seen.add(modelId);
    return true;
  });
}

const COMPATIBILITY_MANIFEST_SCHEMA_VERSION = 1 as const;

const CLAUDE_COMPATIBILITY_MANIFEST = {
  schemaVersion: COMPATIBILITY_MANIFEST_SCHEMA_VERSION,
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
    id: DEFAULT_MODELS.claude,
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
  schemaVersion: COMPATIBILITY_MANIFEST_SCHEMA_VERSION,
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
    id: DEFAULT_MODELS.codex,
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
