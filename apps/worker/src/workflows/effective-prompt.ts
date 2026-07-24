import {
  DEFAULT_AGENT_PROMPTS,
  DEFAULT_FIX_PROMPT,
  containsMalformedPromptDataToken,
  containsMalformedPromptReference,
  containsMalformedPromptSlotToken,
  builtinHarnessProfileReference,
  isHarnessProfileReference,
  isPromptSlotBinding,
  parsePromptDataTokens,
  parsePromptSlotTokens,
  resolveBuiltinHarnessProfile,
  type JsonSchema202012,
  type JsonValue,
  type PromptSlotBinding,
  type PromptSlotDefinition,
  type ResolvedPromptReference,
  type WorkflowDefinitionV2Node,
  type WorkflowDefinitionValidationIssue,
  type WorkflowValueSchema,
} from "@shared/contracts";
import {
  inspectJsonSchema202012,
  validateJsonSchemaValue,
} from "../workflow-definition/json-schema.js";
import {
  isJsonValue,
  resolveWorkflowDataReferenceV2,
  type V2BindingResolutionContext,
} from "../workflow-definition/v2-bindings.js";
import type { ResolvedHarnessRuntime } from "../sandbox/harness-runtime.js";

export type EffectivePromptSectionKind =
  | "profile"
  | "repository"
  | "block"
  | "runtime";

export interface EffectivePromptProvenance {
  kind: "profile" | "repository" | "prompt" | "runtime";
  id: string;
  version: number | null;
  hash: string;
}

export interface EffectivePromptSection {
  kind: EffectivePromptSectionKind;
  title: string;
  content: string;
  hash: string;
  provenance: EffectivePromptProvenance[];
}

export interface EffectivePromptUnresolvedSource {
  kind: "profile" | "repository" | "data" | "slot";
  reference: string;
  message: string;
}

/** Generic PR4 seam. PR5 may resolve the same shape from persisted profiles. */
export interface EffectivePromptProfileSource {
  profileId: string;
  version: number;
  name: string;
  instructions: string;
  hash?: string;
}

export interface ResolveProfileInstructionsInput {
  node: WorkflowDefinitionV2Node;
  /** Virtual compatibility profile for migrated PR2/PR3 v2 definitions. */
  defaultProvider?: "claude" | "codex";
}

export type ResolveProfileInstructions = (
  input: ResolveProfileInstructionsInput,
) => Promise<EffectivePromptProfileSource | null>;

export function effectivePromptProfileSource(
  runtime: ResolvedHarnessRuntime,
): EffectivePromptProfileSource {
  const instructions = [
    runtime.manifest.instructions,
    ...runtime.manifest.homeFiles.map(
      (file) =>
        `<profile-home-file path="${file.path}">\n${file.content}\n</profile-home-file>`,
    ),
  ]
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
  return {
    profileId: runtime.manifest.profileId,
    version: runtime.manifest.version,
    name: runtime.manifest.displayName,
    instructions,
    hash: runtime.manifestHash,
  };
}

/**
 * Compatibility resolver until the code-owned built-in profile manifests are
 * connected. Callers still receive explicit unresolved provenance.
 */
export const resolveProfileInstructions: ResolveProfileInstructions =
  async ({ node, defaultProvider }) => {
    const reference = node.configuration.harnessProfile;
    const resolvedReference = isHarnessProfileReference(reference)
      ? reference
      : reference === undefined
        ? builtinHarnessProfileReference(
            node.configuration.provider === "claude" ||
              node.configuration.provider === "codex"
              ? node.configuration.provider
              : defaultProvider ?? "codex",
          )
        : null;
    if (!resolvedReference) return null;
    const manifest = resolveBuiltinHarnessProfile(resolvedReference);
    if (!manifest) return null;
    return {
      profileId: manifest.profileId,
      version: manifest.version,
      name: manifest.displayName,
      instructions: manifest.instructions,
    };
  };

export interface EffectivePromptRepositorySource {
  repository: string;
  path: "AGENTS.md" | "CLAUDE.md";
  content: string;
  hash?: string;
}

export interface EffectivePromptCompileInput {
  nodeId: string;
  blockPrompt: string;
  runtimeData: string;
  slots?: readonly PromptSlotDefinition[];
  slotBindings?: unknown;
  promptManifest?: readonly ResolvedPromptReference[];
  profileSource?: EffectivePromptProfileSource | null;
  repositorySources?: readonly EffectivePromptRepositorySource[];
  unresolvedRepositorySources?: readonly string[];
  bindingContext?: V2BindingResolutionContext;
  /** Preview substitutes schema-derived examples for runtime-only values. */
  preview?: boolean;
  dataSchemas?: Readonly<Record<string, JsonSchema202012>>;
}

export interface EffectivePromptCompilation {
  prompt: string;
  hash: string;
  sections: EffectivePromptSection[];
  provenance: EffectivePromptProvenance[];
  unresolvedSources: EffectivePromptUnresolvedSource[];
  issues: WorkflowDefinitionValidationIssue[];
}

const MAX_SECTION_LENGTH = 200_000;
/**
 * PR2/PR3 v2 snapshots predate explicit Harness Profile and prompt pinning.
 * Only those profile-less specialized blocks retain their former code-owned
 * role prompt. Newly authored/pinned v2 blocks must persist their prompt.
 */
export function compatibilityPromptSourceForV2Node(
  node: WorkflowDefinitionV2Node,
): string | null {
  if (node.configuration.harnessProfile !== undefined) return null;
  switch (node.type) {
    case "planning_agent":
      return DEFAULT_AGENT_PROMPTS["research-plan"];
    case "implementation_agent":
      return DEFAULT_AGENT_PROMPTS.implement;
    case "review_agent":
      return DEFAULT_AGENT_PROMPTS.review;
    case "fix_agent":
      return DEFAULT_FIX_PROMPT;
    default:
      return null;
  }
}

export async function compileEffectivePrompt(
  input: EffectivePromptCompileInput,
): Promise<EffectivePromptCompilation> {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const unresolvedSources: EffectivePromptUnresolvedSource[] = [];
  const slotBindings = parseSlotBindings(input, issues);
  const slotDefinitions = coalesceSlotDefinitions(
    input,
    slotBindings,
    issues,
  );
  let blockPrompt = resolvePromptData(
    input.blockPrompt,
    input,
    issues,
    unresolvedSources,
  );
  blockPrompt = resolvePromptSlots(
    blockPrompt,
    slotDefinitions,
    slotBindings,
    input,
    issues,
    unresolvedSources,
  );
  if (blockPrompt.trim().length === 0) {
    issues.push(issue(
      input.nodeId,
      "prompt_empty",
      "/configuration/prompt",
      "The block role and task prompt cannot be empty.",
    ));
  }
  if (
    containsMalformedPromptReference(blockPrompt) ||
    /\{\{\s*prompt\s*:/i.test(blockPrompt)
  ) {
    issues.push(issue(
      input.nodeId,
      "prompt_reference_unresolved",
      "/configuration/prompt",
      "The prompt contains an unresolved reusable-prompt reference.",
    ));
  }
  if (containsResidualMustache(blockPrompt)) {
    issues.push(issue(
      input.nodeId,
      "prompt_placeholder_unresolved",
      "/configuration/prompt",
      "The prompt contains an unresolved placeholder.",
    ));
  }

  const sections: EffectivePromptSection[] = [];
  if (input.profileSource) {
    sections.push(await section(
      "profile",
      `Harness Profile: ${input.profileSource.name}`,
      input.profileSource.instructions,
      [{
        kind: "profile",
        id: input.profileSource.profileId,
        version: input.profileSource.version,
        hash:
          input.profileSource.hash ??
          await hashText(input.profileSource.instructions),
      }],
    ));
  } else {
    unresolvedSources.push({
      kind: "profile",
      reference: `node:${input.nodeId}`,
      message: "Harness Profile instructions are resolved at runtime.",
    });
  }

  for (const source of input.repositorySources ?? []) {
    const contentHash = source.hash ?? await hashText(source.content);
    sections.push(await section(
      "repository",
      `${source.repository}/${source.path}`,
      source.content,
      [{
        kind: "repository",
        id: `${source.repository}/${source.path}`,
        version: null,
        hash: contentHash,
      }],
    ));
  }
  for (const reference of input.unresolvedRepositorySources ?? []) {
    unresolvedSources.push({
      kind: "repository",
      reference,
      message: "Repository instructions are available only with a prepared workspace.",
    });
  }

  const promptProvenance = (input.promptManifest ?? []).map(
    (entry): EffectivePromptProvenance => ({
      kind: "prompt",
      id: `${entry.promptId}:${entry.promptName}`,
      version: entry.resolvedVersion,
      hash: entry.bodyHash,
    }),
  );
  sections.push(await section(
    "block",
    "Block role and task",
    blockPrompt,
    promptProvenance,
  ));
  if (input.runtimeData.trim().length > 0) {
    const runtimeHash = await hashText(input.runtimeData);
    sections.push(await section(
      "runtime",
      "Runtime data",
      input.runtimeData,
      [{
        kind: "runtime",
        id: `node:${input.nodeId}`,
        version: null,
        hash: runtimeHash,
      }],
    ));
  }

  const prompt = sections.map(renderSection).join("\n\n");
  const provenance = sections.flatMap((entry) => entry.provenance);
  return {
    prompt,
    hash: await hashText(prompt),
    sections,
    provenance,
    unresolvedSources: dedupeUnresolved(unresolvedSources),
    issues: dedupeIssues(issues),
  };
}

function parseSlotBindings(
  input: EffectivePromptCompileInput,
  issues: WorkflowDefinitionValidationIssue[],
): Record<string, PromptSlotBinding> {
  if (input.slotBindings === undefined) return {};
  if (
    input.slotBindings === null ||
    typeof input.slotBindings !== "object" ||
    Array.isArray(input.slotBindings)
  ) {
    issues.push(issue(
      input.nodeId,
      "prompt_slot_bindings_invalid",
      "/configuration/promptSlotBindings",
      "Prompt slot bindings must be an object keyed by slot name.",
    ));
    return {};
  }
  const bindings: Record<string, PromptSlotBinding> = {};
  for (const [name, binding] of Object.entries(input.slotBindings)) {
    if (!isPromptSlotBinding(binding)) {
      issues.push(issue(
        input.nodeId,
        "prompt_slot_binding_invalid",
        `/configuration/promptSlotBindings/${escapePointer(name)}`,
        `Prompt slot "${name}" has an invalid binding.`,
      ));
      continue;
    }
    bindings[name] = binding;
  }
  return bindings;
}

function coalesceSlotDefinitions(
  input: EffectivePromptCompileInput,
  bindings: Readonly<Record<string, PromptSlotBinding>>,
  issues: WorkflowDefinitionValidationIssue[],
): Map<string, PromptSlotDefinition> {
  const definitions = new Map<string, PromptSlotDefinition>();
  for (const definition of input.slots ?? []) {
    const existing = definitions.get(definition.name);
    if (
      existing &&
      stableJson(existing as unknown as JsonValue) !==
        stableJson(definition as unknown as JsonValue)
    ) {
      issues.push(issue(
        input.nodeId,
        "prompt_slot_conflict",
        `/configuration/promptSlotBindings/${escapePointer(definition.name)}`,
        `Reusable prompts declare conflicting definitions for slot "${definition.name}".`,
      ));
      continue;
    }
    definitions.set(definition.name, definition);
  }
  for (const name of Object.keys(bindings)) {
    if (!definitions.has(name)) {
      issues.push(issue(
        input.nodeId,
        "prompt_slot_unknown_binding",
        `/configuration/promptSlotBindings/${escapePointer(name)}`,
        `Prompt slot binding "${name}" has no matching slot declaration.`,
      ));
    }
  }
  return definitions;
}

function resolvePromptSlots(
  text: string,
  definitions: ReadonlyMap<string, PromptSlotDefinition>,
  bindings: Readonly<Record<string, PromptSlotBinding>>,
  input: EffectivePromptCompileInput,
  issues: WorkflowDefinitionValidationIssue[],
  unresolvedSources: EffectivePromptUnresolvedSource[],
): string {
  if (containsMalformedPromptSlotToken(text)) {
    issues.push(issue(
      input.nodeId,
      "prompt_slot_malformed",
      "/configuration/prompt",
      "The prompt contains a malformed slot token.",
    ));
  }
  const resolved = new Map<string, JsonValue | undefined>();
  for (const [name, definition] of definitions) {
    const parsedSchema = inspectJsonSchema202012(definition.schema);
    if (!parsedSchema.ok) {
      issues.push(issue(
        input.nodeId,
        "prompt_slot_schema_invalid",
        `/configuration/promptSlotBindings/${escapePointer(name)}`,
        `Prompt slot "${name}" has an invalid JSON Schema: ${parsedSchema.issues[0]?.message ?? "unknown error"}`,
      ));
      continue;
    }
    let value: unknown;
    const binding = bindings[name];
    if (binding?.kind === "literal") {
      value = structuredClone(binding.value);
    } else if (binding?.kind === "reference") {
      if (input.bindingContext) {
        try {
          const candidate = resolveWorkflowDataReferenceV2(
            binding.reference,
            input.bindingContext,
          );
          if (!isJsonValue(candidate)) {
            throw new Error("Resolved slot value is not JSON-compatible");
          }
          value = candidate;
        } catch {
          issues.push(issue(
            input.nodeId,
            "prompt_slot_unavailable",
            `/configuration/promptSlotBindings/${escapePointer(name)}`,
            `Prompt slot "${name}" could not resolve "${binding.reference}" at runtime.`,
          ));
          continue;
        }
      } else if (input.preview) {
        value = exampleValueForJsonSchema(definition.schema);
        unresolvedSources.push({
          kind: "slot",
          reference: binding.reference,
          message: `Prompt slot "${name}" uses a runtime-only value.`,
        });
      }
    } else if (Object.prototype.hasOwnProperty.call(definition, "defaultValue")) {
      value = structuredClone(definition.defaultValue);
    }

    if (value === undefined) {
      if (definition.required) {
        issues.push(issue(
          input.nodeId,
          "prompt_slot_missing",
          `/configuration/promptSlotBindings/${escapePointer(name)}`,
          `Required prompt slot "${name}" has no binding or default.`,
        ));
      }
      resolved.set(name, undefined);
      continue;
    }
    if (
      definition.required &&
      (
        value === null ||
        (typeof value === "string" && value.trim().length === 0)
      )
    ) {
      issues.push(issue(
        input.nodeId,
        "prompt_slot_empty",
        `/configuration/promptSlotBindings/${escapePointer(name)}`,
        `Required prompt slot "${name}" cannot be null or blank.`,
      ));
      continue;
    }
    const valueIssues = validateJsonSchemaValue(definition.schema, value);
    if (valueIssues.length > 0) {
      issues.push(issue(
        input.nodeId,
        "prompt_slot_type_mismatch",
        `/configuration/promptSlotBindings/${escapePointer(name)}`,
        `Prompt slot "${name}" does not match its JSON Schema: ${valueIssues[0]!.message}`,
      ));
      continue;
    }
    resolved.set(name, value as JsonValue);
  }

  const tokens = parsePromptSlotTokens(text);
  return replaceTokens(text, tokens, (token) => {
    const definition = definitions.get(token.name);
    if (!definition) {
      issues.push(issue(
        input.nodeId,
        "prompt_slot_unknown",
        "/configuration/prompt",
        `Prompt token "${token.name}" has no slot declaration.`,
      ));
      return token.raw;
    }
    const value = resolved.get(token.name);
    return value === undefined ? "" : serializePromptValue(value);
  });
}

function resolvePromptData(
  text: string,
  input: EffectivePromptCompileInput,
  issues: WorkflowDefinitionValidationIssue[],
  unresolvedSources: EffectivePromptUnresolvedSource[],
): string {
  if (containsMalformedPromptDataToken(text)) {
    issues.push(issue(
      input.nodeId,
      "prompt_data_malformed",
      "/configuration/prompt",
      "The prompt contains a malformed data token.",
    ));
  }
  const tokens = parsePromptDataTokens(text);
  return replaceTokens(text, tokens, (token) => {
    if (input.bindingContext) {
      try {
        const value = resolveWorkflowDataReferenceV2(
          token.reference,
          input.bindingContext,
        );
        if (!isJsonValue(value)) {
          throw new Error("Resolved prompt value is not JSON-compatible");
        }
        return serializePromptValue(value);
      } catch {
        issues.push(issue(
          input.nodeId,
          "prompt_data_unavailable",
          "/configuration/prompt",
          `Prompt data reference "${token.reference}" is unavailable at runtime.`,
        ));
        return token.raw;
      }
    }
    if (input.preview) {
      const schema = input.dataSchemas?.[token.reference];
      unresolvedSources.push({
        kind: "data",
        reference: token.reference,
        message: "Prompt data is resolved when this block runs.",
      });
      return serializePromptValue(
        schema
          ? exampleValueForJsonSchema(schema)
          : `<runtime:${token.reference}>`,
      );
    }
    return token.raw;
  });
}

export function exampleValueForJsonSchema(
  schema: JsonSchema202012,
): JsonValue {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return structuredClone(schema.enum[0] as JsonValue);
  }
  const inspected = inspectJsonSchema202012(schema);
  if (!inspected.ok) return null;
  return exampleFromValueSchema(inspected.valueSchema);
}

function exampleFromValueSchema(schema: WorkflowValueSchema): JsonValue {
  if (schema.enum && schema.enum.length > 0) {
    return structuredClone(schema.enum[0] as JsonValue);
  }
  switch (schema.type) {
    case "string":
      return "example";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "null":
    case "unknown":
      return null;
    case "nullable":
      return exampleFromValueSchema(schema.value);
    case "array":
      return [exampleFromValueSchema(schema.items)];
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties).map(([name, child]) => [
          name,
          exampleFromValueSchema(child),
        ]),
      );
  }
}

function serializePromptValue(value: JsonValue): string {
  return typeof value === "string" ? value : stableJson(value);
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(",")}}`;
}

async function section(
  kind: EffectivePromptSectionKind,
  title: string,
  content: string,
  provenance: EffectivePromptProvenance[],
): Promise<EffectivePromptSection> {
  const sanitized = sanitizeSectionContent(content);
  return {
    kind,
    title: neutralizeSectionSentinels(title)
      .replace(/[\r\n]+/g, " ")
      .trim(),
    content: sanitized,
    hash: await hashText(sanitized),
    provenance,
  };
}

function sanitizeSectionContent(content: string): string {
  return neutralizeSectionSentinels(content)
    .replaceAll("\0", "\uFFFD")
    .slice(0, MAX_SECTION_LENGTH);
}

function neutralizeSectionSentinels(content: string): string {
  return content.replace(/<<<AI_WORKFLOW_/gi, "\u2039\u2039\u2039AI_WORKFLOW_");
}

function containsResidualMustache(content: string): boolean {
  return content.includes("{{") || content.includes("}}");
}

function renderSection(section: EffectivePromptSection): string {
  const marker = section.kind.toUpperCase();
  return [
    `<<<AI_WORKFLOW_${marker}_BEGIN: ${section.title}>>>`,
    section.content,
    `<<<AI_WORKFLOW_${marker}_END>>>`,
  ].join("\n");
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function replaceTokens<T extends { start: number; end: number }>(
  text: string,
  tokens: readonly T[],
  replace: (token: T) => string,
): string {
  let output = "";
  let cursor = 0;
  for (const token of tokens) {
    output += text.slice(cursor, token.start);
    output += replace(token);
    cursor = token.end;
  }
  return output + text.slice(cursor);
}

function issue(
  nodeId: string,
  code: string,
  path: string,
  message: string,
): WorkflowDefinitionValidationIssue {
  return { code, severity: "error", nodeId, path, message };
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function dedupeUnresolved(
  sources: EffectivePromptUnresolvedSource[],
): EffectivePromptUnresolvedSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.kind}\0${source.reference}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeIssues(
  issues: WorkflowDefinitionValidationIssue[],
): WorkflowDefinitionValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((entry) => {
    const key = `${entry.code}\0${entry.path ?? ""}\0${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
