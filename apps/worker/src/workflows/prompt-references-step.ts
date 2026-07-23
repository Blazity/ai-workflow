import type {
  PromptSlotDefinition,
  ResolvedPromptReference,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import {
  containsMalformedPromptSlotToken,
  DEFAULT_PROMPT_NAME_BY_AGENT,
  formatPromptReferenceToken,
  parsePromptSlotTokens,
} from "@shared/contracts";
import { VARIABLE_PARAM_KEYS } from "./prompt-vars.js";
import {
  coalescePromptSlotDefinitions,
  resolvePromptReferences,
  type LoadedPromptReference,
  type PromptReferenceLoader,
} from "./prompt-references.js";

export interface ResolvedWorkflowPromptReferences {
  nodes: WorkflowDefinitionNode[];
  manifest: ResolvedPromptReference[];
  manifestByNode: Record<string, ResolvedPromptReference[]>;
  slotsByNode: Record<string, PromptSlotDefinition[]>;
}

export interface ResolvePromptReferencesInNodesOptions {
  requirePinned?: boolean;
  rejectSlotTokens?: boolean;
}

export interface ImplicitDefaultPromptRow {
  id: number;
  slug: string;
  name: string;
  archivedAt: Date | null;
}

export function materializeImplicitDefaultPromptReferences(
  nodes: readonly WorkflowDefinitionNode[],
  promptRows: readonly ImplicitDefaultPromptRow[],
): WorkflowDefinitionNode[] {
  return nodes.map((node) => {
    const name = DEFAULT_PROMPT_NAME_BY_AGENT[node.type];
    if (!name) return node;
    const current = node.params.prompt;
    if (typeof current === "string" && current.trim().length > 0) return node;

    const matchingRows = promptRows.filter((candidate) => candidate.name === name);
    const activeRow = matchingRows.find((candidate) => candidate.archivedAt === null);
    if (!activeRow) {
      const state = matchingRows.length > 0 ? "archived" : "missing";
      throw new Error(`Default prompt "${name}" is ${state}`);
    }
    return {
      ...node,
      params: {
        ...node.params,
        prompt: formatPromptReferenceToken({ slug: activeRow.slug, version: "latest" }),
      },
    };
  });
}

export async function resolvePromptReferencesInNodes(
  nodes: readonly WorkflowDefinitionNode[],
  load: PromptReferenceLoader,
  options: ResolvePromptReferencesInNodesOptions = {},
): Promise<ResolvedWorkflowPromptReferences> {
  const loadCache = new Map<string, Promise<LoadedPromptReference>>();
  const cachedLoad: PromptReferenceLoader = (target, requestedVersion) => {
    const key = `${target.slug ?? `#${target.legacyPromptId}`}@${requestedVersion}`;
    let pending = loadCache.get(key);
    if (!pending) {
      pending = load(target, requestedVersion);
      loadCache.set(key, pending);
    }
    return pending;
  };
  const manifest = new Map<string, ResolvedPromptReference>();
  const manifestByNode: Record<string, ResolvedPromptReference[]> = {};
  const slotsByNode: Record<string, PromptSlotDefinition[]> = {};

  const nextNodes: WorkflowDefinitionNode[] = [];
  for (const node of nodes) {
    const keys = VARIABLE_PARAM_KEYS[node.type];
    if (!keys) {
      nextNodes.push(node);
      continue;
    }
    let changed = false;
    const params: Record<string, WorkflowParamValue> = { ...node.params };
    const nodeManifest = new Map<string, ResolvedPromptReference>();
    let nodeSlots: PromptSlotDefinition[] = [];
    for (const key of keys) {
      const value = node.params[key];
      if (typeof value === "string") {
        const resolved = await resolvePromptReferences(value, cachedLoad, {
          requirePinned: options.requirePinned,
        });
        for (const entry of resolved.manifest) {
          manifest.set(`${entry.promptId}@${entry.requestedVersion}`, entry);
          nodeManifest.set(
            `${entry.promptId}@${entry.requestedVersion}`,
            entry,
          );
        }
        nodeSlots = coalescePromptSlotDefinitions([
          ...nodeSlots,
          ...resolved.slots,
        ]);
        assertAllowedSlotTokens(resolved.text, options);
        if (resolved.text !== value) {
          params[key] = resolved.text;
          changed = true;
        }
      } else if (Array.isArray(value)) {
        let arrayChanged = false;
        const next = [] as string[];
        for (const item of value) {
          const resolved = await resolvePromptReferences(item, cachedLoad, {
            requirePinned: options.requirePinned,
          });
          for (const entry of resolved.manifest) {
            manifest.set(`${entry.promptId}@${entry.requestedVersion}`, entry);
            nodeManifest.set(
              `${entry.promptId}@${entry.requestedVersion}`,
              entry,
            );
          }
          nodeSlots = coalescePromptSlotDefinitions([
            ...nodeSlots,
            ...resolved.slots,
          ]);
          assertAllowedSlotTokens(resolved.text, options);
          next.push(resolved.text);
          if (resolved.text !== item) arrayChanged = true;
        }
        if (arrayChanged) {
          params[key] = next;
          changed = true;
        }
      }
    }
    manifestByNode[node.id] = [...nodeManifest.values()];
    slotsByNode[node.id] = nodeSlots;
    nextNodes.push(changed ? { ...node, params } : node);
  }
  return {
    nodes: nextNodes,
    manifest: [...manifest.values()],
    manifestByNode,
    slotsByNode,
  };
}

export async function resolvePromptReferencesForRun(
  nodes: WorkflowDefinitionNode[],
  schemaVersion: 1 | 2 = 1,
): Promise<ResolvedWorkflowPromptReferences> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const { createPromptReferenceLoader, findPromptRowsByNames } =
    await import("../prompt-library/store.js");
  const db = getDb();

  const requiredDefaultNames = schemaVersion === 1
    ? [...new Set(
        nodes
          .filter((node) => {
            const current = node.params.prompt;
            return DEFAULT_PROMPT_NAME_BY_AGENT[node.type]
              && !(typeof current === "string" && current.trim().length > 0);
          })
          .map((node) => DEFAULT_PROMPT_NAME_BY_AGENT[node.type]!),
      )]
    : [];
  const promptRows = await findPromptRowsByNames(db, requiredDefaultNames);
  const materializedNodes =
    schemaVersion === 1
      ? materializeImplicitDefaultPromptReferences(nodes, promptRows)
      : nodes;

  return resolvePromptReferencesInNodes(
    materializedNodes,
    createPromptReferenceLoader(db),
    schemaVersion === 2
      ? { requirePinned: true }
      : { rejectSlotTokens: true },
  );
}
resolvePromptReferencesForRun.maxRetries = 0;

function assertAllowedSlotTokens(
  text: string,
  options: ResolvePromptReferencesInNodesOptions,
): void {
  if (
    options.rejectSlotTokens &&
    (
      containsMalformedPromptSlotToken(text) ||
      parsePromptSlotTokens(text).length > 0
    )
  ) {
    throw new Error(
      "Prompt slot tokens require a v2 workflow with explicit slot bindings",
    );
  }
}
