import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { isValidIntegrationSecretsKey } from "./secrets-key-format.js";

/**
 * Encryption for the connection secrets an admin stores from the dashboard.
 *
 * Separate from `webhook-crypto.ts` and under its own key
 * (`INTEGRATION_SECRETS_KEY`), because the two protect different things for
 * different people: a webhook secret proves an inbound request, an integration
 * secret is a customer's credential at a third party. One key per database, so
 * every deployment that reads the database can read the rows; rotating one key
 * must not silently invalidate the other's rows.
 *
 * Shape: `v1:<keyId>:<scope>:<iv>:<tag>:<ciphertext>`, the last three base64.
 * Self-describing on purpose, because the four ways a stored secret can fail to
 * read need four different actions from an admin, and a single "decryption
 * failed" sends them to rotate a token at the provider when the row is simply
 * under another key.
 *
 * `scope` is `<integration id>.<field key>`: the slot this ciphertext was
 * written for. It is also the GCM additional authenticated data, so it cannot be
 * edited without breaking the tag. Unlike `webhook-crypto`, which deliberately
 * keeps the endpoint id out of the envelope, it is stored in the clear: neither
 * half is a secret (both appear in the manifest and in the URL), and having it
 * readable is what lets a read say "this row belongs to another integration"
 * instead of "this row is damaged".
 */

export { isValidIntegrationSecretsKey } from "./secrets-key-format.js";

/** The slot a ciphertext belongs to. Both halves come from the manifest. */
export interface IntegrationSecretScope {
  readonly integrationId: string;
  readonly fieldKey: string;
}

/**
 * Non-secret fingerprint of the key, embedded in every ciphertext. Eight hex
 * characters: enough to tell "written under another key" apart from "damaged",
 * far too short to help recover the key.
 */
export function integrationSecretsKeyId(keyHex: string): string {
  return createHash("sha256").update(keyBuffer(keyHex)).digest("hex").slice(0, 8);
}

/** The row was written under another key. Fix: restore that key, or enter the value again. */
export class IntegrationSecretKeyMismatchError extends Error {
  readonly ciphertextKeyId: string;
  readonly configuredKeyId: string;

  constructor(ciphertextKeyId: string, configuredKeyId: string) {
    super(
      `Stored under key ${ciphertextKeyId}, but this deployment's key is ${configuredKeyId}`,
    );
    this.name = "IntegrationSecretKeyMismatchError";
    this.ciphertextKeyId = ciphertextKeyId;
    this.configuredKeyId = configuredKeyId;
  }
}

/** The row belongs to another integration or another field. Fix: nothing an admin
 *  does at the provider; the row was copied into the wrong slot. */
export class IntegrationSecretForeignScopeError extends Error {
  readonly ciphertextScope: string;
  readonly expectedScope: string;

  constructor(ciphertextScope: string, expectedScope: string) {
    super(
      `Stored secret belongs to ${ciphertextScope}, but this slot is ${expectedScope}`,
    );
    this.name = "IntegrationSecretForeignScopeError";
    this.ciphertextScope = ciphertextScope;
    this.expectedScope = expectedScope;
  }
}

/** Right key, right slot, and the tag still does not verify: the bytes changed. */
export class IntegrationSecretCorruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationSecretCorruptedError";
  }
}

const CIPHERTEXT_VERSION = "v1";
const KEY_ID_LENGTH = 8;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const ENVELOPE_PARTS = 6;

/**
 * The envelope as text, for a leak test to search for. A response that carries
 * one is as much of a bug as one carrying the plaintext: it hands an attacker
 * the ciphertext to work on offline and tells them which key wrote it.
 */
const ENVELOPE_PATTERN =
  /v1:[0-9a-f]{8}:[a-z][a-z0-9]*\.[A-Za-z][A-Za-z0-9]*:[A-Za-z0-9+/=]{12,}:[A-Za-z0-9+/=]{16,}:[A-Za-z0-9+/=]*/;

export function looksLikeIntegrationSecret(text: string): boolean {
  return ENVELOPE_PATTERN.test(text);
}

function scopeText(scope: IntegrationSecretScope): string {
  return `${scope.integrationId}.${scope.fieldKey}`;
}

function keyBuffer(keyHex: string): Buffer {
  if (!isValidIntegrationSecretsKey(keyHex)) {
    // Defensive: every caller checks isValidIntegrationSecretsKey first and
    // reports the absent key as a status, so reaching here is a bug rather than
    // a state an admin can be in, and a plain Error says exactly that.
    throw new Error("INTEGRATION_SECRETS_KEY must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(keyHex, "hex");
}

export function encryptIntegrationSecret(
  plaintext: string,
  keyHex: string,
  scope: IntegrationSecretScope,
): string {
  const slot = scopeText(scope);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer(keyHex), iv);
  cipher.setAAD(Buffer.from(slot, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    CIPHERTEXT_VERSION,
    integrationSecretsKeyId(keyHex),
    slot,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** What a stored envelope says about itself, without the key. Null when the
 *  string is not one of ours at all. */
export function readIntegrationSecretEnvelope(
  ciphertext: string,
): { keyId: string; scope: string } | null {
  const parts = ciphertext.split(":");
  if (parts.length !== ENVELOPE_PARTS) return null;
  const [version, keyId, scope] = parts as [string, string, string, string, string, string];
  if (version !== CIPHERTEXT_VERSION) return null;
  if (!new RegExp(`^[0-9a-f]{${KEY_ID_LENGTH}}$`).test(keyId)) return null;
  return { keyId, scope };
}

export function decryptIntegrationSecret(
  ciphertext: string,
  keyHex: string,
  scope: IntegrationSecretScope,
): string {
  const header = readIntegrationSecretEnvelope(ciphertext);
  if (!header) {
    throw new IntegrationSecretCorruptedError("Malformed stored secret");
  }
  // Key first, then slot, then the tag: each answer rules out the ones after it,
  // and the admin action for each is different.
  const configuredKeyId = integrationSecretsKeyId(keyHex);
  if (header.keyId !== configuredKeyId) {
    throw new IntegrationSecretKeyMismatchError(header.keyId, configuredKeyId);
  }
  const slot = scopeText(scope);
  if (header.scope !== slot) {
    throw new IntegrationSecretForeignScopeError(header.scope, slot);
  }
  const [, , , ivB64, tagB64, dataB64] = ciphertext.split(":") as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new IntegrationSecretCorruptedError("Malformed stored secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyBuffer(keyHex), iv);
  decipher.setAAD(Buffer.from(slot, "utf8"));
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new IntegrationSecretCorruptedError(
      "Stored secret failed its integrity check; enter it again",
    );
  }
}
