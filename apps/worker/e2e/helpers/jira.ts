import { e2eEnv } from "../env.js";

const ATLASSIAN_API_ORIGIN = "https://api.atlassian.com";
const authHeader = `Bearer ${e2eEnv.JIRA_API_TOKEN}`;

let cloudIdPromise: Promise<string> | null = null;
function getCloudId(): Promise<string> {
  if (cloudIdPromise) return cloudIdPromise;
  cloudIdPromise = (async () => {
    const tenantOrigin = new URL(e2eEnv.JIRA_BASE_URL).origin;
    const res = await fetch(`${tenantOrigin}/_edge/tenant_info`);
    if (!res.ok) {
      throw new Error(
        `Jira cloudId discovery failed: ${res.status} ${res.statusText}`,
      );
    }
    const data = (await res.json()) as { cloudId?: unknown };
    if (typeof data?.cloudId !== "string" || data.cloudId === "") {
      throw new Error("Jira cloudId discovery: missing cloudId in response");
    }
    return data.cloudId;
  })().catch((err) => {
    cloudIdPromise = null;
    throw err;
  });
  return cloudIdPromise;
}

async function apiUrl(path: string): Promise<string> {
  const cloudId = await getCloudId();
  return `${ATLASSIAN_API_ORIGIN}/ex/jira/${cloudId}${path}`;
}

async function jiraRequest(path: string, options?: RequestInit) {
  const res = await fetch(await apiUrl(path), {
    ...options,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Jira API error: ${res.status} ${res.statusText} on ${path} — ${text}`,
    );
  }
  if (res.status === 204) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function createTestTicket(
  overrides: { summary?: string; description?: string; labels?: string[] } = {},
): Promise<{ ticketKey: string; ticketId: string }> {
  const summary =
    overrides.summary ?? `[E2E] test-${crypto.randomUUID().slice(0, 8)}`;
  const description = overrides.description ?? "Automated e2e test ticket";

  // Per-ticket agent override label, set by the e2e workflow input. The
  // deployed app's agent.ts reads `agent:<kind>` labels via
  // parseAgentKindOverride to decide which adapter to spin up.
  const envAgent = process.env.E2E_AGENT_KIND?.toLowerCase();
  const autoLabels =
    envAgent === "codex" || envAgent === "claude" ? [`agent:${envAgent}`] : [];
  // Strip any caller-supplied agent:* labels so the env-driven autoLabel wins
  // and the parseAgentKindOverride lookup never sees conflicting entries.
  const filteredOverrides = (overrides.labels ?? []).filter(
    (l) => !/^agent:/i.test(l),
  );
  const labels = [...autoLabels, ...filteredOverrides];

  const data = await jiraRequest("/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: e2eEnv.JIRA_PROJECT_KEY },
        summary,
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: description }],
            },
          ],
        },
        issuetype: { name: "Task" },
        ...(labels.length ? { labels } : {}),
      },
    }),
  });

  return { ticketKey: data.key, ticketId: data.id };
}

export async function moveTicketToColumn(
  ticketKey: string,
  column: string,
): Promise<void> {
  const data = await jiraRequest(
    `/rest/api/3/issue/${ticketKey}/transitions`,
  );
  const transition = data.transitions.find(
    (t: any) => t.name.toLowerCase() === column.toLowerCase(),
  );
  if (!transition) {
    throw new Error(
      `No transition to "${column}" for ${ticketKey}. Available: ${data.transitions.map((t: any) => t.name).join(", ")}`,
    );
  }
  await jiraRequest(`/rest/api/3/issue/${ticketKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: transition.id } }),
  });
}

export async function getTicketStatus(ticketKey: string): Promise<string> {
  const data = await jiraRequest(
    `/rest/api/3/issue/${ticketKey}?fields=status`,
  );
  return data.fields.status.name;
}

export async function getTicketLabels(ticketKey: string): Promise<string[]> {
  const data = await jiraRequest(
    `/rest/api/3/issue/${ticketKey}?fields=labels`,
  );
  return Array.isArray(data?.fields?.labels) ? data.fields.labels : [];
}

/**
 * Ask Jira's search API whether `ticketKey` is currently visible under the
 * given status. Unlike `/issue/{key}` (which returns committed state), the
 * search endpoint hits an index that lags transitions by seconds or more.
 *
 * Cron's reconcile uses the same JQL-backed index to decide which tickets
 * are in the AI column; tests that move a ticket and then immediately poke
 * cron will race this lag and see a stale snapshot. Use this helper as a
 * barrier between `moveTicketToColumn` and `callCronPoll`.
 */
export async function isTicketVisibleInJql(
  ticketKey: string,
  status: string,
): Promise<boolean> {
  const jql = `project = "${e2eEnv.JIRA_PROJECT_KEY}" AND status = "${status}" AND key = "${ticketKey}"`;
  const data = await jiraRequest(
    `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=1`,
  ).catch(() => null);
  const issues = data?.issues ?? [];
  return issues.some((i: { key?: string }) => i.key === ticketKey);
}

export async function getTicketComments(
  ticketKey: string,
): Promise<Array<{ author: string; body: string }>> {
  const data = await jiraRequest(
    `/rest/api/3/issue/${ticketKey}?fields=comment`,
  );
  return (data.fields.comment?.comments ?? []).map((c: any) => ({
    author: c.author?.displayName ?? "unknown",
    body: extractAdfText(c.body),
  }));
}

export async function postComment(
  ticketKey: string,
  comment: string,
): Promise<void> {
  await jiraRequest(`/rest/api/3/issue/${ticketKey}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: comment }],
          },
        ],
      },
    }),
  });
}

/**
 * Post a comment as a SECOND Jira identity (a bearer token distinct from
 * JIRA_API_TOKEN). Used by US-06 so the clarification answer comes from a
 * non-bot account: the resume path filters the bot's own comments by accountId,
 * so an answer posted with the bot token can never resume the run. Additive:
 * `postComment` (bot identity) is unchanged. The per-call auth override rides
 * jiraRequest's header merge (options.headers wins over the default header).
 */
export async function postCommentAs(
  ticketKey: string,
  comment: string,
  token: string,
): Promise<void> {
  await jiraRequest(`/rest/api/3/issue/${ticketKey}/comment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: comment }],
          },
        ],
      },
    }),
  });
}

export async function deleteTicket(ticketKey: string): Promise<void> {
  // Only delete tickets created by e2e tests
  const data = await jiraRequest(
    `/rest/api/3/issue/${ticketKey}?fields=summary`,
  ).catch(() => null);
  if (!data?.fields?.summary?.startsWith("[E2E]")) return;

  await jiraRequest(`/rest/api/3/issue/${ticketKey}`, {
    method: "DELETE",
  }).catch(() => {});
}

export async function addAttachment(
  ticketKey: string,
  filename: string,
  content: Buffer,
): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(content)]), filename);

  const res = await fetch(
    await apiUrl(`/rest/api/3/issue/${ticketKey}/attachments`),
    {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "X-Atlassian-Token": "no-check",
      },
      body: form,
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira attachment upload failed: ${res.status} — ${text}`);
  }
}

export async function getTicketAttachments(
  ticketKey: string,
): Promise<
  Array<{
    id: string;
    filename: string;
    size: number;
    mimeType: string;
    contentUrl: string;
  }>
> {
  const data = await jiraRequest(
    `/rest/api/3/issue/${ticketKey}?fields=attachment`,
  );
  return (data.fields.attachment ?? []).map((a: any) => ({
    id: a.id,
    filename: a.filename,
    size: a.size,
    mimeType: a.mimeType,
    contentUrl: a.content,
  }));
}

export async function downloadJiraAttachment(
  contentUrl: string,
): Promise<Buffer> {
  const tenantOrigin = new URL(e2eEnv.JIRA_BASE_URL).origin;
  const parsed = new URL(contentUrl);
  const url =
    parsed.origin === tenantOrigin
      ? `${ATLASSIAN_API_ORIGIN}/ex/jira/${await getCloudId()}${parsed.pathname}${parsed.search}`
      : contentUrl;
  const res = await fetch(url, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) {
    throw new Error(`Attachment download failed: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function extractAdfText(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.text) return adf.text;
  if (adf.content) return adf.content.map(extractAdfText).join("\n");
  return "";
}
