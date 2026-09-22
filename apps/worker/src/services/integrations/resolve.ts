import { createHash } from "node:crypto";
import type { ConnectionField, IntegrationManifest } from "@integrations/sdk";
import type {
  IntegrationConnectionPin,
  IntegrationConnectionStatus,
  IntegrationEnvironmentPresence,
  IntegrationFailure,
  IntegrationPreparedValues,
  IntegrationSource,
  IntegrationState,
  IntegrationStoredPresence,
  IntegrationUnavailableReason,
  IntegrationVerification,
} from "@shared/contracts";

import type {
  StoredIntegrationConnection,
  StoredIntegrationTest,
  StoredIntegrationVersion,
} from "../../db/repositories/integrations.js";
import { readIntegrationSecretEnvelope } from "../../infra/secrets-crypto.js";
import { malformedValueFailure } from "./value-problems.js";

/**
 * The one place a status comes from.
 *
 * Every surface that says anything about an integration reads this function:
 * the API this stage ships, the engine deciding whether a block may run (S4),
 * the health page (S5), MCP (S3) and the dashboard (S6). A second derivation
 * anywhere is the bug this module exists to prevent, because it is how the
 * palette and the run come to disagree about the same deployment.
 *
 * Pure: everything it reads is an argument, so it holds no cache and cannot go
 * stale. That is not an aesthetic preference. Disabling an integration is the
 * kill switch an admin reaches for when a bot misbehaves, and on Vercel the next
 * request lands on a warm invocation; a module-level cache would keep the bot
 * running until the instance recycled.
 *
 * It sees connection values, secrets included, because completeness is a fact
 * about the values. It never puts one in its result: `IntegrationState` has no
 * field that could hold a value, which is what makes "no secret leaves the
 * server" a property of the type rather than a rule people remember.
 */

/** Reads the deployment's environment. Mirrors `SettingsEnvironmentReader`. */
export interface IntegrationEnvironmentReader {
  value(name: string): string | undefined;
}

export function environmentReaderFrom(
  source: Readonly<Record<string, string | undefined>> = process.env,
): IntegrationEnvironmentReader {
  return { value: (name) => source[name] };
}

/** Whether this deployment can read stored secrets at all. */
export type IntegrationSecretsKeyState =
  | { readonly present: true; readonly keyId: string }
  | { readonly present: false };

export type {
  StoredIntegrationConnection,
  StoredIntegrationTest,
  StoredIntegrationVersion,
} from "../../db/repositories/integrations.js";

export interface ResolveIntegrationInput {
  readonly manifest: IntegrationManifest;
  readonly environment: IntegrationEnvironmentReader;
  readonly stored: StoredIntegrationConnection | null;
  readonly secretsKey: IntegrationSecretsKeyState;
}

/** With no row at all, the environment is the source and nothing is disabled:
 *  a deployment configured through variables keeps working with no row to
 *  migrate and nothing for its admin to do. */
const NO_ROW = {
  enabled: true,
  source: "environment",
  latestVersion: 0,
  activeVersion: null,
} as const;

export function resolveIntegrationState(input: ResolveIntegrationInput): IntegrationState {
  const { manifest, environment, stored, secretsKey } = input;
  const fields = manifest.connection.fields;
  const enabled = stored?.enabled ?? NO_ROW.enabled;
  const source = stored?.source ?? NO_ROW.source;
  const active = stored?.active ?? null;

  const environmentPresence = resolveEnvironment(fields, environment);
  const { presence: storedPresence, secretFailure } = resolveStored(
    manifest.id,
    fields,
    stored,
    secretsKey,
  );

  const values = connectionValueShape({
    integrationId: manifest.id,
    fields,
    source,
    environment,
    active,
  });
  const pin: IntegrationConnectionPin = {
    integrationId: manifest.id,
    configFingerprint: fingerprint(manifest.id, values.config),
  };
  const verificationOf = fingerprint(manifest.id, values.verification);

  const readiness =
    source === "environment"
      ? environmentReadiness(environmentPresence)
      : storedReadiness(storedPresence, secretFailure);

  const malformed = malformedValueInUse({ fields, source, environment, active });

  const verification = resolveVerification({
    source,
    active,
    lastTest: stored?.lastTest ?? null,
    currentFingerprint: verificationOf,
  });

  // A complete configuration the provider has already REFUSED is not Connected,
  // whichever source it came from. A configuration nobody ever tested is, and
  // says so through `verification`: that is every deployment on the day this
  // lands, and telling them they are disconnected would be false.
  //
  // A provider that could not be REACHED is different, and with no "save it
  // anyway" it matters: a thirty second outage while an admin happens to press
  // Test would otherwise record a failure that stops every run and that only a
  // human pressing Test again can clear. An unreachable provider says nothing
  // about the configuration, so the connection stays as it was and
  // `verification` carries what happened and when.
  const testFailure =
    verification.state === "failed" && verification.failure.reason !== "provider_unreachable"
      ? verification.failure
      : null;
  // A value that cannot be what its field is fails the connection before any
  // test does: no provider needs to be asked about a site address without
  // `https://`, and one that was would be filed as an outage.
  const failure = readiness.failure ?? malformed ?? testFailure;
  const connection: IntegrationConnectionStatus = failure
    ? "failing"
    : readiness.connection;

  return {
    integrationId: manifest.id,
    enabled,
    source,
    status: enabled ? connection : "disabled",
    connection,
    verification,
    failure,
    usable: enabled && connection === "connected",
    environment: environmentPresence,
    stored: storedPresence,
    pin,
    configuredFields: values.config.map(([key]) => key),
    secretsKeyAvailable: secretsKey.present,
  };
}

/**
 * The fingerprint a connection test's verdict is recorded against.
 *
 * Covers every value including secrets, because a rotated token is exactly the
 * change that makes an old refusal meaningless. The config fingerprint a run
 * pins covers the non-secret values only, because a rotated token is exactly the
 * change a run should follow. The two questions differ, so the two digests do.
 *
 * A secret enters as a truncated SHA-256 of its field key and its value, never
 * as the value. It is not a salted or keyed digest, so treat it as what it is:
 * an equality marker for "the same secret as last time", stored in the worker's
 * own database and never returned in any response, log or MCP payload.
 */
export function integrationVerificationFingerprint(input: {
  readonly manifest: IntegrationManifest;
  readonly environment: IntegrationEnvironmentReader;
  readonly source: IntegrationSource;
  readonly active: StoredIntegrationVersion | null;
}): string {
  const values = connectionValueShape({
    integrationId: input.manifest.id,
    fields: input.manifest.connection.fields,
    source: input.source,
    environment: input.environment,
    active: input.active,
  });
  return fingerprint(input.manifest.id, values.verification);
}

/** The fingerprint a run pins: the non-secret values of the active source. */
export function integrationConfigFingerprint(input: {
  readonly manifest: IntegrationManifest;
  readonly environment: IntegrationEnvironmentReader;
  readonly source: IntegrationSource;
  readonly active: StoredIntegrationVersion | null;
}): string {
  const values = connectionValueShape({
    integrationId: input.manifest.id,
    fields: input.manifest.connection.fields,
    source: input.source,
    environment: input.environment,
    active: input.active,
  });
  return fingerprint(input.manifest.id, values.config);
}

/**
 * The marker stored beside a secret, and the same value the resolver compares.
 *
 * A truncated SHA-256 over the integration, the field and the value: not a
 * keyed or salted digest, so treat it as what it is, an equality marker for
 * "the same secret as last time". It lives in the worker's own database and in
 * no response, log or MCP payload.
 *
 * The save path calls this with the plaintext; the resolver calls it for the
 * environment source and reads the stored one otherwise. One function, so the
 * two sides agree and switching source with the same token moves no pin.
 */
export function integrationSecretDigest(
  integrationId: string,
  fieldKey: string,
  value: string,
): string {
  return digest(`${integrationId}:${fieldKey}:${value}`);
}

/**
 * A connection value as it is compared and stored.
 *
 * Whitespace around a pasted token or URL is what a clipboard adds, never what
 * an admin means. A `multiline` value keeps every character: a PEM key's
 * newlines and its trailing line are part of the value, and trimming one has
 * broken a deployment before. Every path that reads a value uses this, so the
 * value stored, the value the provider is called with and the value the
 * fingerprint covers are the same string.
 */
export function normalizeConnectionValue(
  value: string,
  field: { readonly format?: "text" | "multiline" | "url" | "integer" },
): string {
  return field.format === "multiline" ? value : value.trim();
}

export type IntegrationPinCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: IntegrationUnavailableReason;
      /** What the resolver says about it, when it says anything: which variable
       *  is missing, whether the provider refused, whether the key is absent. */
      readonly failure?: IntegrationFailure;
    };

/**
 * Whether a run may still use the integration it pinned.
 *
 * Order is deliberate: disabled first, because an admin chose it and it is the
 * answer that explains the most; then unusable, because a disconnect also moves
 * the fingerprint and reporting `reconfigured` for it would send an admin
 * looking for an edit nobody made; then reconfigured, which is what is left.
 *
 * `failure` carries the resolver's own reason alongside the run-facing one, so
 * the run view can say "the provider refused the credential" rather than only
 * "disconnected". The three run-facing reasons are the plan's, and stay three.
 */
export function checkIntegrationPin(
  pin: IntegrationConnectionPin,
  state: IntegrationState,
): IntegrationPinCheck {
  // A pin for another integration is a caller bug, not a deployment state, and
  // answering it with a verdict about THIS integration would hide the mistake.
  if (pin.integrationId !== state.integrationId) {
    return {
      ok: false,
      reason: "reconfigured",
      failure: {
        reason: "stored_incomplete",
        message: `This run pinned ${pin.integrationId}, which is not ${state.integrationId}`,
      },
    };
  }
  if (!state.enabled) {
    return { ok: false, reason: "disabled" };
  }
  if (state.connection !== "connected") {
    return {
      ok: false,
      reason: "disconnected",
      ...(state.failure ? { failure: state.failure } : {}),
    };
  }
  if (state.pin.configFingerprint !== pin.configFingerprint) {
    return { ok: false, reason: "reconfigured" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------

function isSet(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveEnvironment(
  fields: readonly ConnectionField[],
  environment: IntegrationEnvironmentReader,
): IntegrationEnvironmentPresence {
  const setVariables: string[] = [];
  const missingVariables: string[] = [];
  for (const field of fields) {
    if (isSet(environment.value(field.env))) {
      setVariables.push(field.env);
      continue;
    }
    // A default covers a field the source leaves unset, so it is never missing;
    // an optional field without one is simply absent.
    if (field.optional === true || field.default !== undefined) continue;
    missingVariables.push(field.env);
  }
  return {
    setVariables,
    missingVariables,
    complete: missingVariables.length === 0,
  };
}

/**
 * What is stored, and whether this deployment can read it.
 *
 * The readability failure is computed here but kept out of the presence DTO: it
 * is a fact about THIS deployment's key, not about the stored values, and it
 * belongs in the one place a card reads a reason from.
 */
function resolveStored(
  integrationId: string,
  fields: readonly ConnectionField[],
  stored: StoredIntegrationConnection | null,
  secretsKey: IntegrationSecretsKeyState,
): { presence: IntegrationStoredPresence; secretFailure: IntegrationFailure | null } {
  const active = stored?.active ?? null;
  const missingFields: string[] = [];
  if (active) {
    for (const field of fields) {
      const value = field.secret ? active.secrets[field.key] : active.config[field.key];
      if (isSet(value)) continue;
      if (field.optional === true || field.default !== undefined) continue;
      missingFields.push(field.key);
    }
  }
  return {
    presence: {
      latestVersion: stored?.latestVersion ?? NO_ROW.latestVersion,
      activeVersion: stored?.activeVersion ?? NO_ROW.activeVersion,
      missingFields,
      complete: active !== null && missingFields.length === 0,
      prepared: preparedFrom(stored),
    },
    secretFailure: readableSecrets(integrationId, active, secretsKey, fields),
  };
}

/**
 * Whether every stored secret is one this deployment can open, and if not, which
 * of the four different afternoons the admin is in for.
 *
 * Checked without decrypting: the envelope says which key wrote it and which
 * slot it belongs to, so a card can explain itself on a plain list read without
 * touching a cipher.
 */
function readableSecrets(
  integrationId: string,
  active: StoredIntegrationVersion | null,
  secretsKey: IntegrationSecretsKeyState,
  fields: readonly ConnectionField[],
): IntegrationFailure | null {
  if (!active) return null;
  const secretFields = fields.filter((field) => field.secret);
  const stored = secretFields.filter((field) => isSet(active.secrets[field.key]));
  if (stored.length === 0) return null;
  if (!secretsKey.present) {
    return {
      reason: "secrets_key_missing",
      message:
        "Set INTEGRATION_SECRETS_KEY on this deployment to use stored secrets; it is not the webhook key",
    };
  }
  for (const field of stored) {
    const envelope = readIntegrationSecretEnvelope(active.secrets[field.key] ?? "");
    if (!envelope) {
      return {
        reason: "secret_corrupted",
        message: `The stored ${field.label} is not readable; enter it again`,
      };
    }
    if (envelope.keyId !== secretsKey.keyId) {
      return {
        reason: "secrets_key_mismatch",
        message: `The stored ${field.label} was written under another key; enter it again`,
      };
    }
    if (envelope.scope !== `${integrationId}.${field.key}`) {
      return {
        reason: "secret_foreign",
        message: `The stored ${field.label} belongs to another integration; enter it again`,
      };
    }
  }
  return null;
}

function preparedFrom(
  stored: StoredIntegrationConnection | null,
): IntegrationPreparedValues | null {
  const latest = stored?.latest ?? null;
  if (!latest || latest.testStatus !== "failed") return null;
  return {
    version: latest.version,
    at: latest.testedAt ?? latest.createdAt,
    failure: {
      reason: latest.testReason ?? "credential_rejected",
      message: latest.testMessage ?? "The connection test failed",
    },
  };
}

/**
 * The first value in use that cannot be what its field is, as the failure that
 * names it. Every value of an environment source is read, secrets included,
 * since the environment holds them as text; of a stored source only the plain
 * config, because a stored secret is ciphertext here. Reading a stored secret
 * is `readConnectionValues`' job, and it refuses the same value with the same
 * sentence, so a run and a test never send one.
 */
function malformedValueInUse(input: {
  readonly fields: readonly ConnectionField[];
  readonly source: IntegrationSource;
  readonly environment: IntegrationEnvironmentReader;
  readonly active: StoredIntegrationVersion | null;
}): IntegrationFailure | null {
  for (const field of input.fields) {
    const raw =
      input.source === "environment"
        ? input.environment.value(field.env)
        : field.secret
          ? undefined
          : input.active?.config[field.key];
    if (!isSet(raw)) continue;
    const failure = malformedValueFailure(field, normalizeConnectionValue(raw, field), input.source);
    if (failure) return failure;
  }
  return null;
}

interface Readiness {
  readonly connection: IntegrationConnectionStatus;
  readonly failure: IntegrationFailure | null;
}

function environmentReadiness(presence: IntegrationEnvironmentPresence): Readiness {
  if (presence.complete) return { connection: "connected", failure: null };
  // Some variables set and some not is a typo, not a decision to use the
  // dashboard instead. Falling back to stored values here would make the two
  // indistinguishable, so it says which variables are missing and stops.
  if (presence.setVariables.length > 0) {
    return {
      connection: "failing",
      failure: {
        reason: "environment_incomplete",
        message: `Set ${presence.missingVariables.join(", ")} on this deployment, or store the values from the dashboard`,
        missingVariables: presence.missingVariables,
      },
    };
  }
  return { connection: "not_connected", failure: null };
}

function storedReadiness(
  presence: IntegrationStoredPresence,
  secretFailure: IntegrationFailure | null,
): Readiness {
  if (presence.activeVersion === null) {
    return { connection: "not_connected", failure: null };
  }
  if (secretFailure) {
    return { connection: "failing", failure: secretFailure };
  }
  if (!presence.complete) {
    return {
      connection: "failing",
      failure: {
        reason: "stored_incomplete",
        message: `Enter ${presence.missingFields.join(", ")} to finish connecting`,
        missingFields: presence.missingFields,
      },
    };
  }
  return { connection: "connected", failure: null };
}

function resolveVerification(input: {
  readonly source: IntegrationSource;
  readonly active: StoredIntegrationVersion | null;
  readonly lastTest: StoredIntegrationTest | null;
  readonly currentFingerprint: string;
}): IntegrationVerification {
  const { source, active, lastTest, currentFingerprint } = input;
  // A verdict about values that have since changed says nothing about the ones
  // in use. It goes stale rather than failing the integration, or an admin who
  // fixed a variable by redeploying would still read the old refusal.
  const tested =
    lastTest && lastTest.fingerprint === currentFingerprint ? lastTestVerdict(lastTest) : null;
  // Stored values carry their own verdict, because a save tests before it
  // activates: the version IS the record of what the provider said about it
  // then. A Test pressed later, about exactly these values, is newer news and
  // wins, the same as for the environment source: a token revoked after the
  // save reads Failing the moment Test says so, instead of Connected forever.
  //
  // A tie goes to the Test: the only way to tie is the save itself, which
  // writes both records in one statement with the same verdict.
  if (source === "stored" && active) {
    const saved = savedVerdict(active);
    if (saved) return tested && Date.parse(tested.at) >= Date.parse(saved.at) ? tested : saved;
  }
  if (!lastTest) return { state: "never_tested" };
  return tested ?? { state: "stale", at: lastTest.at };
}

/** A verdict somebody recorded, with the moment it was recorded. */
type RecordedVerdict = Extract<IntegrationVerification, { readonly state: "passed" | "failed" }>;

function savedVerdict(active: StoredIntegrationVersion): RecordedVerdict | null {
  if (active.testStatus === "failed") {
    return {
      state: "failed",
      at: active.testedAt ?? active.createdAt,
      failure: {
        reason: active.testReason ?? "credential_rejected",
        message: active.testMessage ?? "The connection test failed",
      },
    };
  }
  return active.testedAt ? { state: "passed", at: active.testedAt } : null;
}

function lastTestVerdict(lastTest: StoredIntegrationTest): RecordedVerdict {
  if (lastTest.status === "passed") {
    return { state: "passed", at: lastTest.at, ...(lastTest.message ? { message: lastTest.message } : {}) };
  }
  return {
    state: "failed",
    at: lastTest.at,
    failure: {
      reason: lastTest.reason ?? "credential_rejected",
      message: lastTest.message ?? "The connection test failed",
    },
  };
}

interface ValueShape {
  /** What a run pins: every non-secret value, plus a digest of each secret the
   *  manifest marks as naming the account. */
  readonly config: readonly (readonly [string, string])[];
  /** Every value, each secret as a digest, for the fingerprint a verdict is
   *  recorded against. */
  readonly verification: readonly (readonly [string, string])[];
}

function connectionValueShape(input: {
  readonly integrationId: string;
  readonly fields: readonly ConnectionField[];
  readonly source: IntegrationSource;
  readonly environment: IntegrationEnvironmentReader;
  readonly active: StoredIntegrationVersion | null;
}): ValueShape {
  const config: (readonly [string, string])[] = [];
  const verification: (readonly [string, string])[] = [];
  for (const field of [...input.fields].sort((a, b) => a.key.localeCompare(b.key))) {
    if (field.secret) {
      // Never the ciphertext. AES-GCM uses a random initialisation vector, so
      // the identical token encrypts to different bytes every time it is saved:
      // a fingerprint built from them would move on every save and stop every
      // run in flight with `reconfigured` although nothing changed. Under the
      // stored source the marker is the one the save wrote from the plaintext;
      // under the environment source the plaintext is right here. The two are
      // computed by the same function, so switching source with the same token
      // moves nothing either.
      const hashed =
        input.source === "environment"
          ? environmentSecretDigest(input, field)
          : input.active?.secretDigests[field.key];
      if (hashed === undefined || hashed.length === 0) continue;
      verification.push([field.key, hashed]);
      // A secret the manifest marks as naming the account belongs in the pin
      // too, or swapping a Slack bot token for another workspace's would read as
      // a rotation and a run would post into the wrong company's channels.
      if (field.identity === true) config.push([field.key, hashed]);
      continue;
    }
    const raw =
      input.source === "environment"
        ? input.environment.value(field.env)
        : input.active?.config[field.key];
    const value = isSet(raw) ? normalizeConnectionValue(raw, field) : (field.default ?? "");
    // A field carrying nothing contributes nothing. Otherwise every manifest
    // that grows a field would move every fingerprint on this deployment, and
    // S8 to S12 each rewrite a manifest: every run in flight would stop with
    // `reconfigured` for a connection nobody touched. A field whose VALUE
    // changes, including one gaining or losing a value, still moves it.
    if (value.length === 0) continue;
    config.push([field.key, value]);
    verification.push([field.key, value]);
  }
  return { config, verification };
}

function environmentSecretDigest(
  input: { readonly integrationId: string; readonly environment: IntegrationEnvironmentReader },
  field: ConnectionField,
): string | undefined {
  const raw = input.environment.value(field.env);
  if (!isSet(raw)) return undefined;
  return integrationSecretDigest(input.integrationId, field.key, normalizeConnectionValue(raw, field));
}

function fingerprint(integrationId: string, entries: readonly (readonly [string, string])[]): string {
  // JSON rather than a delimiter: a field value may contain anything, and two
  // different value sets must never serialise to the same string.
  return digest(JSON.stringify([integrationId, entries]));
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}
