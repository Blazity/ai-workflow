import {
  isHarnessProfileReference,
  type JsonSchema202012,
  type JsonValue,
  type WorkflowDefinitionV2Node,
  type WorkflowValueSchema,
} from "@shared/contracts";
import {
  builtinHarnessProfileReference,
  resolveBuiltinHarnessProfile,
} from "@shared/harness";
import {
  compileEffectivePrompt as compileSharedEffectivePrompt,
  type EffectivePromptCompilation,
  type EffectivePromptCompileInput as SharedEffectivePromptCompileInput,
  type EffectivePromptProfileSource,
} from "@shared/prompts";
import {
  inspectJsonSchema202012,
  validateJsonSchemaValue,
} from "../../workflow-definition/json-schema.js";
import {
  isJsonValue,
  resolveWorkflowDataReferenceV2,
  type V2BindingResolutionContext,
} from "@shared/workflow-graph";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";

export type {
  EffectivePromptCompilation,
  EffectivePromptMemorySource,
  EffectivePromptProfileSource,
  EffectivePromptRepositorySource,
} from "@shared/prompts";
export { compatibilityPromptSourceForV2Node } from "@shared/prompts";

interface ResolveProfileInstructionsInput {
  node: WorkflowDefinitionV2Node;
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

export interface EffectivePromptCompileInput extends Omit<
  SharedEffectivePromptCompileInput,
  | "resolveDataReference"
  | "inspectSlotSchema"
  | "validateSlotValue"
  | "exampleValueForSchema"
> {
  bindingContext?: V2BindingResolutionContext;
}

export function compileEffectivePrompt(
  input: EffectivePromptCompileInput,
): Promise<EffectivePromptCompilation> {
  const { bindingContext, ...sharedInput } = input;
  return compileSharedEffectivePrompt({
    ...sharedInput,
    resolveDataReference: bindingContext
      ? (reference) => {
          const value = resolveWorkflowDataReferenceV2(reference, bindingContext);
          if (!isJsonValue(value)) {
            throw new Error("Resolved prompt value is not JSON-compatible");
          }
          return value;
        }
      : undefined,
    inspectSlotSchema: (schema) => {
      const inspected = inspectJsonSchema202012(schema);
      return inspected.ok
        ? { ok: true }
        : { ok: false, message: inspected.issues[0]?.message };
    },
    validateSlotValue: validateJsonSchemaValue,
    exampleValueForSchema: exampleValueForJsonSchema,
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
