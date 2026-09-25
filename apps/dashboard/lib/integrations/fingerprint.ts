import type { IntegrationDto } from "@shared/contracts";

/**
 * What a screen showing an integration was rendered from, reduced to the facts
 * a person would see change: switched on or off, where its values come from,
 * whether it is connected or failing, which saved version is in use, and the
 * non-secret values a run pins. Two reads of an integration nobody touched give
 * the same string; a save, a disconnect, a switch of source or the kill switch
 * gives another.
 *
 * Pure and free of any browser or server import, because both sides compute
 * it: the cockpit layout on the server for what the sidebar was rendered from,
 * and the tab a person comes back to for what the server says now.
 */
export function integrationFingerprint(integration: IntegrationDto): string {
  const { state } = integration;
  return JSON.stringify([
    integration.id,
    state.enabled,
    state.source,
    state.status,
    state.connection,
    state.usable,
    state.stored.latestVersion,
    state.stored.activeVersion,
    state.pin.configFingerprint,
  ]);
}

/** The same for a whole list, independent of the order it arrived in. */
export function integrationsFingerprint(integrations: readonly IntegrationDto[]): string {
  return JSON.stringify(integrations.map(integrationFingerprint).sort());
}
