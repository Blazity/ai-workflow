import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyJiraWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");

  const sigBuf = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);

  if (sigBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(sigBuf, expectedBuf);
}

export interface JiraWebhookResult {
  ticketKey: string;
  relevant: boolean;
}

export function parseJiraWebhookEvent(
  payload: Record<string, any>,
  targetColumn: string,
): JiraWebhookResult {
  const ticketKey: string = payload?.issue?.key ?? "";

  if (payload?.webhookEvent !== "jira:issue_updated") {
    return { ticketKey, relevant: false };
  }

  const items: any[] | undefined = payload?.changelog?.items;
  if (!Array.isArray(items)) {
    return { ticketKey, relevant: false };
  }

  const statusChange = items.find(
    (item: any) => item.field === "status" && item.toString === targetColumn,
  );

  return { ticketKey, relevant: !!statusChange };
}
