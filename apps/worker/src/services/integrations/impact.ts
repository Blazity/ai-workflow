import { integrationManifest, integrationManifests } from "@integrations/registry";
import { INTEGRATION_CAPABILITIES, type IntegrationManifest } from "@integrations/sdk";
import {
  BLOCK_CATALOG,
  DashboardAuthError,
  type IntegrationConnectionSaveRequest,
  type IntegrationConnectionPin,
  type IntegrationImpactPreviewRequest,
  type IntegrationImpactPreviewResponse,
  type IntegrationState,
  type WorkflowDefinition,
  type WorkflowRepositoryScope,
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
  NO_INTEGRATIONS,
  deploymentIntegrations,
  integrationsUsedBy,
  type DeploymentIntegrations,
} from "../../engine/definition/integration-availability.js";
import {
  checkIntegrationPin,
  environmentReaderFrom,
  integrationConfigFingerprint,
  integrationSecretDigest,
  normalizeConnectionValue,
  resolveIntegrationState,
  type IntegrationEnvironmentReader,
  type IntegrationSecretsKeyState,
} from "./resolve.js";
import { secretsKeyMaterial, type IntegrationActor } from "./authoring.js";

/** Why runs in flight may stop after a change, or `none`. */
export type ImpactStop = IntegrationImpactPreviewResponse["stops"];

export interface ImpactDefinitionInput {
  readonly id: number;
  readonly name: string;
  readonly definition: WorkflowDefinition;
}

/**
 * The capabilities the reach calculation can see a core block use, read off
 * `integrationsUsedBy` itself rather than listed here: every core block type is
 * asked, once, against a deployment in which each capability has a provider of
 * its own, and whatever a block reaches is what the calculation sees.
 *
 * Why it matters: an integration serving a capability the calculation cannot
 * see (the issue tracker today: every ticket run reaches it, and no core block
 * says so) was counted as used by nothing, so the kill switch on Jira promised
 * that zero runs would stop in front of every ticket run in flight. Read from
 * the calculation, this set grows the day the calculation does, and the
 * preview starts measuring what it used to call unknown with no change here.
 */
let seenCapabilities: ReadonlySet<string> | null = null;

export function capabilitiesTheReachSees(): ReadonlySet<string> {
  if (seenCapabilities) return seenCapabilities;
  const probe = (capability: string) => `probe:${capability}`;
  const capabilities = Object.keys(INTEGRATION_CAPABILITIES);
  const deployment: DeploymentIntegrations = {
    ...NO_INTEGRATIONS,
    providers: new Map(capabilities.map((capability) => [capability, [probe(capability)]])),
  };
  const reached = new Set(
    Object.keys(BLOCK_CATALOG).flatMap((type) => integrationsUsedBy([{ type }], deployment)),
  );
  seenCapabilities = new Set(capabilities.filter((capability) => reached.has(probe(capability))));
  return seenCapabilities;
}

/** The capabilities an integration serves that the reach calculation cannot see. */
export function unmeasuredCapabilitiesOf(capabilities: readonly string[]): string[] {
  const seen = capabilitiesTheReachSees();
  return capabilities.filter((capability) => !seen.has(capability));
}

/** One run the preview weighs: what the registry row says about it. */
export interface InFlightRun {
  readonly definitionId: number | null;
  readonly status: string | null;
  /** What the run recorded about its integrations at its start. */
  readonly integrationPins: readonly IntegrationConnectionPin[] | null;
}

/**
 * How many runs in flight a change to one integration may stop, by the
 * mechanism that stops them. Pure, so each rule is pinned by a test that
 * declares its runs.
 *
 * `unusable` (turned off, or disconnected with nothing to fall back to): every
 * run whose graph reaches the integration (`integrationsUsedBy`, the reached
 * set) stops or goes on without it at its next use, whether or not anything
 * compares a pin: a ticket run asks for the tracker and none is there.
 *
 * `reconfigured` (still usable, with values a pin no longer matches): only a
 * run whose next use compares its pin stops. It needs a recorded pin for the
 * integration at the fingerprint in force now, and a path that compares it:
 * the integration's own blocks in the graph; `send_message` when it serves
 * messaging (a notification alone is withheld and the run goes on); or
 * version control, when the definition's repository scope does not rule the
 * provider out. The issue tracker, tracing and memory compare no pin today, so
 * a Jira edit stops nothing. A run with no pins, or with no pin for the
 * integration, compares nothing and is not counted.
 *
 * Only runs on enabled definitions are weighed, because theirs are the graphs
 * read here; a run started on a definition switched off since is not counted.
 */
export function runsThatMayStop(input: {
  readonly runs: readonly InFlightRun[];
  readonly integrationId: string;
  readonly stops: ImpactStop;
  /** The fingerprint in force now, which a run pinned to it would miss. */
  readonly currentFingerprint: string;
  readonly definitions: ReadonlyMap<number, WorkflowDefinition>;
  readonly integrations: DeploymentIntegrations;
}): number {
  if (input.stops === "none") return 0;
  const { integrationId, integrations } = input;
  const capabilities = integrations.byId.get(integrationId)?.capabilities ?? [];
  return input.runs.filter((run) => {
    if (run.status !== "running" && run.status !== "awaiting") return false;
    const definition =
      run.definitionId === null ? undefined : input.definitions.get(run.definitionId);
    if (!definition) return false;
    if (input.stops === "unusable") {
      return integrationsUsedBy(definition.nodes, integrations).includes(integrationId);
    }
    const pin = run.integrationPins?.find((candidate) => candidate.integrationId === integrationId);
    if (!pin || pin.configFingerprint !== input.currentFingerprint) return false;
    const ownBlock = definition.nodes.some(
      (node) => integrations.blocks.get(node.type)?.integrationId === integrationId,
    );
    const postsMessages =
      capabilities.includes("messaging") &&
      definition.nodes.some((node) => node.type === "send_message");
    const worksOnItsRepositories =
      capabilities.includes("vcs") && scopeAllows(definition.repositoryScope, integrationId);
    return ownBlock || postsMessages || worksOnItsRepositories;
  }).length;
}

/** Whether a definition's repository scope leaves room for a provider's repositories. */
function scopeAllows(scope: WorkflowRepositoryScope | undefined, provider: string): boolean {
  if (scope?.repositories && scope.repositories.length > 0) {
    return scope.repositories.some((repository) => repository.provider === provider);
  }
  if (scope?.providers && scope.providers.length > 0) return scope.providers.includes(provider);
  return true;
}

/**
 * The exact reach calculation a run uses, applied to enabled deployed graphs.
 * Keeping this function data-only makes the critical core-capability case easy
 * to pin without arranging a database.
 *
 * An integration serving a capability that calculation cannot see gets no
 * list and no count: "none" and "0" would be measured claims about something
 * nobody measured, in front of a destructive button.
 */
export async function summarizeIntegrationImpact(input: {
  readonly integrationId: string;
  readonly changesFingerprint: boolean;
  /** `previewedChange`'s answer. */
  readonly stops: ImpactStop;
  readonly currentFingerprint: string;
  readonly definitions: readonly ImpactDefinitionInput[];
  readonly integrations: DeploymentIntegrations;
  readonly readInFlightRuns: () => Promise<readonly InFlightRun[]>;
  readonly repositories?: readonly { provider: string; path: string }[];
}): Promise<IntegrationImpactPreviewResponse> {
  const unmeasuredCapabilities = unmeasuredCapabilitiesOf(
    input.integrations.byId.get(input.integrationId)?.capabilities ?? [],
  );
  if (unmeasuredCapabilities.length > 0) {
    return {
      changesFingerprint: input.changesFingerprint,
      stops: input.stops,
      unmeasuredCapabilities,
      enabledDefinitions: null,
      // Nothing stops is still a measured fact when no run stops at all.
      inFlightRuns: input.stops === "none" ? 0 : null,
      repositories: input.repositories ?? [],
    };
  }
  const using = input.definitions.filter((entry) =>
    integrationsUsedBy(entry.definition.nodes, input.integrations).includes(input.integrationId),
  );
  const inFlightRuns =
    input.stops === "none"
      ? 0
      : runsThatMayStop({
          runs: await input.readInFlightRuns(),
          integrationId: input.integrationId,
          stops: input.stops,
          currentFingerprint: input.currentFingerprint,
          definitions: new Map(using.map((entry) => [entry.id, entry.definition])),
          integrations: input.integrations,
        });
  return {
    changesFingerprint: input.changesFingerprint,
    stops: input.stops,
    unmeasuredCapabilities: [],
    enabledDefinitions: using.map(({ id, name }) => ({ id, name })),
    inFlightRuns,
    repositories: input.repositories ?? [],
  };
}

/**
 * Read the consequence of a save, a disconnect, a switch of source or the kill
 * switch, without testing a provider or writing anything. A save is modelled
 * as successful because only a successful provider test activates it; a failed
 * test leaves the old pin in force.
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
  const { changesFingerprint, stops } = previewedChange({
    manifest,
    stored: storedConnections.get(manifest.id) ?? null,
    current,
    environment,
    secretsKey: material.present ? { present: true, keyId: material.keyId } : { present: false },
    preview: input.preview,
  });

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
    return {
      changesFingerprint,
      stops,
      unmeasuredCapabilities: unmeasuredCapabilitiesOf(manifest.capabilities),
      enabledDefinitions: null,
      inFlightRuns: stops === "none" ? 0 : null,
      repositories: null,
    };
  }

  try {
    const { loadRepositoryCatalogEntries } = await import("../repository-catalog/store.js");
    const catalog = await loadRepositoryCatalogEntries();
    return await summarizeIntegrationImpact({
      integrationId: manifest.id,
      changesFingerprint,
      stops,
      currentFingerprint: current.pin.configFingerprint,
      definitions,
      integrations,
      readInFlightRuns,
      repositories: catalog.entries
        .filter((entry) => entry.provider === manifest.id)
        .map((entry) => ({ provider: entry.provider, path: entry.path })),
    });
  } catch {
    const unmeasuredCapabilities = unmeasuredCapabilitiesOf(manifest.capabilities);
    const enabledDefinitions =
      unmeasuredCapabilities.length > 0
        ? null
        : definitions
            .filter((entry) =>
              integrationsUsedBy(entry.definition.nodes, integrations).includes(manifest.id),
            )
            .map(({ id, name }) => ({ id, name }));
    return {
      changesFingerprint,
      stops,
      unmeasuredCapabilities,
      enabledDefinitions,
      inFlightRuns: stops === "none" ? 0 : null,
      repositories: null,
    };
  }
}

/**
 * What the change asked about does to a run in flight, from facts already read.
 *
 * ONE ANSWER for all four changes, from the run's own check: the state the
 * change leaves is built, and the pin a run in flight holds is checked against
 * it the way the run checks it at its next use (`checkIntegrationPin`). A run
 * only holds a pin for a connection that was usable when it started, so a
 * change to a connection that is not usable now stops nothing that is not
 * already stopping. What the check refuses decides the mechanism: the
 * integration becoming unusable (`unusable`: turned off, or disconnected with
 * nothing to fall back to), or still usable with other values (`reconfigured`),
 * and `runsThatMayStop` counts each its own way.
 *
 * The kill switch is the stored row with `enabled: false`, so it needs no
 * branch of its own: it moves no fingerprint (the flag is read live, never
 * pinned) and the check still refuses. A save is modelled as successful,
 * because only a passing test activates it: the connection the change leaves
 * is working, with the fingerprint of the values sent.
 */
export function previewedChange(input: {
  readonly manifest: IntegrationManifest;
  readonly stored: StoredIntegrationConnection | null;
  readonly current: IntegrationState;
  readonly environment: IntegrationEnvironmentReader;
  readonly secretsKey: IntegrationSecretsKeyState;
  readonly preview: IntegrationImpactPreviewRequest;
}): { readonly changesFingerprint: boolean; readonly stops: ImpactStop } {
  const { manifest, stored, current, environment, secretsKey, preview } = input;
  const after =
    preview.preview === "save"
      ? savedState(current, saveFingerprint(manifest, stored, environment, preview))
      : resolveIntegrationState({
          manifest,
          environment,
          stored:
            preview.preview === "source"
              ? { ...(stored ?? emptyStored()), source: preview.source }
              : preview.preview === "disable"
                ? { ...(stored ?? emptyStored()), enabled: false }
                : disconnected(stored),
          secretsKey,
        });
  const changesFingerprint = after.pin.configFingerprint !== current.pin.configFingerprint;
  if (!current.usable || checkIntegrationPin(current.pin, after).ok) {
    return { changesFingerprint, stops: "none" };
  }
  return { changesFingerprint, stops: after.usable ? "reconfigured" : "unusable" };
}

/** The state a save that passed its test leaves: working, with the new values. */
function savedState(current: IntegrationState, configFingerprint: string): IntegrationState {
  return {
    ...current,
    connection: "connected",
    status: current.enabled ? "connected" : "disabled",
    usable: current.enabled,
    failure: null,
    pin: { ...current.pin, configFingerprint },
  };
}

/** The stored half as a disconnect leaves it: values erased, environment the source. */
function disconnected(
  stored: StoredIntegrationConnection | null,
): StoredIntegrationConnection | null {
  return stored === null
    ? null
    : {
        ...stored,
        source: "environment",
        activeVersion: null,
        active: null,
        latest: null,
        lastTest: null,
      };
}

/** The fingerprint the saved values would carry once active. */
function saveFingerprint(
  manifest: IntegrationManifest,
  stored: StoredIntegrationConnection | null,
  environment: IntegrationEnvironmentReader,
  request: IntegrationConnectionSaveRequest,
): string {
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
  return integrationConfigFingerprint({ manifest, environment, source, active: candidate });
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

/**
 * Every run the registry holds a claim for, as the preview weighs it. A claim
 * is not a running run (the reconciler releases claims minutes after a run
 * ends), so `runsThatMayStop` keeps only the ones whose own status says so: a
 * number a person reads before a destructive button has to be the truth or
 * nothing.
 */
async function readInFlightRuns(): Promise<readonly InFlightRun[]> {
  const active = (await createConnectedPostgresRunRegistry().listAll())
    .filter((entry) => entry.runId !== null && entry.state !== "reserved");
  const rows = await Promise.all(
    active.map((entry) => readConnectedRunDetailRow(entry.runId!)),
  );
  if (rows.some((row) => row === null)) {
    throw new Error("An in-flight run could not be read");
  }
  return rows.map((row) => ({
    definitionId: row!.definitionId,
    status: row!.status,
    integrationPins: row!.integrationPins,
  }));
}
