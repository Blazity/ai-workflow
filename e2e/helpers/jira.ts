import { e2eEnv } from "../env.js";

const authHeader =
  "Basic " +
  Buffer.from(`${e2eEnv.JIRA_EMAIL}:${e2eEnv.JIRA_API_TOKEN}`).toString(
    "base64",
  );

async function jiraRequest(path: string, options?: RequestInit) {
  const res = await fetch(`${e2eEnv.JIRA_BASE_URL}${path}`, {
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
  overrides: { summary?: string; description?: string } = {},
): Promise<{ ticketKey: string; ticketId: string }> {
  const summary =
    overrides.summary ?? `[E2E] test-${crypto.randomUUID().slice(0, 8)}`;
  const description = overrides.description ?? "Automated e2e test ticket";

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

function extractAdfText(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.text) return adf.text;
  if (adf.content) return adf.content.map(extractAdfText).join("\n");
  return "";
}
