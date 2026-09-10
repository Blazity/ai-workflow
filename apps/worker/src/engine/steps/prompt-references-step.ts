import type {
  PromptSlotDefinition,
  ResolvedPromptReference,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";

import { VARIABLE_PARAM_KEYS } from "../helpers/prompt-vars.js";
import {
  coalescePromptSlotDefinitions,
  resolvePromptReferences,
  type LoadedPromptReference,
  type PromptReferenceLoader,
} from "../helpers/prompt-references.js";

export interface ResolvedWorkflowPromptReferences {
  nodes: WorkflowDefinitionNode[];
  manifest: ResolvedPromptReference[];
  manifestByNode: Record<string, ResolvedPromptReference[]>;
  slotsByNode: Record<string, PromptSlotDefinition[]>;
}

export interface ResolvePromptReferencesInNodesOptions {
  requirePinned?: boolean;
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
): Promise<ResolvedWorkflowPromptReferences> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { createPromptReferenceLoader } = await import(
    "../../prompt-library/store.js"
  );
  const db = getDb();

  return resolvePromptReferencesInNodes(
    nodes,
    createPromptReferenceLoader(db),
    { requirePinned: true },
  );
}
resolvePromptReferencesForRun.maxRetries = 0;
