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

export type WebhookAction = "dispatch" | "cancel" | "ignore";

export interface JiraWebhookResult {
  ticketKey: string;
  action: WebhookAction;
}

export function parseJiraWebhookEvent(
  payload: Record<string, any>,
  targetColumn: string,
): JiraWebhookResult {
  const ticketKey: string = payload?.issue?.key ?? "";

  if (payload?.webhookEvent !== "jira:issue_updated") {
    return { ticketKey, action: "ignore" };
  }

  const items: any[] | undefined = payload?.changelog?.items;
  if (!Array.isArray(items)) {
    return { ticketKey, action: "ignore" };
  }

  const statusChange = items.find(
    (item: any) => item.field === "status",
  );

  if (!statusChange) {
    return { ticketKey, action: "ignore" };
  }

  if (statusChange.toString === targetColumn) {
    return { ticketKey, action: "dispatch" };
  }

  if (statusChange.fromString === targetColumn) {
    return { ticketKey, action: "cancel" };
  }

  return { ticketKey, action: "ignore" };
}
