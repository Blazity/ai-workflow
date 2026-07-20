import type {
  PromptReferenceSelector,
  ResolvedPromptReference,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import { VARIABLE_PARAM_KEYS } from "./prompt-vars.js";
import {
  resolvePromptReferences,
  type LoadedPromptReference,
  type PromptReferenceLoader,
} from "./prompt-references.js";

export interface ResolvedWorkflowPromptReferences {
  nodes: WorkflowDefinitionNode[];
  manifest: ResolvedPromptReference[];
}

export async function resolvePromptReferencesInNodes(
  nodes: readonly WorkflowDefinitionNode[],
  load: PromptReferenceLoader,
): Promise<ResolvedWorkflowPromptReferences> {
  const loadCache = new Map<string, Promise<LoadedPromptReference>>();
  const cachedLoad: PromptReferenceLoader = (promptId, requestedVersion) => {
    const key = `${promptId}@${requestedVersion}`;
    let pending = loadCache.get(key);
    if (!pending) {
      pending = load(promptId, requestedVersion);
      loadCache.set(key, pending);
    }
    return pending;
  };
  const manifest = new Map<string, ResolvedPromptReference>();

  const nextNodes: WorkflowDefinitionNode[] = [];
  for (const node of nodes) {
    const keys = VARIABLE_PARAM_KEYS[node.type];
    if (!keys) {
      nextNodes.push(node);
      continue;
    }
    let changed = false;
    const params: Record<string, WorkflowParamValue> = { ...node.params };
    for (const key of keys) {
      const value = node.params[key];
      if (typeof value === "string") {
        const resolved = await resolvePromptReferences(value, cachedLoad);
        for (const entry of resolved.manifest) {
          manifest.set(`${entry.promptId}@${entry.requestedVersion}`, entry);
        }
        if (resolved.text !== value) {
          params[key] = resolved.text;
          changed = true;
        }
      } else if (Array.isArray(value)) {
        let arrayChanged = false;
        const next = [] as string[];
        for (const item of value) {
          const resolved = await resolvePromptReferences(item, cachedLoad);
          for (const entry of resolved.manifest) {
            manifest.set(`${entry.promptId}@${entry.requestedVersion}`, entry);
          }
          next.push(resolved.text);
          if (resolved.text !== item) arrayChanged = true;
        }
        if (arrayChanged) {
          params[key] = next;
          changed = true;
        }
      }
    }
    nextNodes.push(changed ? { ...node, params } : node);
  }
  return { nodes: nextNodes, manifest: [...manifest.values()] };
}

export async function resolvePromptReferencesForRun(
  nodes: WorkflowDefinitionNode[],
): Promise<ResolvedWorkflowPromptReferences> {
  "use step";
  const { getDb } = await import("../db/client.js");
  const {
    getCurrentPromptVersion,
    getPrompt,
    getPromptVersion,
  } = await import("../prompt-library/store.js");
  const db = getDb();

  const load: PromptReferenceLoader = async (
    promptId: number,
    requestedVersion: PromptReferenceSelector,
  ) => {
    const prompt = await getPrompt(db, promptId);
    if (!prompt) throw new Error(`Prompt ${promptId} does not exist`);
    if (requestedVersion === "latest" && prompt.archivedAt !== null) {
      throw new Error(`Prompt ${promptId} (${prompt.name}) is archived and cannot follow latest`);
    }
    const version = requestedVersion === "latest"
      ? await getCurrentPromptVersion(db, promptId)
      : await getPromptVersion(db, promptId, requestedVersion);
    if (!version) {
      const label = requestedVersion === "latest" ? "a current version" : `version ${requestedVersion}`;
      throw new Error(`Prompt ${promptId} (${prompt.name}) does not have ${label}`);
    }
    return {
      promptId,
      promptName: prompt.name,
      requestedVersion,
      resolvedVersion: version.version,
      body: version.body,
    };
  };

  return resolvePromptReferencesInNodes(nodes, load);
}
resolvePromptReferencesForRun.maxRetries = 0;
