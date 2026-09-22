import { integrationManifest, integrationManifests } from "@integrations/registry";
import { integrationRuntime } from "@integrations/registry/worker";
import type { IntegrationManifest } from "@integrations/sdk";
import {
  DashboardAuthError,
  type DashboardRole,
  type IntegrationConnectionFieldDto,
  type IntegrationDto,
  type IntegrationMutationResponse,
  type IntegrationSource,
  type IntegrationState,
  type IntegrationTestOutcome,
  canManageIntegrations,
} from "@shared/contracts";

import type { Db } from "../../db/types.js";
import {
  disconnectConnectedIntegration,
  readConnectedIntegrationConnections,
  recordConnectedIntegrationTest,
  saveConnectedIntegrationVersion,
  setConnectedIntegrationEnabled,
  setConnectedIntegrationSource,
} from "../../db/repositories/integrations.js";
import {
  encryptIntegrationSecret,
  integrationSecretsKeyId,
  isValidIntegrationSecretsKey,
} from "../../infra/secrets-crypto.js";
import {
  type ConnectionValue,
  type IntegrationSecretsKeyMaterial,
  readConnectionValues,
  redactIntegrationText,
  secretValuesOf,
} from "./connection-values.js";
import { buildIntegrationContext } from "./context.js";
import { integrationWriteAccess } from "./deployment-writes.js";
import {
  type IntegrationSecretsKeyState,
  type StoredIntegrationConnection,
  type StoredIntegrationVersion,
  environmentReaderFrom,
  integrationSecretDigest,
  integrationVerificationFingerprint,
  normalizeConnectionValue,
  resolveIntegrationState,
} from "./resolve.js";

/**
 * What an admin can do to an integration, and what anyone may read about one.
 *
 * Every read goes through `resolveIntegrationState`, and nothing here derives a
 * status of its own: the card, the health page, the engine and MCP have to agree
 * about the same deployment, and they only do that by reading one function.
 *
 * Nothing here is reachable from MCP. Connecting, testing, enabling, switching
 * source and disconnecting are dashboard actions (decision 15), so no credential
 * passes through a chat with a model.
 */

export interface IntegrationActor {
  readonly role: DashboardRole;
  readonly id: string | null;
}

/** Raised when a save's `expectedVersion` no longer matches; the route answers
 *  409 with a body carrying the current version, so a second tab can reload. */
export class IntegrationVersionConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super("integration_version_conflict");
    this.name = "IntegrationVersionConflictError";
    this.currentVersion = currentVersion;
  }
}

/** Timeout for a connection test. Well under the invocation ceiling, because an
 *  admin pressing Test is waiting at the screen. */
const TEST_TIMEOUT_MS = 20_000;

/** The key this deployment holds. Exported so the engine's integration step
 *  reads a connection through the same material every other caller does. */
export function secretsKeyMaterial(): IntegrationSecretsKeyMaterial {
  const key = process.env.INTEGRATION_SECRETS_KEY;
  if (!key || !isValidIntegrationSecretsKey(key)) return { present: false };
  return { present: true, keyId: integrationSecretsKeyId(key), key };
}

function keyState(material: IntegrationSecretsKeyMaterial): IntegrationSecretsKeyState {
  return material.present ? { present: true, keyId: material.keyId } : { present: false };
}

function stateOf(
  manifest: IntegrationManifest,
  stored: StoredIntegrationConnection | null,
  material: IntegrationSecretsKeyMaterial,
): IntegrationState {
  return resolveIntegrationState({
    manifest,
    environment: environmentReaderFrom(),
    stored,
    secretsKey: keyState(material),
  });
}

function fieldDtos(
  manifest: IntegrationManifest,
  stored: StoredIntegrationConnection | null,
): IntegrationConnectionFieldDto[] {
  // The form shows what the admin LAST entered, not what is in use: after a save
  // the provider refused, the fields they typed have to still be on the screen so
  // one of them can be corrected. Whether those values are the ones running is a
  // different question, and the state answers it.
  const active = stored?.latest ?? stored?.active ?? null;
  // Through the resolver's own reader rather than `process.env` directly, so
  // this deployment's environment is read in exactly one place and the settings
  // consumer guard keeps its list of computed reads short.
  const environment = environmentReaderFrom();
  return manifest.connection.fields.map((field) => ({
    key: field.key,
    label: field.label,
    ...(field.description === undefined ? {} : { description: field.description }),
    env: field.env,
    secret: field.secret,
    optional: field.optional === true,
    format: field.format ?? "text",
    envSet: (environment.value(field.env) ?? "").trim().length > 0,
    // A secret's value is never here, under any source. The screen needs to know
    // one exists so it can say "leave blank to keep", and that is all it needs.
    ...(field.secret || active?.config[field.key] === undefined
      ? {}
      : { storedValue: active.config[field.key] }),
    storedSecretSet: field.secret && (active?.secrets[field.key] ?? "").length > 0,
  }));
}

function toDto(
  manifest: IntegrationManifest,
  stored: StoredIntegrationConnection | null,
  material: IntegrationSecretsKeyMaterial,
): IntegrationDto {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    ...(manifest.docsUrl === undefined ? {} : { docsUrl: manifest.docsUrl }),
    capabilities: [...manifest.capabilities],
    blocks: manifest.blocks.map((block) => ({ type: block.type, label: block.ui.label })),
    pages: manifest.pages.map((page) => ({ id: page.id, label: page.label })),
    fields: fieldDtos(manifest, stored),
    state: stateOf(manifest, stored, material),
  };
}

/** Every integration this build ships, with what an admin may do about it.
 *  Open to every role: knowing what is connected is not a credential. */
export async function listIntegrations() {
  const stored = await readConnectedIntegrationConnections();
  const material = secretsKeyMaterial();
  return {
    integrations: integrationManifests.map((manifest) =>
      toDto(manifest, stored.get(manifest.id) ?? null, material),
    ),
    writes: await integrationWriteAccess(),
  };
}

/**
 * The state of every integration, for the callers that only want the state.
 *
 * The engine (S4), the health page (S5) and MCP (S3) read this rather than
 * building a DTO they would throw most of away.
 */
export async function readIntegrationStates(): Promise<Map<string, IntegrationState>> {
  return readIntegrationStatesFrom(await readConnectedIntegrationConnections());
}

/** The same states, for a caller that already holds the database this request
 *  is on. Production reads the connected handle; a caller that has its own
 *  (a test on pglite, a service already inside a transaction-less batch) reads
 *  the same rows through the same derivation rather than a second one. */
export async function readIntegrationStatesOn(db: Db): Promise<Map<string, IntegrationState>> {
  const { readIntegrationConnections } = await import("../../db/repositories/integrations.js");
  return readIntegrationStatesFrom(await readIntegrationConnections(db));
}

/**
 * The one derivation, over rows somebody else read.
 *
 * Both entry points above end here, and so does every other caller: a second
 * place that turns stored rows into an `IntegrationState` is exactly what
 * `resolve.ts` exists to prevent, and it would drift the day a rule changes in
 * one of them.
 */
export function readIntegrationStatesFrom(
  stored: Map<string, StoredIntegrationConnection>,
): Map<string, IntegrationState> {
  const material = secretsKeyMaterial();
  return new Map(
    integrationManifests.map((manifest) => [
      manifest.id,
      stateOf(manifest, stored.get(manifest.id) ?? null, material),
    ]),
  );
}

async function requireWritableIntegration(
  actor: IntegrationActor,
  integrationId: string,
): Promise<{ manifest: IntegrationManifest; material: IntegrationSecretsKeyMaterial }> {
  if (!canManageIntegrations(actor.role)) {
    throw new DashboardAuthError(403, "Forbidden");
  }
  const manifest = integrationManifest(integrationId);
  if (!manifest) {
    throw new DashboardAuthError(404, "Unknown integration");
  }
  const access = await integrationWriteAccess();
  if (!access.allowed) {
    // 403, not 409: on these routes 409 already means "your version is stale,
    // reload and try again", and this is never going to succeed from here.
    throw new DashboardAuthError(403, access.reason);
  }
  return { manifest, material: secretsKeyMaterial() };
}

async function respond(
  manifest: IntegrationManifest,
  material: IntegrationSecretsKeyMaterial,
  test?: IntegrationTestOutcome,
): Promise<IntegrationMutationResponse> {
  const stored = (await readConnectedIntegrationConnections()).get(manifest.id) ?? null;
  return {
    integration: toDto(manifest, stored, material),
    ...(test === undefined ? {} : { test }),
  };
}

/**
 * Ask the provider whether a set of values works.
 *
 * Runs against the values handed in, which on a save are the ones being tested
 * rather than the ones in use. A refusal carries the provider's own sentence,
 * with this connection's secrets taken out of it: providers echo credentials in
 * error bodies, and that sentence is what an admin reads and what this worker
 * logs.
 */
async function runConnectionTest(
  manifest: IntegrationManifest,
  values: Readonly<Record<string, ConnectionValue>>,
): Promise<IntegrationTestOutcome> {
  const runtime = integrationRuntime(manifest.id);
  if (!runtime) {
    return {
      ok: false,
      failure: {
        reason: "provider_unreachable",
        message: "This build ships no runtime for that integration",
      },
    };
  }
  const secrets = secretValuesOf(manifest, values);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const context = buildIntegrationContext({
      manifest,
      values,
      secrets,
      lifetime: controller.signal,
    });
    const result = await (runtime.testConnection as (ctx: unknown) => Promise<
      { ok: true; message?: string } | { ok: false; reason: string }
    >)(context);
    if (result.ok) {
      return {
        ok: true,
        ...(result.message === undefined
          ? {}
          : { message: redactIntegrationText(result.message, secrets) }),
      };
    }
    return {
      ok: false,
      failure: {
        reason: "credential_rejected",
        message: redactIntegrationText(result.reason, secrets),
      },
    };
  } catch (error) {
    // A throw is the provider not answering at all, which is a different
    // afternoon from the provider answering "no": one is an outage to wait out,
    // the other is a credential to fix.
    return {
      ok: false,
      failure: {
        reason: "provider_unreachable",
        message: redactIntegrationText(
          error instanceof Error ? error.message : "The provider could not be reached",
          secrets,
        ),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface SaveIntegrationConnectionInput {
  readonly actor: IntegrationActor;
  readonly integrationId: string;
  readonly expectedVersion: number;
  /** Only the fields this request carried. A secret the admin did not touch is
   *  absent and keeps its stored value. */
  readonly values: Readonly<Record<string, string>>;
  /** Secrets to remove. Clearing one is its own action, never a side effect of
   *  leaving a field blank. */
  readonly clearSecrets: readonly string[];
}

/**
 * Save stored values: test first, activate only on a pass.
 *
 * The version is minted either way. An admin who closes the tab while the test
 * runs must find the answer when they come back, and the connection that was
 * working must still be the one in use while they read it.
 *
 * There is no "save it anyway". A version whose test failed would become the
 * active one and immediately read as Failing, so the escape hatch for a provider
 * outage would take a working deployment down. If a real deployment is ever
 * blocked by a broken probe, the override to add is one that stays usable, and
 * the shape of that is decided then rather than guessed now.
 */
export async function saveIntegrationConnection(
  input: SaveIntegrationConnectionInput,
): Promise<IntegrationMutationResponse> {
  const { manifest, material } = await requireWritableIntegration(
    input.actor,
    input.integrationId,
  );
  const stored = (await readConnectedIntegrationConnections()).get(input.integrationId) ?? null;
  // What the admin last SAVED, not what is in use. A save the provider refused
  // still holds the values they typed, and the next save builds on those: an
  // admin who pasted a new token with a wrong URL, then fixed the URL and left
  // the token field blank, must keep the new token. Reading the active version
  // here would quietly restore the old one and report Connected.
  const previous = stored?.latest ?? stored?.active ?? null;

  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  // Beside each ciphertext, the marker the resolver compares. It has to be made
  // here, because here is the only place the plaintext exists.
  const secretDigests: Record<string, string> = {};
  for (const field of manifest.connection.fields) {
    if (!field.secret) {
      const supplied = input.values[field.key] === undefined
        ? undefined
        : normalizeConnectionValue(input.values[field.key] ?? "", field);
      const value = supplied ?? previous?.config[field.key] ?? "";
      if (value.length > 0) config[field.key] = value;
      continue;
    }
    if (input.clearSecrets.includes(field.key)) continue;
    const supplied = input.values[field.key] === undefined
        ? undefined
        : normalizeConnectionValue(input.values[field.key] ?? "", field);
    if (supplied !== undefined && supplied.length > 0) {
      if (!material.present) {
        throw new DashboardAuthError(
          403,
          "Set INTEGRATION_SECRETS_KEY on this deployment before storing a secret; it is not the webhook key",
        );
      }
      secrets[field.key] = encryptIntegrationSecret(supplied, material.key, {
        integrationId: manifest.id,
        fieldKey: field.key,
      });
      secretDigests[field.key] = integrationSecretDigest(manifest.id, field.key, supplied);
      continue;
    }
    // Untouched: the ciphertext moves forward as bytes, and its marker with it.
    // Re-encrypting would need the old value, and a save that only changes a URL
    // must not need the key. The marker is what makes that safe: the bytes
    // differ from the previous version's only by their initialisation vector,
    // and nothing compares the bytes.
    const carried = previous?.secrets[field.key];
    if (carried) {
      secrets[field.key] = carried;
      const carriedDigest = previous?.secretDigests[field.key];
      if (carriedDigest) secretDigests[field.key] = carriedDigest;
    }
  }

  const candidate: StoredIntegrationVersion = {
    version: (stored?.latestVersion ?? 0) + 1,
    config,
    secrets,
    secretDigests,
    testStatus: "failed",
    testReason: null,
    testMessage: null,
    testedAt: null,
    createdAt: new Date().toISOString(),
  };
  const resolved = readConnectionValues({
    manifest,
    source: "stored",
    environment: environmentReaderFrom(),
    active: candidate,
    secretsKey: material,
  });
  const test: IntegrationTestOutcome = resolved.ok
    ? await runConnectionTest(manifest, resolved.values)
    : { ok: false, failure: resolved.failure };

  // "Is the environment a usable source for this integration", not "did anyone
  // set a variable". A manifest whose fields are all optional, or one with no
  // fields at all, has a complete environment and must not be taken over; an
  // environment that is half set, or whose variable names an upgrade renamed,
  // cannot serve and there is nothing to protect.
  const environmentState = resolveIntegrationState({
    manifest,
    environment: environmentReaderFrom(),
    stored: { ...(stored ?? emptyStored()), source: "environment" },
    secretsKey: keyState(material),
  });

  const result = await saveConnectedIntegrationVersion({
    integrationId: manifest.id,
    expectedVersion: input.expectedVersion,
    config,
    secrets,
    secretDigests,
    takeOverSource: environmentState.connection !== "connected",
    test: {
      status: test.ok ? "passed" : "failed",
      reason: test.ok ? null : test.failure.reason,
      message: test.ok ? (test.message ?? null) : test.failure.message,
      fingerprint: integrationVerificationFingerprint({
        manifest,
        environment: environmentReaderFrom(),
        source: "stored",
        active: candidate,
      }),
    },
    actorId: input.actor.id,
  });
  if (result.conflict) throw new IntegrationVersionConflictError(result.currentVersion);

  return respond(manifest, material, test);
}

/** Ask the provider about the configuration in use right now, and remember what
 *  it said. Works for either source: an environment-configured integration is
 *  the one an admin most wants to be able to check. */
export async function testIntegrationConnection(
  input: { actor: IntegrationActor; integrationId: string },
): Promise<IntegrationMutationResponse> {
  const { manifest, material } = await requireWritableIntegration(
    input.actor,
    input.integrationId,
  );
  const stored = (await readConnectedIntegrationConnections()).get(manifest.id) ?? null;
  const source = stored?.source ?? "environment";
  const active = stored?.active ?? null;
  const resolved = readConnectionValues({
    manifest,
    source,
    environment: environmentReaderFrom(),
    active,
    secretsKey: material,
  });
  const test: IntegrationTestOutcome = resolved.ok
    ? await runConnectionTest(manifest, resolved.values)
    : { ok: false, failure: resolved.failure };

  await recordConnectedIntegrationTest({
    integrationId: manifest.id,
    status: test.ok ? "passed" : "failed",
    reason: test.ok ? null : test.failure.reason,
    message: test.ok ? (test.message ?? null) : test.failure.message,
    fingerprint: integrationVerificationFingerprint({
      manifest,
      environment: environmentReaderFrom(),
      source,
      active,
    }),
    actorId: input.actor.id,
  });
  return respond(manifest, material, test);
}

/** Switch which source is live, refusing a switch to one that is not complete.
 *  Switching to a half-configured source would replace a working connection with
 *  a broken one in the name of one click. */
export async function setIntegrationConnectionSource(
  input: { actor: IntegrationActor; integrationId: string; source: IntegrationSource },
): Promise<IntegrationMutationResponse> {
  const { manifest, material } = await requireWritableIntegration(
    input.actor,
    input.integrationId,
  );
  const stored = (await readConnectedIntegrationConnections()).get(manifest.id) ?? null;
  const target = resolveIntegrationState({
    manifest,
    environment: environmentReaderFrom(),
    stored: { ...(stored ?? emptyStored()), source: input.source },
    secretsKey: keyState(material),
  });
  if (target.connection !== "connected") {
    throw new DashboardAuthError(409, refusalFor(input.source, target));
  }
  await setConnectedIntegrationSource({
    integrationId: manifest.id,
    source: input.source,
    actorId: input.actor.id,
  });
  return respond(manifest, material);
}

/**
 * Why a source cannot be made the live one.
 *
 * An environment that configures nothing gets the same sentence as one that is
 * half configured: the admin needs the variable names either way, and "not
 * configured" without them is a dead end.
 */
function refusalFor(source: IntegrationSource, target: IntegrationState): string {
  if (source === "environment") {
    const missing = target.failure?.missingVariables ?? target.environment.missingVariables;
    if (missing.length > 0) {
      return `Set ${missing.join(", ")} on this deployment before making the environment the source`;
    }
  }
  if (target.failure) return target.failure.message;
  return "Store and test values before making them the source";
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

/** The kill switch. Keeps every value, so re-enabling is one click back. */
export async function setIntegrationEnabledState(
  input: { actor: IntegrationActor; integrationId: string; enabled: boolean },
): Promise<IntegrationMutationResponse> {
  const { manifest, material } = await requireWritableIntegration(
    input.actor,
    input.integrationId,
  );
  await setConnectedIntegrationEnabled({
    integrationId: manifest.id,
    enabled: input.enabled,
    actorId: input.actor.id,
  });
  return respond(manifest, material);
}

/** Forget every stored value and every stored secret, in every version, and hand
 *  the connection back to the environment. The audit of who and when survives. */
export async function disconnectIntegrationConnection(
  input: { actor: IntegrationActor; integrationId: string },
): Promise<IntegrationMutationResponse> {
  const { manifest, material } = await requireWritableIntegration(
    input.actor,
    input.integrationId,
  );
  await disconnectConnectedIntegration({ integrationId: manifest.id, actorId: input.actor.id });
  return respond(manifest, material);
}
