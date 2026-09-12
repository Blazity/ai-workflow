"use client";

import type { WorkflowRepositoryScope } from "@shared/contracts";
import { pinnedRepositoriesNotEnabledSentence } from "@shared/contracts";
import { pinnedRepositories } from "@/lib/workflow-editor/repository-scope";

import { splitPins, useRepositoryCatalog } from "./repository-catalog-context";

/**
 * What deploying this workflow is about to mean for its pins.
 *
 * This is the badge BEFORE the click, so there is no deploy response to read:
 * it is computed from the same catalog state the picker reads. What it no
 * longer owns is the wording. `pinnedRepositoriesNotEnabledSentence` is the one
 * copy, shared with `workflows.publish` and with the deploy confirmation, so an
 * operator deploying from the editor and an agent publishing over MCP are told
 * the same thing in the same words.
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
      title={pinnedRepositoriesNotEnabledSentence(
        notEnabled.map((repository) => `${repository.provider}:${repository.repoPath}`),
      )}
      className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-amber-800"
    >
      {notEnabled.length} pinned{" "}
      {notEnabled.length === 1 ? "repository" : "repositories"} not enabled in
      the catalog
    </span>
  );
}
