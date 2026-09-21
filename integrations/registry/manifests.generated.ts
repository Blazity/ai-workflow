// THIS FILE IS GENERATED. DO NOT EDIT.
// Run pnpm run gen:integrations to update.

/**
 * The manifest of every integration this build ships.
 *
 * Plain data: the dashboard reads it in a browser and the Workflow DevKit
 * reads it inside the flow bundle, so this file imports manifest entries
 * only. Worker entries are in ./runtimes.generated.ts, behind a separate
 * module of this package.
 */
import type { IntegrationManifest } from "@integrations/sdk";
import { manifest as arthur } from "../arthur/manifest";
import { manifest as gitlab } from "../gitlab/manifest";
import { manifest as slack } from "../slack/manifest";

export const generatedIntegrationManifests: readonly IntegrationManifest[] = [
  arthur,
  gitlab,
  slack,
];

/**
 * Which of the above are fixtures, generated in behind INTEGRATION_FIXTURES.
 *
 * Empty in every committed registry and in every deployed build. It exists
 * so a check about what this build SHIPS can tell the two apart: the
 * connection-shape guard is committed against the real registry, and a local
 * fixture run must not read as a shape change nobody made.
 */
export const generatedIntegrationFixtureIds: readonly string[] = [];
