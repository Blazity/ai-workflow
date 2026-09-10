import type { PromptReferenceSelector } from "@shared/contracts";
import type { BuiltInPromptName } from "./builtin-prompts";

export type BuiltInPromptPinSource =
  | "deployed"
  | "fresh_install_default"
  | "approval"
  | "trigger_delivery"
  | "manual_dispatch";

export type BuiltInPromptAuthorship = "platform" | "customer";

export interface WorkflowDefinitionCoordinates {
  definitionId: number;
  definitionName: string;
  definitionVersion: number | null;
  source: BuiltInPromptPinSource;
  nodeId: string;
  field: string;
}

export interface BuiltInPromptPin extends WorkflowDefinitionCoordinates {
  slug: string;
  promptName: BuiltInPromptName;
  requestedVersion: PromptReferenceSelector;
  resolvedVersion: number;
  authorship: BuiltInPromptAuthorship;
  matchesConstant: boolean;
  resyncCovered: boolean;
}

export interface UnresolvedPromptReference extends WorkflowDefinitionCoordinates {
  target: string;
  requestedVersion: PromptReferenceSelector;
  reason: string;
}

export interface SkippedWalkTarget {
  reason:
    | "definition_version_missing"
    | "definition_shape"
    | "definition_has_no_nodes"
    | "node_shape"
    | "unknown_node_type"
    | "prompt_keys_unknown"
    | "node_container_missing";
  definitionId: number;
  definitionVersion: number | null;
  source: BuiltInPromptPinSource;
  nodeId: string | null;
  detail: string;
}

export interface BuiltInPromptDriftReport {
  pins: BuiltInPromptPin[];
  drift: BuiltInPromptPin[];
  unfixableDrift: BuiltInPromptPin[];
  customerAuthored: BuiltInPromptPin[];
  unresolved: UnresolvedPromptReference[];
  definitionsWalked: number;
  skipped: SkippedWalkTarget[];
}

export function describeBuiltInPromptDrift(
  report: BuiltInPromptDriftReport,
): string {
  const lines = [
    ...report.drift.map(
      (pin) =>
        `${pin.slug}@${pin.resolvedVersion} reached by definition ${pin.definitionId} ` +
        `("${pin.definitionName}" ${
          pin.definitionVersion === null
            ? "code default"
            : `v${pin.definitionVersion}`
        }, via ${pin.source}) block "${pin.nodeId}" field "${pin.field}": ` +
        `stored body differs from DEFAULT_AGENT_PROMPTS.`,
    ),
    ...report.unfixableDrift.map(
      (pin) =>
        `${pin.slug}@${pin.resolvedVersion} drifted and no resync migration can ` +
        `correct it: its prompt row is archived or not platform-owned.`,
    ),
    ...report.skipped.map(
      (skip) =>
        `NOT WALKED (${skip.reason}) definition ${skip.definitionId} ` +
        `${skip.definitionVersion === null ? "code default" : `v${skip.definitionVersion}`} ` +
        `via ${skip.source}${skip.nodeId === null ? "" : ` block "${skip.nodeId}"`}: ${skip.detail}`,
    ),
  ];
  return lines.join("\n");
}
