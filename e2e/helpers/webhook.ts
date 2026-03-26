import { createHmac } from "node:crypto";
import { e2eEnv } from "../env.js";

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function bypassHeaders(): Record<string, string> {
  const secret = e2eEnv.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) return {};
  return { "x-vercel-protection-bypass": secret };
}

export interface WebhookOptions {
  invalidSignature?: boolean;
  omitSignature?: boolean;
}

export function makeDispatchPayload(ticketKey: string) {
  return {
    webhookEvent: "jira:issue_updated",
    issue: { key: ticketKey },
    changelog: {
      items: [
        {
          field: "status",
          fromString: "To Do",
          toString: e2eEnv.COLUMN_AI,
        },
      ],
    },
  };
}

export function makeCancelPayload(ticketKey: string) {
  return {
    webhookEvent: "jira:issue_updated",
    issue: { key: ticketKey },
    changelog: {
      items: [
        {
          field: "status",
          fromString: e2eEnv.COLUMN_AI,
          toString: "In Progress",
        },
      ],
    },
  };
}

export function makeIgnorePayload(ticketKey: string) {
  return {
    webhookEvent: "jira:issue_updated",
    issue: { key: ticketKey },
    changelog: {
      items: [
        {
          field: "summary",
          fromString: "Old title",
          toString: "New title",
        },
      ],
    },
  };
}

export async function sendJiraWebhook(
  payload: Record<string, any>,
  options: WebhookOptions = {},
): Promise<{ status: number; body: any }> {
  const rawBody = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...bypassHeaders(),
  };

  if (!options.omitSignature) {
    if (options.invalidSignature) {
      headers["x-hub-signature"] = "sha256=invalid";
    } else {
      headers["x-hub-signature"] = sign(rawBody, e2eEnv.JIRA_WEBHOOK_SECRET);
    }
  }

  const res = await fetch(`${e2eEnv.E2E_BASE_URL}/webhooks/jira`, {
    method: "POST",
    headers,
    body: rawBody,
  });

  let body: any;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { status: res.status, body };
}

export async function callCronPoll(opts?: {
  omitAuth?: boolean;
}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...bypassHeaders() };
  if (!opts?.omitAuth) {
    headers["Authorization"] = `Bearer ${e2eEnv.CRON_SECRET}`;
  }

  const res = await fetch(`${e2eEnv.E2E_BASE_URL}/cron/poll`, {
    method: "GET",
    headers,
  });

  let body: any;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { status: res.status, body };
}
