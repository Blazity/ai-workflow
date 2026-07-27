import { createHash } from "node:crypto";
import { posix } from "node:path";
import type {
  HarnessModelCapability,
  HarnessProfileDraftManifest,
  HarnessProfileDraftManifestV1,
  HarnessProfileDraftManifestV2,
  HarnessProfileManifest,
  HarnessProfileManifestV1,
  HarnessProfileManifestV2,
  JsonValue,
} from "@shared/contracts";
import {
  HARNESS_MCP_INTEGRATION_IDS,
  HARNESS_TOOL_IDS,
} from "@shared/contracts";
import { z } from "zod";

export const HARNESS_CREDENTIAL_IDS = [
  "anthropic",
  "openai",
  "github",
  "gitlab",
  "jira",
  "slack",
] as const;

export const HARNESS_PROVIDER_CONTRACTS = {
  claude: {
    packageName: "@anthropic-ai/claude-code",
    cliVersions: ["2.1.216"],
    protocolVersions: ["claude-json-2.1.216"],
  },
  codex: {
    packageName: "@openai/codex",
    cliVersions: ["0.144.6"],
    protocolVersions: ["codex-jsonl-0.144.6"],
  },
} as const;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const artifactHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const catalogHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const draftManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: boundedString(120),
    description: z.string().trim().max(2_000),
    harness: z
      .object({
        provider: z.enum(["claude", "codex"]),
        packageName: boundedString(200),
        cliVersion: boundedString(80),
        protocolVersion: boundedString(120),
      })
      .strict(),
    model: z
      .object({
        id: boundedString(200),
        options: z.record(z.string(), jsonValueSchema),
      })
      .strict(),
    homeFiles: z
      .array(
        z
          .object({
            path: boundedString(300),
            content: z.string().max(1024 * 1024),
            mode: z.literal(0o644),
          })
          .strict(),
      )
      .max(100),
    context: z
      .object({
        // Both supported CLIs discover repository instructions from the
        // working tree. Until a pinned CLI contract can disable discovery,
        // profiles must describe the behavior they can actually enforce.
        includeRepositoryInstructions: z.literal(true),
        includeWorkflowData: z.boolean(),
      })
      .strict(),
    compaction: z.object({ mode: z.literal("provider_default") }).strict(),
    subagents: z
      .object({
        enabled: z.boolean(),
        maxConcurrent: z.number().int().min(0).max(16),
      })
      .strict(),
    limits: z
      .object({
        maxDurationMs: z.number().int().positive().max(86_400_000).nullable(),
        maxTokens: z.number().int().positive().max(10_000_000).nullable(),
        maxCostUsd: z.number().finite().positive().max(100_000).nullable(),
      })
      .strict(),
    workspace: z
      .object({
        mode: z.literal("managed"),
        preserveAcrossBlocks: z.boolean(),
      })
      .strict(),
    instructions: z.string().max(100_000),
    skills: z
      .array(
        z
          .object({
            artifactHash: artifactHashSchema,
            name: boundedString(120),
          })
          .strict(),
      )
      .max(100),
    tools: z.array(z.enum(HARNESS_TOOL_IDS)).max(HARNESS_TOOL_IDS.length),
    mcpIntegrations: z.array(z.string()).max(0),
    credentialReferences: z
      .array(z.enum(HARNESS_CREDENTIAL_IDS))
      .max(HARNESS_CREDENTIAL_IDS.length),
  })
  .strict()
  .superRefine((manifest, context) => {
    const providerContract =
      HARNESS_PROVIDER_CONTRACTS[manifest.harness.provider];
    if (manifest.harness.packageName !== providerContract.packageName) {
      context.addIssue({
        code: "custom",
        path: ["harness", "packageName"],
        message: "Package is not in the code-owned harness catalog",
      });
    }
    if (
      !(providerContract.cliVersions as readonly string[]).includes(
        manifest.harness.cliVersion,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["harness", "cliVersion"],
        message: "CLI version is not in the code-owned harness catalog",
      });
    }
    if (
      !(providerContract.protocolVersions as readonly string[]).includes(
        manifest.harness.protocolVersion,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["harness", "protocolVersion"],
        message: "Protocol version is not in the code-owned harness catalog",
      });
    }
    if (Object.keys(manifest.model.options).length > 0) {
      context.addIssue({
        code: "custom",
        path: ["model", "options"],
        message:
          "No provider model options are supported by the current runtime",
      });
    }

    const requiredCredential =
      manifest.harness.provider === "claude" ? "anthropic" : "openai";
    if (
      manifest.credentialReferences.length !== 1 ||
      manifest.credentialReferences[0] !== requiredCredential
    ) {
      context.addIssue({
        code: "custom",
        path: ["credentialReferences"],
        message: `Only the ${requiredCredential} credential reference is supported for this harness`,
      });
    }
    if (
      manifest.tools.length !== HARNESS_TOOL_IDS.length ||
      HARNESS_TOOL_IDS.some((tool) => !manifest.tools.includes(tool))
    ) {
      context.addIssue({
        code: "custom",
        path: ["tools"],
        message:
          "The current runtime requires the complete code-owned tool set",
      });
    }
    if (!manifest.subagents.enabled && manifest.subagents.maxConcurrent !== 0) {
      context.addIssue({
        code: "custom",
        path: ["subagents", "maxConcurrent"],
        message: "Disabled subagents must have maxConcurrent set to zero",
      });
    }
    if (manifest.subagents.enabled && manifest.subagents.maxConcurrent < 1) {
      context.addIssue({
        code: "custom",
        path: ["subagents", "maxConcurrent"],
        message: "Enabled subagents require at least one concurrent subagent",
      });
    }

    const homePaths = new Set<string>();
    let homeBytes = 0;
    manifest.homeFiles.forEach((file, index) => {
      homeBytes += Buffer.byteLength(file.content);
      if (!isSafeHomePath(file.path)) {
        context.addIssue({
          code: "custom",
          path: ["homeFiles", index, "path"],
          message: "Home file path is unsafe or credential-bearing",
        });
      }
      const allowedPath =
        manifest.harness.provider === "codex"
          ? "AGENTS.md"
          : "CLAUDE.md";
      if (file.path !== allowedPath) {
        context.addIssue({
          code: "custom",
          path: ["homeFiles", index, "path"],
          message: `Only the code-owned safe home file "${allowedPath}" is supported for this harness`,
        });
      }
      if (homePaths.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: ["homeFiles", index, "path"],
          message: "Home file path is duplicated",
        });
      }
      homePaths.add(file.path);
    });
    if (homeBytes > 5 * 1024 * 1024) {
      context.addIssue({
        code: "custom",
        path: ["homeFiles"],
        message: "Home files exceed the 5 MiB profile limit",
      });
    }

    addDuplicateIssues(
      manifest.skills.map((skill) => skill.name),
      ["skills"],
      "Skill name",
      context,
    );
    addDuplicateIssues(
      manifest.skills.map((skill) => skill.artifactHash),
      ["skills"],
      "Skill artifact",
      context,
    );
    addDuplicateIssues(manifest.tools, ["tools"], "Tool", context);
    addDuplicateIssues(
      manifest.mcpIntegrations,
      ["mcpIntegrations"],
      "MCP integration",
      context,
    );
    addDuplicateIssues(
      manifest.credentialReferences,
      ["credentialReferences"],
      "Credential reference",
      context,
    );
  });

const capabilityOptionSchema = z
  .object({
    id: boundedString(80),
    name: boundedString(120),
    description: z.string().max(2_000).nullable(),
  })
  .strict();

const modelCapabilitySchema: z.ZodType<HarnessModelCapability> = z
  .object({
    id: boundedString(200),
    name: boundedString(200),
    description: z.string().max(4_000).nullable(),
    contextWindowTokens: z.number().int().positive().nullable(),
    reasoningEfforts: z.array(capabilityOptionSchema).max(20),
    defaultReasoningEffort: boundedString(80).nullable(),
    serviceTiers: z.array(capabilityOptionSchema).min(1).max(20),
    defaultServiceTier: boundedString(80).nullable(),
    verbosityOptions: z.array(capabilityOptionSchema).max(20),
    defaultVerbosity: boundedString(80).nullable(),
    compactionModes: z
      .array(
        z.enum(["model_default", "custom_threshold", "disabled"]),
      )
      .min(1)
      .max(3),
  })
  .strict();

const draftManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    displayName: boundedString(120),
    description: z.string().trim().max(2_000),
    harness: z
      .object({
        provider: z.enum(["claude", "codex"]),
        packageName: boundedString(200),
        cliVersion: boundedString(80),
        protocolVersion: boundedString(120),
      })
      .strict(),
    model: z
      .object({
        id: boundedString(200),
        reasoning: z
          .object({
            selection: boundedString(80),
            effectiveEffort: boundedString(80),
          })
          .strict(),
        serviceTier: boundedString(80),
        verbosity: boundedString(80).optional(),
        capability: modelCapabilitySchema,
        catalogHash: catalogHashSchema,
      })
      .strict(),
    homeFiles: z
      .array(
        z
          .object({
            path: boundedString(300),
            content: z.string().max(1024 * 1024),
            mode: z.literal(0o644),
          })
          .strict(),
      )
      .max(100),
    context: z
      .object({
        includeRepositoryInstructions: z.literal(true),
        includeWorkflowData: z.boolean(),
      })
      .strict(),
    compaction: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("model_default") }).strict(),
      z
        .object({
          mode: z.literal("custom_threshold"),
          thresholdPercent: z.number().int().min(1).max(99),
          thresholdTokens: z.number().int().positive(),
        })
        .strict(),
      z.object({ mode: z.literal("disabled") }).strict(),
    ]),
    subagents: z
      .object({
        enabled: z.boolean(),
        maxConcurrent: z.number().int().min(0).max(16),
      })
      .strict(),
    limits: z
      .object({
        maxDurationMs: z.number().int().positive().max(86_400_000).nullable(),
        maxTokens: z.number().int().positive().max(10_000_000).nullable(),
        maxCostUsd: z.number().finite().positive().max(100_000).nullable(),
      })
      .strict(),
    workspace: z
      .object({
        mode: z.literal("managed"),
        preserveAcrossBlocks: z.boolean(),
      })
      .strict(),
    instructions: z.string().max(100_000),
    skills: z
      .array(
        z
          .object({
            artifactHash: artifactHashSchema,
            name: boundedString(120),
          })
          .strict(),
      )
      .max(100),
    tools: z.array(z.enum(HARNESS_TOOL_IDS)).max(HARNESS_TOOL_IDS.length),
    mcpIntegrations: z.array(z.string()).max(0),
    credentialReferences: z
      .array(z.enum(HARNESS_CREDENTIAL_IDS))
      .max(HARNESS_CREDENTIAL_IDS.length),
  })
  .strict()
  .superRefine((manifest, context) => {
    const commonValidation = draftManifestSchema.safeParse({
      ...manifest,
      schemaVersion: 1,
      model: { id: manifest.model.id, options: {} },
      compaction: { mode: "provider_default" },
    });
    if (!commonValidation.success) {
      for (const issue of commonValidation.error.issues) {
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    }

    const capability = manifest.model.capability;
    if (capability.id !== manifest.model.id) {
      context.addIssue({
        code: "custom",
        path: ["model", "capability", "id"],
        message: "Capability snapshot does not match the selected model",
      });
    }
    addDuplicateIssues(
      capability.reasoningEfforts.map((option) => option.id),
      ["model", "capability", "reasoningEfforts"],
      "Reasoning effort",
      context,
    );
    addDuplicateIssues(
      capability.serviceTiers.map((option) => option.id),
      ["model", "capability", "serviceTiers"],
      "Service tier",
      context,
    );
    addDuplicateIssues(
      capability.verbosityOptions.map((option) => option.id),
      ["model", "capability", "verbosityOptions"],
      "Verbosity option",
      context,
    );
    addDuplicateIssues(
      capability.compactionModes,
      ["model", "capability", "compactionModes"],
      "Compaction mode",
      context,
    );

    const effortIds = new Set(
      capability.reasoningEfforts.map((option) => option.id),
    );
    const selectedEffort =
      manifest.model.reasoning.selection === "model_default"
        ? capability.defaultReasoningEffort
        : manifest.model.reasoning.selection;
    if (
      selectedEffort === null ||
      !effortIds.has(selectedEffort) ||
      manifest.model.reasoning.effectiveEffort !== selectedEffort
    ) {
      context.addIssue({
        code: "custom",
        path: ["model", "reasoning"],
        message:
          "Reasoning selection must resolve to an effort advertised by the selected model",
      });
    }

    if (
      !capability.serviceTiers.some(
        (option) => option.id === manifest.model.serviceTier,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["model", "serviceTier"],
        message: "Service tier is not supported by the selected model",
      });
    }

    if (
      (capability.verbosityOptions.length === 0 &&
        manifest.model.verbosity !== undefined) ||
      (manifest.model.verbosity !== undefined &&
        !capability.verbosityOptions.some(
          (option) => option.id === manifest.model.verbosity,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["model", "verbosity"],
        message: "Verbosity is not supported by the selected model",
      });
    }

    if (!capability.compactionModes.includes(manifest.compaction.mode)) {
      context.addIssue({
        code: "custom",
        path: ["compaction", "mode"],
        message: "Compaction mode is not supported by the selected model",
      });
    }
    if (manifest.compaction.mode === "custom_threshold") {
      if (capability.contextWindowTokens === null) {
        context.addIssue({
          code: "custom",
          path: ["compaction"],
          message:
            "Custom compaction requires a known model context window",
        });
      } else {
        const expectedTokens = Math.floor(
          (capability.contextWindowTokens *
            manifest.compaction.thresholdPercent) /
            100,
        );
        if (manifest.compaction.thresholdTokens !== expectedTokens) {
          context.addIssue({
            code: "custom",
            path: ["compaction", "thresholdTokens"],
            message:
              "Derived compaction token threshold does not match the selected percentage",
          });
        }
      }
    }
    if (
      manifest.harness.provider === "codex" &&
      manifest.compaction.mode === "disabled"
    ) {
      context.addIssue({
        code: "custom",
        path: ["compaction", "mode"],
        message: "Codex does not support disabling compaction",
      });
    }
    if (
      manifest.harness.provider === "claude" &&
      manifest.model.verbosity !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["model", "verbosity"],
        message: "Claude does not support response verbosity",
      });
    }
  });

function addDuplicateIssues(
  values: readonly string[],
  path: Array<string | number>,
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: `${label} is duplicated`,
      });
    }
    seen.add(value);
  });
}

function isSafeHomePath(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("\\") ||
    path.includes("\0") ||
    posix.normalize(path) !== path ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return false;
  }
  const sensitive = /(^|[._/-])(auth|credentials?|secrets?|tokens?|private[-_]?key|\.env)([._/-]|$)/i;
  return !sensitive.test(path);
}

export class HarnessProfileManifestError extends Error {
  constructor(
    message: string,
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

export function parseHarnessProfileDraftManifest(
  value: unknown,
): HarnessProfileDraftManifest {
  const parsed =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 2
      ? draftManifestV2Schema.safeParse(value)
      : draftManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new HarnessProfileManifestError(
      "Invalid harness profile manifest",
      parsed.error.issues.map((issue) => ({
        path: `/${issue.path.map(escapePointerSegment).join("/")}`,
        message: issue.message,
      })),
    );
  }
  return structuredClone(parsed.data);
}

export function compileHarnessProfileManifest(input: {
  profileId: string;
  version: number;
  slug: string;
  system: boolean;
  draft: HarnessProfileDraftManifestV1;
}): HarnessProfileManifestV1;
export function compileHarnessProfileManifest(input: {
  profileId: string;
  version: number;
  slug: string;
  system: boolean;
  draft: HarnessProfileDraftManifestV2;
}): HarnessProfileManifestV2;
export function compileHarnessProfileManifest(input: {
  profileId: string;
  version: number;
  slug: string;
  system: boolean;
  draft: HarnessProfileDraftManifest;
}): HarnessProfileManifest;
export function compileHarnessProfileManifest(input: {
  profileId: string;
  version: number;
  slug: string;
  system: boolean;
  draft: HarnessProfileDraftManifest;
}): HarnessProfileManifest {
  return {
    ...structuredClone(input.draft),
    profileId: input.profileId,
    version: input.version,
    slug: input.slug,
    system: input.system,
  };
}

export function hashHarnessProfileManifest(
  manifest: HarnessProfileManifest,
): string {
  return createHash("sha256").update(stableJson(manifest)).digest("hex");
}

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

function escapePointerSegment(segment: PropertyKey): string {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}
