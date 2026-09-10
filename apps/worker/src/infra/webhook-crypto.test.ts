import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WebhookSecretDecryptionError,
  WebhookSecretKeyMismatchError,
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookEndpointId,
  generateWebhookSecret,
  isValidWebhookEncryptionKey,
  webhookEncryptionKeyId,
} from "./webhook-crypto.js";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const ENDPOINT = "wh_0123456789abcdef01234567";
const OTHER_ENDPOINT = "wh_fedcba9876543210fedcba98";

describe("generateWebhookEndpointId", () => {
  it("returns a prefixed 24-hex-character id", () => {
    expect(generateWebhookEndpointId()).toMatch(/^wh_[0-9a-f]{24}$/);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateWebhookEndpointId()));
    expect(ids.size).toBe(50);
  });
});

describe("generateWebhookSecret", () => {
  it("returns a prefixed 64-hex-character secret", () => {
    expect(generateWebhookSecret()).toMatch(/^whsec_[0-9a-f]{64}$/);
  });
});

describe("isValidWebhookEncryptionKey", () => {
  it("accepts exactly 64 hex characters in either case", () => {
    expect(isValidWebhookEncryptionKey(KEY)).toBe(true);
    expect(isValidWebhookEncryptionKey("A".repeat(64))).toBe(true);
  });

  it("rejects wrong lengths and non-hex characters", () => {
    expect(isValidWebhookEncryptionKey("")).toBe(false);
    expect(isValidWebhookEncryptionKey("a".repeat(63))).toBe(false);
    expect(isValidWebhookEncryptionKey("a".repeat(65))).toBe(false);
    expect(isValidWebhookEncryptionKey(`${"a".repeat(63)}z`)).toBe(false);
  });
});

describe("webhookEncryptionKeyId", () => {
  it("is the first 8 hex characters of the sha256 of the raw key bytes", () => {
    const expected = createHash("sha256")
      .update(Buffer.from(KEY, "hex"))
      .digest("hex")
      .slice(0, 8);
    expect(webhookEncryptionKeyId(KEY)).toBe(expected);
    expect(webhookEncryptionKeyId(KEY)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("ignores the hex casing of the same key and separates different keys", () => {
    expect(webhookEncryptionKeyId("A".repeat(64))).toBe(webhookEncryptionKeyId(KEY));
    expect(webhookEncryptionKeyId(OTHER_KEY)).not.toBe(webhookEncryptionKeyId(KEY));
  });
});

describe("webhook secret encryption", () => {
  it("round-trips a secret", () => {
    const secret = generateWebhookSecret();
    expect(decryptWebhookSecret(encryptWebhookSecret(secret, KEY, ENDPOINT), KEY, ENDPOINT)).toBe(
      secret,
    );
  });

  it("embeds the version and the key id, with a fresh IV per call", () => {
    const first = encryptWebhookSecret("same-plaintext", KEY, ENDPOINT);
    const second = encryptWebhookSecret("same-plaintext", KEY, ENDPOINT);
    const parts = first.split(":");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe(webhookEncryptionKeyId(KEY));
    expect(first).not.toBe(second);
  });

  it("does not leak the endpoint id it is bound to", () => {
    expect(encryptWebhookSecret("secret", KEY, ENDPOINT)).not.toContain(ENDPOINT);
  });

  it("refuses a ciphertext transplanted onto another endpoint", () => {
    const ciphertext = encryptWebhookSecret("secret", KEY, ENDPOINT);
    expect(() => decryptWebhookSecret(ciphertext, KEY, OTHER_ENDPOINT)).toThrow(
      WebhookSecretDecryptionError,
    );
    expect(() => decryptWebhookSecret(ciphertext, KEY, OTHER_ENDPOINT)).not.toThrow(
      WebhookSecretKeyMismatchError,
    );
    expect(() => decryptWebhookSecret(ciphertext, KEY, "")).toThrow(
      WebhookSecretDecryptionError,
    );
  });

  it("reports a wrong key as a key mismatch, not as tampering", () => {
    const ciphertext = encryptWebhookSecret("secret", KEY, ENDPOINT);
    expect(() => decryptWebhookSecret(ciphertext, OTHER_KEY, ENDPOINT)).toThrow(
      WebhookSecretKeyMismatchError,
    );
    expect(() => decryptWebhookSecret(ciphertext, OTHER_KEY, ENDPOINT)).not.toThrow(
      WebhookSecretDecryptionError,
    );
    try {
      decryptWebhookSecret(ciphertext, OTHER_KEY, ENDPOINT);
      expect.unreachable("decrypt should have thrown");
    } catch (error) {
      const mismatch = error as WebhookSecretKeyMismatchError;
      expect(mismatch.ciphertextKeyId).toBe(webhookEncryptionKeyId(KEY));
      expect(mismatch.configuredKeyId).toBe(webhookEncryptionKeyId(OTHER_KEY));
    }
  });

  it("rejects a tampered ciphertext body as tampering, not as a key mismatch", () => {
    const [version, keyId, iv, tag, data] = encryptWebhookSecret(
      "secret",
      KEY,
      ENDPOINT,
    ).split(":");
    const decoded = Buffer.from(data!, "base64");
    decoded[0] = decoded[0]! ^ 0xff;
    const tampered = [version, keyId, iv, tag, decoded.toString("base64")].join(":");
    expect(() => decryptWebhookSecret(tampered, KEY, ENDPOINT)).toThrow(
      WebhookSecretDecryptionError,
    );
    expect(() => decryptWebhookSecret(tampered, KEY, ENDPOINT)).not.toThrow(
      WebhookSecretKeyMismatchError,
    );
  });

  it("rejects a tampered auth tag", () => {
    const [version, keyId, iv, tag, data] = encryptWebhookSecret(
      "secret",
      KEY,
      ENDPOINT,
    ).split(":");
    const decoded = Buffer.from(tag!, "base64");
    decoded[0] = decoded[0]! ^ 0xff;
    const tampered = [version, keyId, iv, decoded.toString("base64"), data].join(":");
    expect(() => decryptWebhookSecret(tampered, KEY, ENDPOINT)).toThrow(
      WebhookSecretDecryptionError,
    );
  });

  it("rejects malformed input", () => {
    expect(() => decryptWebhookSecret("", KEY, ENDPOINT)).toThrow(/Malformed/);
    expect(() => decryptWebhookSecret("v1:a:b:c", KEY, ENDPOINT)).toThrow(/Malformed/);
    expect(() => decryptWebhookSecret("v2:aaaaaaaa:a:b:c", KEY, ENDPOINT)).toThrow(
      /Unsupported/,
    );
    expect(() => decryptWebhookSecret("v1:nothex!!:a:b:c", KEY, ENDPOINT)).toThrow(
      /Malformed/,
    );
  });

  it("rejects an envelope whose IV or tag is the wrong size", () => {
    const [, keyId, , tag, data] = encryptWebhookSecret("secret", KEY, ENDPOINT).split(":");
    const shortIv = Buffer.alloc(8).toString("base64");
    expect(() =>
      decryptWebhookSecret(["v1", keyId, shortIv, tag, data].join(":"), KEY, ENDPOINT),
    ).toThrow(/Malformed/);
  });

  it("rejects an invalid encryption key outright", () => {
    expect(() => encryptWebhookSecret("secret", "nope", ENDPOINT)).toThrow(
      /64 hex characters/,
    );
    expect(() => webhookEncryptionKeyId("nope")).toThrow(/64 hex characters/);
  });
});
