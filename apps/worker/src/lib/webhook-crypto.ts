import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Public endpoint id: opaque, URL-safe, and long enough that the path segment
 *  itself is not guessable. */
export function generateWebhookEndpointId(): string {
  return `wh_${randomBytes(12).toString("hex")}`;
}

/** Shown to the operator exactly once, then stored encrypted. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

/** AES-256 needs 32 bytes; the env var carries them as lowercase or uppercase hex. */
export function isValidWebhookEncryptionKey(key: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(key);
}

/**
 * Non-secret fingerprint of an encryption key, embedded in every ciphertext.
 * Truncated to 8 hex chars: enough to tell "this row was written under a
 * different key" apart from "this row was tampered with", and far too short to
 * help an attacker recover the key.
 */
export function webhookEncryptionKeyId(keyHex: string): string {
  return createHash("sha256").update(keyBuffer(keyHex)).digest("hex").slice(0, 8);
}

/** Structure is wrong, the GCM tag does not verify, the body was altered, or the
 *  row belongs to a different endpoint. Deliberately does not say which: they all
 *  mean "do not trust this row". */
export class WebhookSecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSecretDecryptionError";
  }
}

/** The row was encrypted under a different key. Distinct from the error above
 *  because the operator fix is different: restore the old
 *  WEBHOOK_TRIGGER_ENCRYPTION_KEY rather than investigate tampering. */
export class WebhookSecretKeyMismatchError extends Error {
  readonly ciphertextKeyId: string;
  readonly configuredKeyId: string;

  constructor(ciphertextKeyId: string, configuredKeyId: string) {
    super(
      `Webhook secret was encrypted under key ${ciphertextKeyId}, but the configured key is ${configuredKeyId}`,
    );
    this.name = "WebhookSecretKeyMismatchError";
    this.ciphertextKeyId = ciphertextKeyId;
    this.configuredKeyId = configuredKeyId;
  }
}

const CIPHERTEXT_VERSION = "v1";
const KEY_ID_LENGTH = 8;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function keyBuffer(keyHex: string): Buffer {
  if (!isValidWebhookEncryptionKey(keyHex)) {
    throw new Error(
      "Invalid webhook encryption key: expected 64 hex characters (32 bytes)",
    );
  }
  return Buffer.from(keyHex, "hex");
}

/**
 * Encrypt a webhook secret with AES-256-GCM under a random 12-byte IV.
 * The result is self-describing ("v1:<keyId>:<iv>:<tag>:<ciphertext>", the last
 * three base64) so a future algorithm change and, more usefully, a swapped
 * encryption key can be told apart on read instead of surfacing as a generic
 * decryption failure.
 *
 * The endpoint id is bound in as GCM additional authenticated data. It is
 * deliberately NOT stored in the envelope: a ciphertext copied into another
 * endpoint's row then fails its tag instead of quietly authenticating that
 * endpoint's deliveries.
 */
export function encryptWebhookSecret(
  plaintext: string,
  keyHex: string,
  endpointId: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer(keyHex), iv);
  cipher.setAAD(Buffer.from(endpointId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    CIPHERTEXT_VERSION,
    webhookEncryptionKeyId(keyHex),
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Inverse of encryptWebhookSecret; endpointId must be the one the row was
 *  written under. Throws WebhookSecretKeyMismatchError when the embedded key id
 *  rules out the configured key, and WebhookSecretDecryptionError for a
 *  malformed envelope, a foreign endpoint id, or a failed GCM tag. */
export function decryptWebhookSecret(
  ciphertext: string,
  keyHex: string,
  endpointId: string,
): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 5) {
    throw new WebhookSecretDecryptionError("Malformed webhook secret ciphertext");
  }
  const [version, keyId, ivB64, tagB64, dataB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== CIPHERTEXT_VERSION) {
    throw new WebhookSecretDecryptionError(
      `Unsupported webhook secret ciphertext version "${version}"`,
    );
  }
  if (!new RegExp(`^[0-9a-f]{${KEY_ID_LENGTH}}$`).test(keyId)) {
    throw new WebhookSecretDecryptionError("Malformed webhook secret ciphertext");
  }
  // Checked before any decrypt attempt so a rotated key reports itself instead
  // of looking like a tampered row.
  const configuredKeyId = webhookEncryptionKeyId(keyHex);
  if (keyId !== configuredKeyId) {
    throw new WebhookSecretKeyMismatchError(keyId, configuredKeyId);
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new WebhookSecretDecryptionError("Malformed webhook secret ciphertext");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyBuffer(keyHex), iv);
  decipher.setAAD(Buffer.from(endpointId, "utf8"));
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new WebhookSecretDecryptionError(
      "Failed to decrypt webhook secret: wrong endpoint or tampered ciphertext",
    );
  }
}
