import type { BlockRunState, HarnessRunManifestRecord } from "@shared/contracts";

/**
 * The evidence a run row carries about which model it actually executed on.
 * `blockStatuses` is keyed by definition node id, exactly like the manifests'
 * `nodeId`, which is what lets a manifest be matched to a block that ran.
 */
export interface RunModelEvidence {
  /** `workflow_runs.model`, written once by the run's terminal telemetry step. */
  model: string | null;
  harnessManifests: HarnessRunManifestRecord[] | null | undefined;
  blockStatuses: Record<string, Omit<BlockRunState, "output">> | null | undefined;
}

/** A block that left "pending" has resolved its harness and started executing. */
function ranNodeIds(
  blockStatuses: RunModelEvidence["blockStatuses"],
): { ran: Set<string>; running: Set<string> } {
  const ran = new Set<string>();
  const running = new Set<string>();
  if (!blockStatuses || typeof blockStatuses !== "object") return { ran, running };
  for (const [nodeId, state] of Object.entries(blockStatuses)) {
    const status = state?.status;
    if (!status || status === "pending") continue;
    ran.add(nodeId);
    if (status === "running") running.add(nodeId);
  }
  return { ran, running };
}

function soleModel(manifests: HarnessRunManifestRecord[]): string | null {
  const ids = new Set(
    manifests
      .map((m) => m?.manifest?.model?.id)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
  );
  return ids.size === 1 ? [...ids][0]! : null;
}

/**
 * The model a run can be *shown* to have used, or null when nothing attributes
 * one. Never returns the organization-wide default: that constant is not an
 * observation of this run, and rendering it unmarked made failed runs read as if
 * they had executed on a model they never touched (AIW-253).
 *
 * Evidence, strongest first:
 *
 * 1. The harness manifest of a block that actually ran. Manifests are recorded
 *    once at run start, one per agent node, sorted by node id (agent.ts's
 *    `harnessManifests`), so the array's order says nothing about execution.
 *    `blockStatuses` does: a node that left "pending" resolved that manifest and
 *    started. A "running" node is the block executing right now, so it wins over
 *    blocks that already finished. Only used when the surviving manifests agree
 *    on one model id, because a header shows a single model and picking one of
 *    several would be a guess.
 * 2. A unanimous manifest set. Covers the common single-profile run and every
 *    row written before block statuses existed, and it is what fixes the
 *    reported bug: a run that fails or parks in its first agent phase never
 *    reaches the terminal telemetry step, so its `model` column is either null
 *    or the org default `activeModel` was seeded with (agent.ts's
 *    `activeModel ??= defaultModel`), while its manifests hold the model the
 *    sandbox really launched.
 * 3. The persisted `model` column. Ranked below the manifests precisely because
 *    it can hold that seeded default; where it is a measured terminal value (a
 *    run that completed through Implementation) the manifests either agree with
 *    it or disagree among themselves, and this is then the run's own recorded
 *    headline model.
 * 4. Nothing: a gate run, or an agent run that died before recording anything.
 *    Callers render an explicit unknown state.
 */
export function attributeRunModel(evidence: RunModelEvidence): string | null {
  const manifests = Array.isArray(evidence.harnessManifests)
    ? evidence.harnessManifests
    : [];

  if (manifests.length > 0) {
    const { ran, running } = ranNodeIds(evidence.blockStatuses);
    const scope = running.size > 0 ? running : ran;
    if (scope.size > 0) {
      const fromRan = soleModel(manifests.filter((m) => scope.has(m?.nodeId)));
      if (fromRan) return fromRan;
    }
    const unanimous = soleModel(manifests);
    if (unanimous) return unanimous;
  }

  const persisted = evidence.model?.trim();
  return persisted ? persisted : null;
}
