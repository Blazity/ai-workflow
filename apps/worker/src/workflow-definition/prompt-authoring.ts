import {
  containsMalformedPromptDataToken,
  containsMalformedPromptSlotToken,
  isPromptSlotBinding,
  parsePromptDataTokens,
  parsePromptSlotTokens,
  type PromptSlotBinding,
  type PromptSlotDefinition,
  type ResolvedPromptReference,
  type WorkflowAvailableValue,
  type WorkflowDefinition,
  type WorkflowDefinitionV2,
  type WorkflowDefinitionV2Node,
  type WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import type { Db } from "../db/client.js";
import { createPromptReferenceLoader } from "../prompt-library/store.js";
import {
  compatibilityPromptSourceForV2Node,
  compileEffectivePrompt,
  type EffectivePromptCompilation,
  type EffectivePromptProfileSource,
  type EffectivePromptRepositorySource,
} from "../workflows/effective-prompt.js";
import {
  resolvePromptReferences,
  type PromptReferenceLoader,
} from "../workflows/prompt-references.js";
import { VARIABLE_PARAM_KEYS } from "../workflows/prompt-vars.js";
import { analyzeWorkflowV2Bindings } from "./available-values.js";
import { isWorkflowSchemaAssignable } from "./bindings.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import {
  inspectJsonSchema202012,
} from "./json-schema.js";
import {
  validateWorkflowDefinitionCandidate,
  type WorkflowDefinitionCandidateValidation,
} from "./validation.js";

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
  loadPromptReference: PromptReferenceLoader;
  profileSource?: EffectivePromptProfileSource | null;
  repositorySources?: readonly EffectivePromptRepositorySource[];
  unresolvedRepositorySources?: readonly string[];
  runtimeData?: string;
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

/**
 * Resolves one unsaved/pinned v2 prompt and runs the same compiler used before
 * execution. Catalog checks happen before example substitution so preview
 * cannot make an unavailable or incompatible binding appear valid.
 */
export async function resolveNodePromptAuthoring(
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
  for (const token of parsePromptDataTokens(text)) {
    if (availableByReference.has(token.reference)) continue;
    issues.push(nodeIssue(
      input,
      "prompt_data_unavailable",
      field,
      `Prompt data reference "${token.reference}" is not guaranteed when this block runs.`,
    ));
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
    const sourceSchema = inspectJsonSchema202012(available.schema);
    const targetSchema = inspectJsonSchema202012(slot.schema);
    if (
      !sourceSchema.ok ||
      !targetSchema.ok ||
      !isWorkflowSchemaAssignable(
        sourceSchema.valueSchema,
        targetSchema.valueSchema,
      )
    ) {
      issues.push(nodeIssue(
        input,
        "prompt_slot_type_mismatch",
        `promptSlotBindings/${pointerSegment(name)}`,
        `Prompt slot "${name}" is not compatible with "${binding.reference}".`,
      ));
    }
  }

  const compilation = await compileEffectivePrompt({
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

export async function validateWorkflowPromptAuthoringIssues(
  db: Db,
  definition: WorkflowDefinition,
  registryContext?: WorkflowBlockRegistryContext,
): Promise<WorkflowDefinitionValidationIssue[]> {
  if (definition.schemaVersion !== 2) return [];
  const context =
    registryContext ??
    (await import("./models.js")).workflowBlockRegistryContextFromEnv();
  return validateWorkflowPromptAuthoringIssuesWithLoader(
    definition,
    context,
    createPromptReferenceLoader(db),
  );
}

export async function validateWorkflowPromptAuthoringIssuesWithLoader(
  definition: WorkflowDefinitionV2,
  registryContext: WorkflowBlockRegistryContext,
  loadPromptReference: PromptReferenceLoader,
): Promise<WorkflowDefinitionValidationIssue[]> {
  const analysis = analyzeWorkflowV2Bindings(definition, registryContext);
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of definition.nodes.entries()) {
    const availableValues = analysis.availableValuesByNode[node.id] ?? [];
    if (isPromptAuthoringBlock(node)) {
      const result = await resolveNodePromptAuthoring({
        node,
        nodeIndex,
        availableValues,
        loadPromptReference,
      });
      issues.push(...result.issues);
      continue;
    }
    if ((VARIABLE_PARAM_KEYS[node.type]?.length ?? 0) > 0) {
      issues.push(
        ...await validateNonAgentPromptAuthoring({
          node,
          nodeIndex,
          availableValues,
          loadPromptReference,
        }),
      );
    }
  }
  return dedupeIssues(issues);
}

async function validateNonAgentPromptAuthoring(
  input: ResolveNodePromptAuthoringInput,
): Promise<WorkflowDefinitionValidationIssue[]> {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const availableByReference = new Set(
    input.availableValues.map((value) => value.reference),
  );
  for (const field of VARIABLE_PARAM_KEYS[input.node.type] ?? []) {
    const authored = input.node.configuration[field];
    const values =
      typeof authored === "string"
        ? [{ text: authored, path: field }]
        : Array.isArray(authored)
          ? authored.flatMap((value, index) =>
              typeof value === "string"
                ? [{ text: value, path: `${field}/${index}` }]
                : []
            )
          : [];
    for (const value of values) {
      let resolved: Awaited<ReturnType<typeof resolvePromptReferences>>;
      try {
        resolved = await resolvePromptReferences(
          value.text,
          input.loadPromptReference,
          { requirePinned: true },
        );
      } catch (error) {
        issues.push(nodeIssue(
          input,
          "prompt_reference_invalid",
          value.path,
          error instanceof Error
            ? error.message
            : "Reusable prompt resolution failed.",
        ));
        continue;
      }

      if (
        resolved.slots.length > 0 ||
        containsMalformedPromptSlotToken(resolved.text) ||
        parsePromptSlotTokens(resolved.text).length > 0
      ) {
        issues.push(nodeIssue(
          input,
          input.node.type === "call_llm"
            ? "call_llm_prompt_slots_unsupported"
            : "prompt_slots_unsupported",
          value.path,
          "Prompt slots are supported only by Agent blocks.",
        ));
      }
      if (containsMalformedPromptDataToken(resolved.text)) {
        issues.push(nodeIssue(
          input,
          "prompt_data_malformed",
          value.path,
          "The prompt contains a malformed data token.",
        ));
      }
      const dataTokens = parsePromptDataTokens(resolved.text);
      for (const token of dataTokens) {
        if (availableByReference.has(token.reference)) continue;
        issues.push(nodeIssue(
          input,
          "prompt_data_unavailable",
          value.path,
          `Prompt data reference "${token.reference}" is not guaranteed when this block runs.`,
        ));
      }
      const residual = removePromptDataTokens(resolved.text, dataTokens);
      if (residual.includes("{{") || residual.includes("}}")) {
        issues.push(nodeIssue(
          input,
          "prompt_placeholder_unresolved",
          value.path,
          "The prompt contains an unresolved placeholder.",
        ));
      }
    }
  }
  return dedupeIssues(issues);
}

function removePromptDataTokens(
  text: string,
  tokens: ReturnType<typeof parsePromptDataTokens>,
): string {
  let output = "";
  let cursor = 0;
  for (const token of tokens) {
    output += text.slice(cursor, token.start);
    cursor = token.end;
  }
  return output + text.slice(cursor);
}

export async function validateWorkflowDefinitionCandidateWithPromptAuthoring(
  db: Db,
  candidate: unknown,
  registryContext?: WorkflowBlockRegistryContext,
): Promise<WorkflowDefinitionCandidateValidation> {
  const context =
    registryContext ??
    (await import("./models.js")).workflowBlockRegistryContextFromEnv();
  const base = validateWorkflowDefinitionCandidate(candidate, context);
  if (base.parsed?.schemaVersion !== 2) return base;
  const promptIssues = await validateWorkflowPromptAuthoringIssues(
    db,
    base.parsed,
    context,
  );
  const issues = dedupeIssues([...base.response.issues, ...promptIssues]);
  return {
    parsed: base.parsed,
    response: {
      ...base.response,
      valid: issues.length === 0,
      issues,
    },
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
