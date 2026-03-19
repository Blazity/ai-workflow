import { z } from "zod";
import type { NormalizedEvent } from "./ticket.js";

const changelogItemSchema = z.object({
  field: z.string(),
  fieldtype: z.string(),
  fromString: z
    .string()
    .nullable()
    .transform((v) => v ?? ""),
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

export function parseJiraWebhook(body: unknown): NormalizedEvent | null {
  const parsed = jiraWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }

  const { user, issue, changelog } = parsed.data;
  const statusChange = changelog.items.find((item) => item.field === "status");

  if (!statusChange) {
    return null;
  }

  return {
    type: "ticket_moved",
    ticketId: issue.key,
    fromColumn: statusChange.fromString,
    toColumn: statusChange.toString,
    triggeredBy: user.displayName,
    triggeredByAccountId: user.accountId,
  };
}
