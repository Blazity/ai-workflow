import type { HarnessProfileManifestV1 } from "@shared/contracts";

export interface HarnessEffectiveLimits {
  maxDurationMs: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

interface HarnessRuntimeLimits {
  manifest: Pick<HarnessProfileManifestV1, "limits">;
}

/** Apply only the profile selected for the active invocation. */
export function combineHarnessRuntimeLimits(
  workflowLimits: HarnessEffectiveLimits,
  runtime?: HarnessRuntimeLimits,
): HarnessEffectiveLimits {
  const result = { ...workflowLimits };
  if (!runtime) return result;
  const limits = runtime.manifest.limits;
  if (limits.maxDurationMs !== null) {
    result.maxDurationMs = Math.min(
      result.maxDurationMs,
      limits.maxDurationMs,
    );
  }
  if (limits.maxTokens !== null) {
    result.maxTokens =
      result.maxTokens === undefined
        ? limits.maxTokens
        : Math.min(result.maxTokens, limits.maxTokens);
  }
  if (limits.maxCostUsd !== null) {
    result.maxCostUsd =
      result.maxCostUsd === undefined
        ? limits.maxCostUsd
        : Math.min(result.maxCostUsd, limits.maxCostUsd);
  }
  return result;
}
