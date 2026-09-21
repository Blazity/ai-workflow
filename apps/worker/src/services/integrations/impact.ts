import { integrationManifest, integrationManifests } from "@integrations/registry";
import type { IntegrationManifest } from "@integrations/sdk";
import {
  DashboardAuthError,
  type IntegrationConnectionSaveRequest,
  type IntegrationImpactPreviewRequest,
  type IntegrationImpactPreviewResponse,
  type IntegrationState,
  type WorkflowDefinition,
  canManageIntegrations,
} from "@shared/contracts";

import { createConnectedPostgresRunRegistry } from "../../db/repositories/active-runs.js";
import {
  readConnectedIntegrationConnections,
  type StoredIntegrationConnection,
  type StoredIntegrationVersion,
} from "../../db/repositories/integrations.js";
import { readConnectedRunDetailRow } from "../../db/repositories/runs.js";
import {
  deploymentIntegrations,
  integrationsUsedBy,
  type DeploymentIntegrations,
} from "../../engine/definition/integration-availability.js";
import { integrationSecretDigest } from "./resolve.js";
import {
  environmentReaderFrom,
  integrationConfigFingerprint,
  normalizeConnectionValue,
  resolveIntegrationState,
} from "./resolve.js";
import { secretsKeyMaterial, type IntegrationActor } from "./authoring.js";

export interface ImpactDefinitionInput {
  readonly id: number;
  readonly name: string;
  readonly definition: WorkflowDefinition;
}

/**
 * The exact reach calculation a run uses, applied to enabled deployed graphs.
 * Keeping this function data-only makes the critical core-capability case easy
 * to pin without arranging a database.
 */
export async function summarizeIntegrationImpact(input: {
  readonly integrationId: string;
  readonly changesFingerprint: boolean;
  readonly definitions: readonly ImpactDefinitionInput[];
  readonly integrations: DeploymentIntegrations;
  readonly countInFlightRuns: (definitionIds: number[]) => Promise<number>;
  readonly repositories?: readonly { provider: string; path: string }[];
}): Promise<IntegrationImpactPreviewResponse> {
  const enabledDefinitions = input.definitions
    .filter((entry) =>
      integrationsUsedBy(entry.definition.nodes, input.integrations).includes(
        input.integrationId,
      ),
    )
    .map(({ id, name }) => ({ id, name }));
  const inFlightRuns = input.changesFingerprint
    ? await input.countInFlightRuns(enabledDefinitions.map(({ id }) => id))
    : 0;
  return {
    changesFingerprint: input.changesFingerprint,
    enabledDefinitions,
    inFlightRuns,
    repositories: input.repositories ?? [],
  };
}

/**
 * Read the consequence of a save or disconnect without testing a provider or
 * writing anything. A save is modelled as successful because only a successful
 * provider test activates it; a failed test leaves the old pin in force.
 */
export async function previewIntegrationImpact(input: {
  readonly actor: IntegrationActor;
  readonly integrationId: string;
  readonly preview: IntegrationImpactPreviewRequest;
}): Promise<IntegrationImpactPreviewResponse> {
  if (!canManageIntegrations(input.actor.role)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  const manifest = integrationManifest(input.integrationId);
  if (!manifest) throw new DashboardAuthError(404, "Unknown integration");

  const storedConnections = await readConnectedIntegrationConnections();
  const material = secretsKeyMaterial();
  const environment = environmentReaderFrom();
  const states = new Map<string, IntegrationState>();
  for (const candidate of integrationManifests) {
    states.set(candidate.id, resolveIntegrationState({
      manifest: candidate,
      environment,
      stored: storedConnections.get(candidate.id) ?? null,
      secretsKey: material.present
        ? { present: true, keyId: material.keyId }
        : { present: false },
    }));
  }
  const current = states.get(manifest.id);
  if (!current) throw new DashboardAuthError(404, "Unknown integration");
  const stored = storedConnections.get(manifest.id) ?? null;
  const changesFingerprint = input.preview.preview === "disconnect"
    ? disconnectChangesFingerprint(manifest, stored, current, environment, material)
    : saveChangesFingerprint(manifest, stored, current, environment, input.preview);

  let definitions: ImpactDefinitionInput[];
  let integrations: DeploymentIntegrations;
  try {
    // The module, not the barrel: the barrel reaches back to this cluster
    // through manual dispatch, and the boundaries gate refuses the cycle.
    const { readEnabledDeployedWorkflowDefinitions } = await import(
      "../workflow-definitions/definition-reads.js"
    );
    definitions = await readEnabledDeployedWorkflowDefinitions();
    integrations = deploymentIntegrations({ manifests: integrationManifests, states });
  } catch {
    return { changesFingerprint, enabledDefinitions: null, inFlightRuns: null, repositories: null };
  }

  try {
    const { loadRepositoryCatalogEntries } = await import("../repository-catalog/store.js");
    const catalog = await loadRepositoryCatalogEntries();
    return await summarizeIntegrationImpact({
      integrationId: manifest.id,
      changesFingerprint,
      definitions,
      integrations,
      countInFlightRuns,
      repositories: catalog.entries
        .filter((entry) => entry.provider === manifest.id)
        .map((entry) => ({ provider: entry.provider, path: entry.path })),
    });
  } catch {
    const enabledDefinitions = definitions
      .filter((entry) =>
        integrationsUsedBy(entry.definition.nodes, integrations).includes(manifest.id),
      )
      .map(({ id, name }) => ({ id, name }));
    return {
      changesFingerprint,
      enabledDefinitions,
      inFlightRuns: null,
      repositories: null,
    };
  }
}

function saveChangesFingerprint(
  manifest: IntegrationManifest,
  stored: StoredIntegrationConnection | null,
  current: IntegrationState,
  environment: ReturnType<typeof environmentReaderFrom>,
  request: IntegrationConnectionSaveRequest,
): boolean {
  const candidate = previewCandidate(manifest, stored, request);
  const environmentState = resolveIntegrationState({
    manifest,
    environment,
    stored: { ...(stored ?? emptyStored()), source: "environment" },
    secretsKey: { present: false },
  });
  const source = stored?.source === "stored" || environmentState.connection !== "connected"
    ? "stored"
    : "environment";
  return integrationConfigFingerprint({ manifest, environment, source, active: candidate })
    !== current.pin.configFingerprint;
}

function previewCandidate(
  manifest: IntegrationManifest,
  stored: StoredIntegrationConnection | null,
  request: IntegrationConnectionSaveRequest,
): StoredIntegrationVersion {
  const previous = stored?.latest ?? stored?.active ?? null;
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const secretDigests: Record<string, string> = {};
  for (const field of manifest.connection.fields) {
    const supplied = request.values[field.key] === undefined
      ? undefined
      : normalizeConnectionValue(request.values[field.key] ?? "", field);
    if (!field.secret) {
      const value = supplied ?? previous?.config[field.key] ?? "";
      if (value.length > 0) config[field.key] = value;
      continue;
    }
    if (request.clearSecrets.includes(field.key)) continue;
    if (supplied !== undefined && supplied.length > 0) {
      secretDigests[field.key] = integrationSecretDigest(manifest.id, field.key, supplied);
      continue;
    }
    const digest = previous?.secretDigests[field.key];
    if (digest) secretDigests[field.key] = digest;
  }
  return {
    version: (stored?.latestVersion ?? 0) + 1,
    config,
    secrets,
    secretDigests,
    testStatus: "passed",
    testReason: null,
    testMessage: null,
    testedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

function disconnectChangesFingerprint(
  manifest: IntegrationManifest,
  stored: StoredIntegrationConnection | null,
  current: IntegrationState,
  environment: ReturnType<typeof environmentReaderFrom>,
  material: ReturnType<typeof secretsKeyMaterial>,
): boolean {
  const after = resolveIntegrationState({
    manifest,
    environment,
    stored: stored === null
      ? null
      : {
          ...stored,
          source: "environment",
          activeVersion: null,
          active: null,
          latest: null,
          lastTest: null,
        },
    secretsKey: material.present
      ? { present: true, keyId: material.keyId }
      : { present: false },
  });
  return (
    after.pin.configFingerprint !== current.pin.configFingerprint
    || (current.usable && !after.usable)
  );
}

function emptyStored(): StoredIntegrationConnection {
  return {
    enabled: true,
    source: "environment",
    latestVersion: 0,
    activeVersion: null,
    active: null,
    latest: null,
    lastTest: null,
  };
}

async function countInFlightRuns(definitionIds: number[]): Promise<number> {
  if (definitionIds.length === 0) return 0;
  const affected = new Set(definitionIds);
  const active = (await createConnectedPostgresRunRegistry().listAll())
    .filter((entry) => entry.runId !== null && entry.state !== "reserved");
  const rows = await Promise.all(
    active.map((entry) => readConnectedRunDetailRow(entry.runId!)),
  );
  if (rows.some((row) => row === null)) {
    throw new Error("An in-flight run could not be read");
  }
  return runsThatWouldStop(
    rows.map((row) => ({ definitionId: row!.definitionId, status: row!.status })),
    affected,
  );
}

/**
 * How many of these runs a change to the integration would actually stop.
 *
 * A claim is not a running run. The reconciler releases claims on its own
 * cadence, minutes after a run ends, so counting the claim table would tell an
 * admin that eleven runs stop when three of them finished before lunch. A
 * number a person reads before a destructive button has to be the truth or
 * nothing, so the run's own status decides, and a run that already reached an
 * end is not going to be stopped by anything.
 */
export function runsThatWouldStop(
  rows: readonly { readonly definitionId: number | null; readonly status: string | null }[],
  affected: ReadonlySet<number>,
): number {
  return rows.filter(
    (row) =>
      row.definitionId !== null &&
      affected.has(row.definitionId) &&
      (row.status === "running" || row.status === "awaiting"),
  ).length;
}
