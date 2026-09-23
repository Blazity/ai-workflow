import { integrationManifests } from "@integrations/registry";
import type { IntegrationState } from "@shared/contracts";
import {
  deploymentIntegrations,
  type DeploymentIntegrations,
} from "../engine/definition/integration-availability.js";

/**
 * What a test says its deployment's integrations are.
 *
 * Every caller that decides with integration state now takes that state as a
 * value, so a test states its deployment in one line instead of standing up the
 * modules between it and a database. The alternative this replaces was worse
 * than verbose: the suite passed only while the generated registry was empty,
 * so the first shipped integration would have turned a large part of it red for
 * reasons unrelated to the change being made.
 *
 * Nothing here reads the environment or a database on purpose: a test that
 * wants the real read asks for the connected function by name, and its name is
 * what says a database is involved.
 */

/**
 * A deployment with no integration usable, whatever this build ships, unless
 * `states` says otherwise.
 *
 * `serving` names providers of a capability outright, for a test about
 * something else that needs one served (version control, say) without
 * arranging that integration's connection: `{ vcs: ["github"] }`.
 */
export function testDeploymentIntegrations(
  states: readonly IntegrationState[] = [],
  serving: Readonly<Record<string, readonly string[]>> = {},
): DeploymentIntegrations {
  const deployment = deploymentIntegrations({
    manifests: integrationManifests,
    states: new Map(states.map((state) => [state.integrationId, state])),
  });
  return {
    ...deployment,
    providers: new Map([...deployment.providers, ...Object.entries(serving)]),
  };
}
