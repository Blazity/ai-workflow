import type { IntegrationDto } from "@shared/contracts";

import { CkChip } from "@/components/ui";
import { integrationBadges, type IntegrationTone } from "@/lib/integrations/presentation";

/** The chip tones the cockpit already ships, named by what they mean here. */
export const STATUS_CHIP_TONES: Record<IntegrationTone, "success" | "failed" | "neutral" | "blocked"> = {
  success: "success",
  failed: "failed",
  quiet: "blocked",
  off: "neutral",
};

/**
 * The status, the qualifier that keeps it honest, and where the values in use
 * come from: the same three facts on the list card and on the connection
 * screen, so the two never describe one integration differently.
 */
export function StatusBadges({ integration }: { integration: IntegrationDto }) {
  const badges = integrationBadges(integration);
  return (
    <>
      <CkChip tone={STATUS_CHIP_TONES[badges.status.tone]}>{badges.status.label}</CkChip>
      {badges.qualifier && <CkChip tone={badges.qualifier.tone}>{badges.qualifier.label}</CkChip>}
      {badges.source && (
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-600">
          {badges.source}
        </span>
      )}
    </>
  );
}
