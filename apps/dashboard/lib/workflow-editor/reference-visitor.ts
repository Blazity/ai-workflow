import {
  formatPromptDataToken,
  parsePromptDataTokens,
  WORKFLOW_PROMPT_PARAM_KEYS,
  type JsonValue,
  type WorkflowBindingSource,
  type WorkflowDataReferenceV2,
  type WorkflowInputBindingV2,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";

export interface WorkflowReferenceOccurrence {
  reference: string;
  path: string;
}

function pointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Remap only the source node segment; the output path remains byte-identical. */
export function remapWorkflowDataReference(
  reference: WorkflowDataReferenceV2,
  nodeIdMap: ReadonlyMap<string, string>,
): WorkflowDataReferenceV2;
export function remapWorkflowDataReference(
  reference: WorkflowBindingSource,
  nodeIdMap: ReadonlyMap<string, string>,
): WorkflowBindingSource;
export function remapWorkflowDataReference(
  reference: string,
  nodeIdMap: ReadonlyMap<string, string>,
): string;
export function remapWorkflowDataReference(
  reference: string,
  nodeIdMap: ReadonlyMap<string, string>,
): string {
  const segments = reference.split(".");
  if (
    segments[0] !== "steps" ||
    segments.length < 3 ||
    segments[2] !== "output" ||
    segments[1] === "entry"
  ) {
    return reference;
  }
  const replacement = nodeIdMap.get(segments[1]!);
  if (!replacement) return reference;
  segments[1] = replacement;
  return segments.join(".");
}

export function workflowReferenceSourceNodeId(
  reference: string,
): string | null {
  const segments = reference.split(".");
  return segments[0] === "steps" &&
    segments.length >= 3 &&
    segments[2] === "output" &&
    segments[1] !== "entry"
    ? (segments[1] ?? null)
    : null;
}

export function remapPromptDataTokens(
  source: string,
  nodeIdMap: ReadonlyMap<string, string>,
): string {
  const tokens = parsePromptDataTokens(source);
  if (tokens.length === 0) return source;
  let result = source;
  for (const token of [...tokens].reverse()) {
    const reference = remapWorkflowDataReference(
      token.reference,
      nodeIdMap,
    ) as WorkflowDataReferenceV2;
    if (reference === token.reference) continue;
    result =
      result.slice(0, token.start) +
      formatPromptDataToken(reference) +
      result.slice(token.end);
  }
  return result;
}

interface LegacyConditionReference {
  start: number;
  end: number;
  nodeId: string;
  reference: string;
}

function isAddressableStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

function isAddressablePart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_-]/.test(character);
}

/**
 * Find v1 Branch paths while skipping quoted literals. This deliberately does
 * not normalize the expression, so copied drafts retain their original source.
 */
function legacyConditionReferences(source: string): LegacyConditionReference[] {
  const found: LegacyConditionReference[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === "'" || character === '"') {
      const quote = character;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (
      !source.startsWith("steps.", index) ||
      isAddressablePart(source[index - 1])
    ) {
      index += 1;
      continue;
    }
    const nodeStart = index + "steps.".length;
    if (!isAddressableStart(source[nodeStart])) {
      index += 1;
      continue;
    }
    let cursor = nodeStart + 1;
    while (isAddressablePart(source[cursor])) cursor += 1;
    if (!source.startsWith(".output", cursor)) {
      index += 1;
      continue;
    }
    cursor += ".output".length;
    while (source[cursor] === ".") {
      const segmentStart = cursor + 1;
      if (!isAddressableStart(source[segmentStart])) break;
      cursor = segmentStart + 1;
      while (isAddressablePart(source[cursor])) cursor += 1;
    }
    found.push({
      start: index,
      end: cursor,
      nodeId: source.slice(nodeStart, source.indexOf(".output", nodeStart)),
      reference: source.slice(index, cursor),
    });
    index = cursor;
  }
  return found;
}

export function remapLegacyBranchCondition(
  source: string,
  nodeIdMap: ReadonlyMap<string, string>,
): string {
  const references = legacyConditionReferences(source);
  let result = source;
  for (const occurrence of [...references].reverse()) {
    const replacement = nodeIdMap.get(occurrence.nodeId);
    if (!replacement) continue;
    const relativeNodeStart = "steps.".length;
    const relativeOutputStart = occurrence.reference.indexOf(
      ".output",
      relativeNodeStart,
    );
    const remapped =
      occurrence.reference.slice(0, relativeNodeStart) +
      replacement +
      occurrence.reference.slice(relativeOutputStart);
    result =
      result.slice(0, occurrence.start) +
      remapped +
      result.slice(occurrence.end);
  }
  return result;
}

function remapBinding(
  binding: WorkflowInputBindingV2,
  nodeIdMap: ReadonlyMap<string, string>,
): WorkflowInputBindingV2 {
  return binding.kind === "reference"
    ? {
        ...binding,
        reference: remapWorkflowDataReference(
          binding.reference,
          nodeIdMap,
        ) as WorkflowDataReferenceV2,
      }
    : structuredClone(binding);
}

function isJsonRecord(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return value !== undefined && value !== null &&
    typeof value === "object" && !Array.isArray(value);
}

function remapBranchCondition(
  value: JsonValue,
  nodeIdMap: ReadonlyMap<string, string>,
): JsonValue {
  if (!isJsonRecord(value) || typeof value.kind !== "string") {
    return structuredClone(value);
  }
  if (value.kind === "path" && typeof value.reference === "string") {
    return {
      ...structuredClone(value),
      reference: remapWorkflowDataReference(
        value.reference,
        nodeIdMap,
      ),
    };
  }
  if (value.kind === "lit") {
    return structuredClone(value);
  }
  if (value.kind === "not" && value.operand !== undefined) {
    return {
      ...structuredClone(value),
      operand: remapBranchCondition(value.operand, nodeIdMap),
    };
  }
  if (
    (value.kind === "and" ||
      value.kind === "or" ||
      value.kind === "eq" ||
      value.kind === "neq") &&
    value.left !== undefined &&
    value.right !== undefined
  ) {
    return {
      ...structuredClone(value),
      left: remapBranchCondition(value.left, nodeIdMap),
      right: remapBranchCondition(value.right, nodeIdMap),
    };
  }
  return structuredClone(value);
}

function remapPromptSlotBindings(
  value: JsonValue,
  nodeIdMap: ReadonlyMap<string, string>,
): JsonValue {
  if (!isJsonRecord(value)) return structuredClone(value);
  return Object.fromEntries(
    Object.entries(value).map(([name, binding]) => {
      if (
        isJsonRecord(binding) &&
        binding.kind === "reference" &&
        typeof binding.reference === "string"
      ) {
        return [
          name,
          {
            ...structuredClone(binding),
            reference: remapWorkflowDataReference(
              binding.reference,
              nodeIdMap,
            ),
          },
        ];
      }
      return [name, structuredClone(binding)];
    }),
  );
}

function remapV2Configuration(
  node: FlowNodeDef,
  nodeIdMap: ReadonlyMap<string, string>,
): Record<string, JsonValue> {
  if (!node.v2) return {};
  const configuration = structuredClone(node.v2.configuration);
  for (const key of WORKFLOW_PROMPT_PARAM_KEYS[node.type] ?? []) {
    const value = configuration[key];
    if (typeof value === "string") {
      configuration[key] = remapPromptDataTokens(value, nodeIdMap);
    } else if (Array.isArray(value)) {
      configuration[key] = value.map((entry) =>
        typeof entry === "string"
          ? remapPromptDataTokens(entry, nodeIdMap)
          : structuredClone(entry),
      );
    }
  }
  if (node.type === "branch" && Array.isArray(configuration.conditions)) {
    configuration.conditions = configuration.conditions.map((condition) =>
      isJsonRecord(condition) && typeof condition.reference === "string"
        ? {
            ...condition,
            reference: remapWorkflowDataReference(
              condition.reference,
              nodeIdMap,
            ),
          }
        : structuredClone(condition),
    );
  }
  if (node.type === "transform") {
    if (typeof configuration.source === "string") {
      configuration.source = remapWorkflowDataReference(
        configuration.source,
        nodeIdMap,
      );
    }
    if (typeof configuration.template === "string") {
      configuration.template = remapPromptDataTokens(
        configuration.template,
        nodeIdMap,
      );
    }
    if (Array.isArray(configuration.fields)) {
      configuration.fields = configuration.fields.map((field) => {
        if (!isJsonRecord(field) || !isJsonRecord(field.value)) {
          return structuredClone(field);
        }
        if (
          field.value.kind === "reference" &&
          typeof field.value.reference === "string"
        ) {
          return {
            ...field,
            value: {
              ...field.value,
              reference: remapWorkflowDataReference(
                field.value.reference,
                nodeIdMap,
              ),
            },
          };
        }
        return structuredClone(field);
      });
    }
  }
  if (configuration.promptSlotBindings !== undefined) {
    configuration.promptSlotBindings = remapPromptSlotBindings(
      configuration.promptSlotBindings,
      nodeIdMap,
    );
  }
  return configuration;
}

/** One visitor covers all persisted reference carriers used by v1 and v2. */
export function remapFlowNodeReferences(
  source: FlowNodeDef,
  nodeIdMap: ReadonlyMap<string, string>,
): FlowNodeDef {
  const node = structuredClone(source);
  node.inputs = Object.fromEntries(
    Object.entries(node.inputs).map(([name, reference]) => [
      name,
      remapWorkflowDataReference(reference, nodeIdMap) as WorkflowBindingSource,
    ]),
  );
  node.params = Object.fromEntries(
    Object.entries(node.params).map(([name, value]) => {
      const promptBearing = (
        WORKFLOW_PROMPT_PARAM_KEYS[node.type] ?? []
      ).includes(name);
      if (typeof value === "string" && promptBearing) {
        const remappedTokens = remapPromptDataTokens(value, nodeIdMap);
        return [name, remappedTokens];
      }
      if (Array.isArray(value) && promptBearing) {
        return [
          name,
          value.map((entry) => remapPromptDataTokens(entry, nodeIdMap)),
        ];
      }
      if (
        node.type === "branch" &&
        name === "condition" &&
        typeof value === "string"
      ) {
        return [name, remapLegacyBranchCondition(value, nodeIdMap)];
      }
      return [name, value];
    }),
  );
  if (node.v2) {
    node.v2.inputs = Object.fromEntries(
      Object.entries(node.v2.inputs).map(([name, binding]) => [
        name,
        remapBinding(binding, nodeIdMap),
      ]),
    );
    node.v2.additionalInputs = node.v2.additionalInputs.map((input) => ({
      ...input,
      schema: structuredClone(input.schema),
      binding: remapBinding(input.binding, nodeIdMap),
    }));
    node.v2.configuration = remapV2Configuration(node, nodeIdMap);
  }
  return node;
}

function collectPromptTokens(
  value: string,
  path: string,
  found: WorkflowReferenceOccurrence[],
): void {
  for (const token of parsePromptDataTokens(value)) {
    found.push({ reference: token.reference, path });
  }
}

function collectBranchConditionReferences(
  value: JsonValue,
  path: string,
  found: WorkflowReferenceOccurrence[],
): void {
  if (!isJsonRecord(value) || typeof value.kind !== "string") {
    return;
  }
  if (value.kind === "path" && typeof value.reference === "string") {
    found.push({
      reference: value.reference,
      path: `${path}/reference`,
    });
    return;
  }
  if (value.kind === "lit") {
    return;
  }
  if (value.kind === "not" && value.operand !== undefined) {
    collectBranchConditionReferences(
      value.operand,
      `${path}/operand`,
      found,
    );
    return;
  }
  if (
    (value.kind === "and" ||
      value.kind === "or" ||
      value.kind === "eq" ||
      value.kind === "neq") &&
    value.left !== undefined &&
    value.right !== undefined
  ) {
    collectBranchConditionReferences(value.left, `${path}/left`, found);
    collectBranchConditionReferences(value.right, `${path}/right`, found);
  }
}

function collectPromptSlotBindingReferences(
  value: JsonValue,
  path: string,
  found: WorkflowReferenceOccurrence[],
): void {
  if (!isJsonRecord(value)) return;
  for (const [name, binding] of Object.entries(value)) {
    if (
      isJsonRecord(binding) &&
      binding.kind === "reference" &&
      typeof binding.reference === "string"
    ) {
      found.push({
        reference: binding.reference,
        path: `${path}/${pointerSegment(name)}/reference`,
      });
    }
  }
}

export function collectFlowNodeReferences(
  node: FlowNodeDef,
): WorkflowReferenceOccurrence[] {
  const found: WorkflowReferenceOccurrence[] = [];
  for (const [name, reference] of Object.entries(node.inputs)) {
    found.push({
      reference,
      path: `/inputs/${pointerSegment(name)}`,
    });
  }
  for (const [name, value] of Object.entries(node.params)) {
    const serializedInV2Configuration =
      node.v2 &&
      Object.prototype.hasOwnProperty.call(node.v2.configuration, name);
    if (serializedInV2Configuration) continue;
    const path = `/params/${pointerSegment(name)}`;
    const promptBearing = (
      WORKFLOW_PROMPT_PARAM_KEYS[node.type] ?? []
    ).includes(name);
    if (typeof value === "string" && promptBearing) {
      collectPromptTokens(value, path, found);
    } else if (Array.isArray(value) && promptBearing) {
      value.forEach((entry, index) =>
        collectPromptTokens(entry, `${path}/${index}`, found),
      );
    } else if (
      node.type === "branch" &&
      name === "condition" &&
      typeof value === "string"
    ) {
      for (const reference of legacyConditionReferences(value)) {
        found.push({ reference: reference.reference, path });
      }
    }
  }
  if (!node.v2) return found;

  for (const [name, binding] of Object.entries(node.v2.inputs)) {
    if (binding.kind === "reference") {
      found.push({
        reference: binding.reference,
        path: `/inputs/${pointerSegment(name)}/reference`,
      });
    }
  }
  node.v2.additionalInputs.forEach((input, index) => {
    if (input.binding.kind === "reference") {
      found.push({
        reference: input.binding.reference,
        path: `/additionalInputs/${index}/binding/reference`,
      });
    }
  });
  for (const key of WORKFLOW_PROMPT_PARAM_KEYS[node.type] ?? []) {
    const value = node.v2.configuration[key];
    const path = `/configuration/${pointerSegment(key)}`;
    if (typeof value === "string") {
      collectPromptTokens(value, path, found);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (typeof entry === "string") {
          collectPromptTokens(entry, `${path}/${index}`, found);
        }
      });
    }
  }
  if (node.type === "branch" && Array.isArray(node.v2.configuration.conditions)) {
    node.v2.configuration.conditions.forEach((condition, index) => {
      if (isJsonRecord(condition) && typeof condition.reference === "string") {
        found.push({
          reference: condition.reference,
          path: `/configuration/conditions/${index}/reference`,
        });
      }
    });
  }
  if (node.type === "transform") {
    const configuration = node.v2.configuration;
    if (typeof configuration.source === "string") {
      found.push({
        reference: configuration.source,
        path: "/configuration/source",
      });
    }
    if (typeof configuration.template === "string") {
      collectPromptTokens(configuration.template, "/configuration/template", found);
    }
    if (Array.isArray(configuration.fields)) {
      configuration.fields.forEach((field, index) => {
        if (
          isJsonRecord(field) &&
          isJsonRecord(field.value) &&
          field.value.kind === "reference" &&
          typeof field.value.reference === "string"
        ) {
          found.push({
            reference: field.value.reference,
            path: `/configuration/fields/${index}/value/reference`,
          });
        }
      });
    }
  }
  if (node.v2.configuration.promptSlotBindings !== undefined) {
    collectPromptSlotBindingReferences(
      node.v2.configuration.promptSlotBindings,
      "/configuration/promptSlotBindings",
      found,
    );
  }
  return found;
}
