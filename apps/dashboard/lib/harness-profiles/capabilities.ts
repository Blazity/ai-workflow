import type {
  HarnessProfileCapabilities,
  HarnessProfileManifestV1,
  HarnessToolId,
  WorkflowBlockType,
} from "@shared/contracts";
import { HARNESS_TOOL_IDS } from "@shared/contracts";

const TOOL_CATALOG = new Set<string>(HARNESS_TOOL_IDS);

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

/**
 * Dashboard mirror of the worker's code-owned block safety envelope. The
 * worker remains authoritative at execution; this helper only makes clipping
 * visible before a workflow is saved.
 */
export function previewHarnessCapabilities(input: {
  nodeType: WorkflowBlockType;
  workspaceMode?: unknown;
  manifest: HarnessProfileManifestV1;
}): HarnessProfileCapabilities {
  const requestedTools = uniqueSorted(input.manifest.tools);
  const tools = requestedTools.filter(
    (tool): tool is HarnessToolId =>
      TOOL_CATALOG.has(tool),
  );
  const clippedTools = requestedTools.filter((tool) => !tools.includes(tool as HarnessToolId));
  const requestedMcpIntegrations = uniqueSorted(
    input.manifest.mcpIntegrations,
  );
  const requestedSubagents = input.manifest.subagents.enabled;
  // The current provider adapters do not expose a stable, versioned switch
  // that can enforce both enablement and concurrency. Match the worker by
  // showing the declaration as clipped until that catalog grows.
  const subagentsEnabled = false;

  return {
    requestedTools,
    tools,
    clippedTools,
    requestedMcpIntegrations,
    mcpIntegrations: [],
    clippedMcpIntegrations: [...requestedMcpIntegrations],
    subagents: {
      requested: requestedSubagents,
      enabled: subagentsEnabled,
      maxConcurrent: subagentsEnabled
        ? input.manifest.subagents.maxConcurrent
        : 0,
      clipped: requestedSubagents !== subagentsEnabled,
    },
  };
}
