import {
  evaluateWorkflowValueCompatibility,
  type JsonSchema202012,
  type PromptSlotBinding,
  type PromptSlotDefinition,
  type ResolvedPromptReference,
  type WorkflowAvailableValue,
  type WorkflowDataCatalogEntry,
  type WorkflowDefinitionV2Node,
  type WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import {
  compatibilityPromptSourceForV2Node,
  type EffectivePromptCompilation,
  type EffectivePromptCompileInput,
  type EffectivePromptProfileSource,
  type EffectivePromptRepositorySource,
} from "./effective-prompt";
import {
  resolvePromptReferences,
  type PromptReferenceLoader,
} from "./prompt-references";
import {
  isPromptSlotBinding,
  parsePromptDataTokens,
} from "./prompt-slots";

const PROMPT_FIELD_BY_BLOCK = {
  planning_agent: "prompt",
  implementation_agent: "prompt",
  review_agent: "prompt",
  fix_agent: "instructions",
  generic_agent: "prompt",
} as const;

export type PromptAuthoringBlockType = keyof typeof PROMPT_FIELD_BY_BLOCK;

export interface ResolvedNodePromptAuthoring {
  compilation: EffectivePromptCompilation;
  slots: PromptSlotDefinition[];
  issues: WorkflowDefinitionValidationIssue[];
}

export interface ResolveNodePromptAuthoringInput {
  node: WorkflowDefinitionV2Node;
  nodeIndex: number;
  availableValues: readonly WorkflowAvailableValue[];
  catalogValues?: readonly WorkflowDataCatalogEntry[];
  loadPromptReference: PromptReferenceLoader;
  profileSource?: EffectivePromptProfileSource | null;
  repositorySources?: readonly EffectivePromptRepositorySource[];
  unresolvedRepositorySources?: readonly string[];
  runtimeData?: string;
  compile: (
    input: Omit<
      EffectivePromptCompileInput,
      | "resolveDataReference"
      | "inspectSlotSchema"
      | "validateSlotValue"
      | "exampleValueForSchema"
    >,
  ) => Promise<EffectivePromptCompilation>;
  areSlotSchemasCompatible: (
    source: JsonSchema202012,
    target: JsonSchema202012,
  ) => boolean;
}

export function isPromptAuthoringBlock(
  node: WorkflowDefinitionV2Node,
): node is WorkflowDefinitionV2Node & { type: PromptAuthoringBlockType } {
  return Object.prototype.hasOwnProperty.call(PROMPT_FIELD_BY_BLOCK, node.type);
}

export function promptFieldForV2Node(
  node: WorkflowDefinitionV2Node,
): "prompt" | "instructions" | null {
  return isPromptAuthoringBlock(node)
    ? PROMPT_FIELD_BY_BLOCK[node.type]
    : null;
}

export function promptSlotBindingsForV2Node(
  node: WorkflowDefinitionV2Node,
): Record<string, PromptSlotBinding> {
  const raw = node.configuration.promptSlotBindings;
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, PromptSlotBinding] =>
        isPromptSlotBinding(entry[1]),
    ),
  );
}

export function promptDataTokenIssue(
  reference: string,
  catalogByReference: ReadonlyMap<string, WorkflowDataCatalogEntry>,
  availableByReference: { has(reference: string): boolean },
): { code: string; message: string } | null {
  const catalogEntry = catalogByReference.get(
    reference as WorkflowDataCatalogEntry["reference"],
  );
  if (catalogEntry) {
    const compatibility = evaluateWorkflowValueCompatibility(
      catalogEntry,
      { kind: "mixed_text" },
    );
    if (compatibility.compatible) return null;
    return {
      code: `prompt_data_${compatibility.reason.code}`,
      message: compatibility.reason.message,
    };
  }
  return availableByReference.has(reference)
    ? null
    : {
        code: "prompt_data_unavailable",
        message:
          `Prompt data reference "${reference}" is not guaranteed when this block runs.`,
      };
}

/**
 * Resolves one unsaved/pinned v2 prompt and runs the same compiler used before
 * execution. Catalog checks happen before example substitution so preview
 * cannot make an unavailable or incompatible binding appear valid.
 */
export async function resolveNodePromptAuthoringPure(
  input: ResolveNodePromptAuthoringInput,
): Promise<ResolvedNodePromptAuthoring> {
  const field = promptFieldForV2Node(input.node);
  if (field === null) {
    throw new Error(`Block "${input.node.id}" does not compile an agent prompt`);
  }
  const authored = input.node.configuration[field];
  const source =
    typeof authored === "string"
      ? authored
      : compatibilityPromptSourceForV2Node(input.node) ?? "";
  let text = source;
  let slots: PromptSlotDefinition[] = [];
  let promptManifest: ResolvedPromptReference[] = [];
  const issues: WorkflowDefinitionValidationIssue[] = [];

  try {
    const resolved = await resolvePromptReferences(
      source,
      input.loadPromptReference,
      { requirePinned: true },
    );
    text = resolved.text;
    slots = resolved.slots;
    promptManifest = resolved.manifest;
  } catch (error) {
    issues.push(nodeIssue(
      input,
      "prompt_reference_invalid",
      field,
      error instanceof Error
        ? error.message
        : "Reusable prompt resolution failed.",
    ));
  }

  const availableByReference = new Map(
    input.availableValues.map((value) => [value.reference, value]),
  );
  const catalogByReference = new Map(
    (input.catalogValues ?? []).map((value) => [value.reference, value]),
  );
  for (const token of parsePromptDataTokens(text)) {
    const issue = promptDataTokenIssue(
      token.reference,
      catalogByReference,
      availableByReference,
    );
    if (issue) {
      issues.push(nodeIssue(
        input,
        issue.code,
        field,
        issue.message,
      ));
    }
  }

  const bindings = promptSlotBindingsForV2Node(input.node);
  const slotsByName = new Map(slots.map((slot) => [slot.name, slot]));
  for (const [name, binding] of Object.entries(bindings)) {
    if (binding.kind !== "reference") continue;
    const available = availableByReference.get(binding.reference);
    if (!available) {
      issues.push(nodeIssue(
        input,
        "prompt_slot_unavailable",
        `promptSlotBindings/${pointerSegment(name)}`,
        `Prompt slot "${name}" references "${binding.reference}", which is not guaranteed when this block runs.`,
      ));
      continue;
    }
    const slot = slotsByName.get(name);
    if (!slot) continue;
    if (!input.areSlotSchemasCompatible(available.schema, slot.schema)) {
      issues.push(nodeIssue(
        input,
        "prompt_slot_type_mismatch",
        `promptSlotBindings/${pointerSegment(name)}`,
        `Prompt slot "${name}" is not compatible with "${binding.reference}".`,
      ));
    }
  }

  const compilation = await input.compile({
    nodeId: input.node.id,
    blockPrompt: text,
    runtimeData: input.runtimeData ?? "",
    slots,
    slotBindings: input.node.configuration.promptSlotBindings,
    promptManifest,
    profileSource: input.profileSource,
    repositorySources: input.repositorySources,
    unresolvedRepositorySources: input.unresolvedRepositorySources,
    preview: true,
    dataSchemas: Object.fromEntries(
      input.availableValues.map((value) => [value.reference, value.schema]),
    ),
  });
  issues.push(
    ...compilation.issues.map((issue) =>
      prefixCompilationIssue(issue, input.nodeIndex)
    ),
  );
  return {
    compilation,
    slots,
    issues: dedupeIssues(issues),
  };
}

function nodeIssue(
  input: Pick<ResolveNodePromptAuthoringInput, "node" | "nodeIndex">,
  code: string,
  fieldPath: string,
  message: string,
): WorkflowDefinitionValidationIssue {
  return {
    code,
    severity: "error",
    nodeId: input.node.id,
    path: `/nodes/${input.nodeIndex}/configuration/${fieldPath}`,
    message,
  };
}

function prefixCompilationIssue(
  issue: WorkflowDefinitionValidationIssue,
  nodeIndex: number,
): WorkflowDefinitionValidationIssue {
  const path = issue.path?.startsWith("/configuration")
    ? `/nodes/${nodeIndex}${issue.path}`
    : issue.path;
  return { ...issue, ...(path === undefined ? {} : { path }) };
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
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
