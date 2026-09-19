/**
 * What one run records about the integrations its graph uses, and what stops
 * it when one of them moves underneath it.
 *
 * A run pins the configuration each integration had at its start and compares
 * the pin at every later use. The comparison is only capable of saying anything
 * because the pin is a value the run carries: recomputing it from live state on
 * both sides would always agree, and `reconfigured` could never fire.
 *
 * The pin lives in the run's own workflow state rather than in a column on the
 * run row. It is read once, inside a step, so the Workflow DevKit restores it
 * on replay from the step's recorded result instead of reading the database
 * again; a run suspended across a deploy therefore comes back holding the
 * connection it started with, and finds out at its next use that the
 * connection moved. A column would have said the same thing and cost a
 * migration, and S2 left the choice here for exactly that reason.
 *
 * Pure, like the availability decision next to it: everything it reads is an
 * argument.
 */
import type {
  IntegrationConnectionPin,
  IntegrationUnavailableReason,
} from "@shared/contracts";
import {
  integrationsUsedBy,
  integrationUnavailableFailureMessage,
  integrationUnusableReason,
  type DeploymentIntegrations,
} from "./integration-availability.js";

/** Why a run may not start: the words its ticket comment will carry, and the
 *  reason behind them, so the durable record gets a code too. */
export interface RunIntegrationBlocker {
  readonly integrationId: string;
  readonly reason: IntegrationUnavailableReason;
  readonly message: string;
}

/** Why a run in flight stops here, and which of the three reasons it is. */
export interface RunIntegrationFailure {
  readonly integrationId: string;
  readonly reason: IntegrationUnavailableReason;
  readonly message: string;
}

/** The pins a run records at its start, one per integration its graph uses. */
export function integrationPinsFor(
  nodes: readonly { readonly type: string }[],
  integrations: DeploymentIntegrations,
): readonly IntegrationConnectionPin[] {
  return integrationsUsedBy(nodes, integrations).flatMap((id) => {
    const presence = integrations.byId.get(id);
    return presence ? [presence.pin] : [];
  });
}

/**
 * The first integration the graph uses that cannot run right now, or nothing.
 *
 * Checked before any work, so a workflow whose integration was disconnected
 * since it was published fails at its start with one sentence rather than
 * halfway through, after a workspace and an agent invocation nobody needed.
 */
export function runIntegrationBlocker(
  nodes: readonly { readonly type: string }[],
  integrations: DeploymentIntegrations,
): RunIntegrationBlocker | null {
  for (const id of integrationsUsedBy(nodes, integrations)) {
    const presence = integrations.byId.get(id);
    if (!presence) {
      return { integrationId: id, reason: "disconnected", message: missingFromBuild(id) };
    }
    if (presence.usable) continue;
    return {
      integrationId: id,
      // `reconfigured` cannot happen here: the run mints its pins in this same
      // read, so there is nothing yet for the fingerprint to have moved from.
      reason: presence.status === "disabled" ? "disabled" : "disconnected",
      message: integrationUnusableReason(presence),
    };
  }
  return null;
}

/**
 * Whether a run may still use the integration it pinned.
 *
 * The order is S2's, stated in ADR-010: disabled first, because an admin chose
 * it and it explains the most; then disconnected, because a disconnect also
 * moves the fingerprint and reporting `reconfigured` for it would send an admin
 * looking for an edit nobody made; then reconfigured, which is what is left.
 */
export function checkRunIntegrationUse(
  pin: IntegrationConnectionPin,
  integrations: DeploymentIntegrations,
): RunIntegrationFailure | null {
  const presence = integrations.byId.get(pin.integrationId);
  if (!presence) {
    return {
      integrationId: pin.integrationId,
      reason: "disconnected",
      message: missingFromBuild(pin.integrationId),
    };
  }
  const reason = unavailableReason(pin, presence.status, presence.pin.configFingerprint);
  if (!reason) return null;
  return {
    integrationId: pin.integrationId,
    reason,
    message: integrationUnavailableFailureMessage({
      integrationName: presence.name,
      reason,
      status: presence.status,
      failure: presence.failure ?? undefined,
    }),
  };
}

function unavailableReason(
  pin: IntegrationConnectionPin,
  status: string,
  currentFingerprint: string,
): IntegrationUnavailableReason | null {
  if (status === "disabled") return "disabled";
  if (status !== "connected") return "disconnected";
  if (currentFingerprint !== pin.configFingerprint) return "reconfigured";
  return null;
}

/** A deployment that has stopped shipping the integration a run pinned. It reads
 *  as disconnected, which is what it is from the run's side: nothing here can
 *  reach that provider any more. */
function missingFromBuild(integrationId: string): string {
  return `This deployment no longer ships the integration "${integrationId}", so the run stopped at its next use of it.`;
}
