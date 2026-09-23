import { type ConnectionField, type IntegrationManifest, integrationSettingKey } from "@integrations/sdk";
import type {
  IntegrationFailure,
  IntegrationMovedValueDto,
  IntegrationSource,
} from "@shared/contracts";

import {
  IntegrationSecretCorruptedError,
  IntegrationSecretForeignScopeError,
  IntegrationSecretKeyMismatchError,
  decryptIntegrationSecret,
} from "../../infra/secrets-crypto.js";
import {
  type IntegrationEnvironmentReader,
  type StoredIntegrationVersion,
  normalizeConnectionValue,
} from "./resolve.js";
import { malformedValueFailure } from "./value-problems.js";

/**
 * The values an integration's own code receives, and the redaction that keeps
 * them from coming back out.
 *
 * Server only, and the one place a secret is turned back into plaintext. Its
 * result never reaches a response type: the resolver decides what a caller is
 * told, and this decides what the provider is called with.
 */

/** The key this deployment holds, with the material. Distinct from the state the
 *  resolver takes, which deliberately carries only the id. */
export type IntegrationSecretsKeyMaterial =
  | { readonly present: true; readonly keyId: string; readonly key: string }
  | { readonly present: false };

export type ConnectionValue = string | number | undefined;

export type ConnectionValuesResult =
  | { readonly ok: true; readonly values: Record<string, ConnectionValue> }
  | { readonly ok: false; readonly failure: IntegrationFailure };

export function readConnectionValues(input: {
  readonly manifest: IntegrationManifest;
  readonly source: IntegrationSource;
  readonly environment: IntegrationEnvironmentReader;
  readonly active: StoredIntegrationVersion | null;
  readonly secretsKey: IntegrationSecretsKeyMaterial;
}): ConnectionValuesResult {
  const values: Record<string, ConnectionValue> = {};
  for (const field of input.manifest.connection.fields) {
    const raw =
      input.source === "environment"
        ? input.environment.value(field.env)
        : field.secret
          ? readStoredSecret(input, field)
          : input.active?.config[field.key];
    if (raw !== null && typeof raw === "object") return raw;
    // The same normalization the save and the fingerprint use, so the provider
    // is called with exactly the string that was stored and pinned. A multiline
    // value keeps its shape: a PEM key handed over without its newlines is not
    // the key that was saved.
    const text =
      typeof raw === "string" && raw.trim().length > 0
        ? normalizeConnectionValue(raw, field)
        : undefined;
    // A value that cannot be what its field is stops here, named, rather than
    // reaching a provider as a request that fails for a reason nobody can read
    // (an integer field read as NaN, a URL `fetch` refuses to parse). The
    // resolver says the same about the values it can see.
    const malformed = text === undefined ? null : malformedValueFailure(field, text, input.source);
    if (malformed) return { ok: false, failure: malformed };
    const resolved = text ?? field.default;
    if (resolved === undefined) {
      values[field.key] = undefined;
      continue;
    }
    values[field.key] = field.format === "integer" ? Number(resolved) : resolved;
  }
  return { ok: true, values };
}

/**
 * What a stored connection version holds under the key of one of the
 * integration's operator settings, and is therefore not read.
 *
 * Slack's allowlist was a connection field (`allowedUserIds`) until it became
 * a setting. A version saved before that still carries it in `config`, and no
 * reader of a connection knows the key any more: the setting applies instead,
 * read from its stored row, else its variable, else its default. With neither
 * set, a stored allowlist that used to keep the command to a few people now
 * lets the whole workspace in, so this is what the card shows and the webhook
 * read logs instead of staying quiet. It disappears on the next save, which
 * builds a version from the connection fields alone.
 */
export function storedValuesMovedToSettings(
  manifest: IntegrationManifest,
  active: StoredIntegrationVersion | null,
): IntegrationMovedValueDto[] {
  if (!active) return [];
  return (manifest.settings ?? [])
    .filter((setting) => (active.config[setting.key] ?? "").trim().length > 0)
    .map((setting) => ({ key: setting.key, setting: integrationSettingKey(manifest.id, setting.key) }));
}

/**
 * The part of a connection a webhook that declared what it reads
 * (`webhook.requires`) is served on, read now.
 *
 * One question with two askers: the webhook route serves on the answer
 * (through `resolveUsableIntegrations`), and the integration's card says from
 * it whether the webhook is answered (`IntegrationDto.webhook`), so the card
 * cannot call a command answered that the route refuses, or the other way
 * round. Nothing else of the connection is asked for: Slack's slash command is
 * answered on its signing secret alone.
 *
 * Not served with a failure: a declared field could not be read (a stored
 * secret under another key, a value its field refuses). Without one: a declared
 * field has no value in the active source. Whether the integration is switched
 * on is each caller's first question, as it is for every other use.
 */
export function readWebhookConnection(input: {
  readonly manifest: IntegrationManifest;
  readonly requires: readonly string[];
  readonly source: IntegrationSource;
  readonly environment: IntegrationEnvironmentReader;
  readonly active: StoredIntegrationVersion | null;
  readonly secretsKey: IntegrationSecretsKeyMaterial;
}):
  | {
      readonly served: true;
      /** The manifest narrowed to the declared fields, which is what the
       *  webhook's context is built from. */
      readonly manifest: IntegrationManifest;
      readonly values: Record<string, ConnectionValue>;
    }
  | { readonly served: false; readonly failure: IntegrationFailure | null } {
  const manifest: IntegrationManifest = {
    ...input.manifest,
    connection: {
      fields: input.manifest.connection.fields.filter((field) =>
        input.requires.includes(field.key),
      ),
    },
  };
  const read = readConnectionValues({ ...input, manifest });
  if (!read.ok) return { served: false, failure: read.failure };
  if (input.requires.some((key) => read.values[key] === undefined)) {
    return { served: false, failure: null };
  }
  return { served: true, manifest, values: read.values };
}

/**
 * One stored secret, or the failure that says what to do about it.
 *
 * Returns the failure object itself rather than throwing, because each of the
 * four ways this can go wrong needs a different action from an admin and a
 * thrown error would arrive at a caller that only knows "it did not work".
 */
function readStoredSecret(
  input: {
    readonly manifest: IntegrationManifest;
    readonly active: StoredIntegrationVersion | null;
    readonly secretsKey: IntegrationSecretsKeyMaterial;
  },
  field: ConnectionField,
): string | undefined | { ok: false; failure: IntegrationFailure } {
  const envelope = input.active?.secrets[field.key];
  if (envelope === undefined || envelope.trim().length === 0) return undefined;
  if (!input.secretsKey.present) {
    return {
      ok: false,
      failure: {
        reason: "secrets_key_missing",
        message:
          "Set INTEGRATION_SECRETS_KEY on this deployment to use stored secrets; it is not the webhook key",
      },
    };
  }
  try {
    return decryptIntegrationSecret(envelope, input.secretsKey.key, {
      integrationId: input.manifest.id,
      fieldKey: field.key,
    });
  } catch (error) {
    return { ok: false, failure: secretFailure(error, field) };
  }
}

function secretFailure(error: unknown, field: ConnectionField): IntegrationFailure {
  if (error instanceof IntegrationSecretKeyMismatchError) {
    return {
      reason: "secrets_key_mismatch",
      message: `The stored ${field.label} was written under another key; enter it again`,
    };
  }
  if (error instanceof IntegrationSecretForeignScopeError) {
    return {
      reason: "secret_foreign",
      message: `The stored ${field.label} belongs to another integration; enter it again`,
    };
  }
  if (error instanceof IntegrationSecretCorruptedError) {
    return {
      reason: "secret_corrupted",
      message: `The stored ${field.label} failed its integrity check; enter it again`,
    };
  }
  return {
    reason: "secret_corrupted",
    message: `The stored ${field.label} could not be read; enter it again`,
  };
}

/**
 * Anything a provider said, with this connection's own secrets taken out.
 *
 * Providers do echo credentials: a rejected request comes back with the header
 * that was sent, and that message is the one an admin reads on the card, the one
 * stored on the version row, and the one this worker writes to its log.
 *
 * A value the manifest declares secret is removed by exact match whatever its
 * length. A short credential is a bad credential, not a public one, and leaving
 * a four-character token in the log because it was short is exactly the leak
 * this function exists to prevent. The length floor applies only to the
 * heuristic pass below, which looks for the value inside longer runs of text
 * where a two-character match would be a coincidence rather than a credential.
 */
const HEURISTIC_FLOOR = 8;

export function redactIntegrationText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[redacted]");
    if (secret.length < HEURISTIC_FLOOR) continue;
    // Providers percent-encode, JSON-escape and base64 what they echo. The
    // encoded forms of a value long enough to be unmistakable are worth
    // catching too; a short one is not, because a coincidence would mangle the
    // sentence an admin has to read.
    for (const encoded of [encodeURIComponent(secret), Buffer.from(secret, "utf8").toString("base64")]) {
      if (encoded !== secret) out = out.split(encoded).join("[redacted]");
    }
  }
  return out;
}

/** The secret values of a resolved connection, for redaction. */
export function secretValuesOf(
  manifest: IntegrationManifest,
  values: Readonly<Record<string, ConnectionValue>>,
): string[] {
  return manifest.connection.fields
    .filter((field) => field.secret)
    .map((field) => values[field.key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}
