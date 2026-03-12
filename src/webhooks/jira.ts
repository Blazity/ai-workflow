import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { TicketTransitionEvent } from "./types.js";

const changelogItemSchema = z.object({
  field: z.string(),
  fieldtype: z.string(),
  fromString: z.string().nullable().transform((v) => v ?? ""),
  toString: z.string(),
});

const jiraWebhookSchema = z.object({
  user: z.object({
    accountId: z.string(),
    displayName: z.string(),
  }),
  issue: z.object({
    key: z.string(),
  }),
  changelog: z.object({
    items: z.array(changelogItemSchema),
  }),
});

export function verifyJiraWebhookSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function parseJiraWebhook(
  body: unknown,
): TicketTransitionEvent | null {
  const parsed = jiraWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }

  const { user, issue, changelog } = parsed.data;
  const statusChange = changelog.items.find(
    (item) => item.field === "status",
  );

  if (!statusChange) {
    return null;
  }

  return {
    source: "jira",
    externalTicketId: issue.key,
    fromColumn: statusChange.fromString,
    toColumn: statusChange.toString,
    actor: user.displayName,
  };
}
