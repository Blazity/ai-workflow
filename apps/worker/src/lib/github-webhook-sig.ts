import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a GitHub-style X-Hub-Signature-256 header against the raw body.
 * Throws when the signature is missing, malformed, or does not match.
 *
 * Header format: "sha256=<hex>". GitHub always uses sha256 on this header.
 */
export function verifyGitHubWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): void {
  if (!signatureHeader) {
    throw new Error("Missing X-Hub-Signature-256 header");
  }
  const [method, receivedHex] = signatureHeader.split("=", 2);
  if (method !== "sha256" || !receivedHex) {
    throw new Error("Malformed X-Hub-Signature-256 header");
  }
  const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(receivedHex, "hex");
  const b = Buffer.from(expectedHex, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid webhook signature");
  }
}
