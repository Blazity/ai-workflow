import type { HarnessProfileManifestV1 } from "@shared/contracts";

export interface HarnessEffectiveLimits {
  maxDurationMs: number;
  maxDurationSource?: "definition" | "env" | "profile";
  maxDurationProfileName?: string;
  maxTokens?: number;
  maxCostUsd?: number;
}

interface HarnessRuntimeLimits {
  manifest: Pick<HarnessProfileManifestV1, "displayName" | "limits">;
}

/** Apply only the profile selected for the active invocation. */
export function combineHarnessRuntimeLimits(
  workflowLimits: HarnessEffectiveLimits,
  runtime?: HarnessRuntimeLimits,
): HarnessEffectiveLimits {
  const result = { ...workflowLimits };
  if (!runtime) return result;
  const limits = runtime.manifest.limits;
  if (
    limits.maxDurationMs !== null &&
    limits.maxDurationMs < result.maxDurationMs
  ) {
    result.maxDurationMs = limits.maxDurationMs;
    result.maxDurationSource = "profile";
    result.maxDurationProfileName = runtime.manifest.displayName;
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
