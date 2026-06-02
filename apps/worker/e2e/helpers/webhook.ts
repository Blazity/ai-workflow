import { createHmac } from "node:crypto";
import { e2eEnv } from "../env.js";

export interface JiraWebhookPayload {
  ticketKey: string;
  status: string;
  projectKey?: string;
  webhookEvent?: string;
}

/**
 * Send a signed Jira webhook payload to the deployed /webhooks/jira endpoint.
 *
 * Useful for tests that need to exercise the webhook dispatch path with a
 * controlled payload (e.g. simulating a stale status in the webhook body
 * vs. the live ticket state).
 */
export async function postJiraWebhook(
  payload: JiraWebhookPayload,
): Promise<{ status: number; body: any }> {
  const secret = e2eEnv.JIRA_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "JIRA_WEBHOOK_SECRET is not set — required for webhook signing in US-12",
    );
  }

  const body = JSON.stringify({
    webhookEvent: payload.webhookEvent ?? "jira:issue_updated",
    issue: {
      key: payload.ticketKey,
      fields: {
        status: { name: payload.status },
        project: { key: payload.projectKey ?? e2eEnv.JIRA_PROJECT_KEY },
      },
    },
  });

  const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Hub-Signature": `sha256=${signature}`,
  };
  if (e2eEnv.VERCEL_AUTOMATION_BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] = e2eEnv.VERCEL_AUTOMATION_BYPASS_SECRET;
  }

  const res = await fetch(`${e2eEnv.E2E_BASE_URL}/webhooks/jira`, {
    method: "POST",
    headers,
    body,
  });

  let responseBody: any;
  try {
    responseBody = await res.json();
  } catch {
    responseBody = null;
  }

  return { status: res.status, body: responseBody };
}
