import { createHmac, timingSafeEqual } from "node:crypto";

const REPLAY_WINDOW_SECONDS = 60 * 5;
const SIGNATURE_PREFIX = "v0=";

export interface VerifySlackSignatureInput {
  rawBody: string;
  timestamp: string;
  signature: string;
  signingSecret: string;
}

/**
 * Verify Slack's `x-slack-signature` HMAC, per
 * https://api.slack.com/authentication/verifying-requests-from-slack.
 *
 * The 5-minute replay window protects against attackers replaying a captured
 * (and otherwise valid) signed request long after Slack would have retried.
 */
export function verifySlackSignature(input: VerifySlackSignatureInput): boolean {
  const { rawBody, timestamp, signature, signingSecret } = input;

  if (!signature.startsWith(SIGNATURE_PREFIX)) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > REPLAY_WINDOW_SECONDS) return false;

  const expected = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  const expectedFull = SIGNATURE_PREFIX + expected;

  const a = Buffer.from(signature);
  const b = Buffer.from(expectedFull);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
