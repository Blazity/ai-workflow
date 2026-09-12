"use client";

import type { WorkflowRepositoryScope } from "@shared/contracts";
import { pinnedRepositories } from "@/lib/workflow-editor/repository-scope";

import { splitPins, useRepositoryCatalog } from "./repository-catalog-context";
import { pinnedNotEnabledSentence } from "./repository-scope-modal";

/**
 * What deploying this workflow is about to mean for its pins.
 *
 * `workflows.publish` returns this finding as `pinnedRepositoriesNotEnabled`
 * (apps/worker/src/mcp/tools/workflow-authoring.ts). The REST deploy route the
 * dashboard calls does not carry it yet, so it is computed here from the same
 * catalog state the picker reads, with the publish's own sentence: an operator
 * who deploys from the editor and an agent that publishes over MCP have to be
 * told the same thing in the same words. Stage W moves the source to the deploy
 * response; nothing else about this component changes when it does.
 *
 * Only the activated case is announced. While the bridge is on the pin still
 * works, which the picker says on the row, and a deploy button shouting about a
 * refusal that has not happened teaches an operator to ignore it.
 */
export function DeployPinWarning({ scope }: { scope: WorkflowRepositoryScope }) {
  const catalog = useRepositoryCatalog();
  const { notEnabled } = splitPins(catalog, pinnedRepositories(scope));
  if (!catalog.activated || notEnabled.length === 0) return null;
  return (
    <span
      role="status"
      title={pinnedNotEnabledSentence(notEnabled)}
      className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-amber-800"
    >
      {notEnabled.length} pinned{" "}
      {notEnabled.length === 1 ? "repository" : "repositories"} not enabled in
      the catalog
    </span>
  );
}
