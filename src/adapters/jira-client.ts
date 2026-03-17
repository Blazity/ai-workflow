import { parseJiraWebhook } from "../webhooks/jira.js";
import type { NormalizedEvent, Ticket, TicketAdapter, TicketComment } from "./ticket.js";

export class JiraClient implements TicketAdapter {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(baseUrl: string, email: string, apiToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authHeader =
      "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  }

  private async request(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
        ...options.headers,
      },
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`Jira API error: ${res.status}`);
    }
    return res;
  }

  async fetchTicket(id: string): Promise<Ticket> {
    const res = await this.request(
      `/rest/api/3/issue/${id}?fields=summary,description,comment,labels,status`,
    );
    const data = await res.json();
    return {
      externalId: data.key,
      identifier: data.key,
      title: data.fields.summary,
      description: this.extractText(data.fields.description),
      acceptanceCriteria: null,
      comments: (data.fields.comment?.comments ?? []).map(
        (c: {
          author: { displayName: string };
          body: unknown;
          created: string;
        }): TicketComment => ({
          author: c.author.displayName,
          body: typeof c.body === "string" ? c.body : this.extractText(c.body),
          createdAt: new Date(c.created),
        }),
      ),
      labels: data.fields.labels ?? [],
      trackerStatus: data.fields.status?.name ?? "",
    };
  }

  async moveTicket(id: string, column: string): Promise<void> {
    const res = await this.request(
      `/rest/api/3/issue/${id}/transitions`,
      { method: "GET" },
    );
    const data = await res.json();
    const transition = data.transitions.find(
      (t: { name: string }) =>
        t.name.toLowerCase() === column.toLowerCase(),
    );
    if (!transition) {
      throw new Error(`No transition found matching '${column}'`);
    }
    await this.request(`/rest/api/3/issue/${id}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
  }

  async postComment(id: string, comment: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${id}/comment`, {
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

  parseWebhook(req: unknown): NormalizedEvent | null {
    return parseJiraWebhook(req);
  }

  private extractText(adf: unknown): string {
    if (typeof adf === "string") return adf;
    if (!adf || typeof adf !== "object") return "";
    const node = adf as { content?: unknown[] };
    if (!node.content) return "";
    return node.content
      .map((child: unknown) => {
        const c = child as { text?: string; content?: unknown[] };
        if (c.text) return c.text;
        if (c.content) return this.extractText(child);
        return "";
      })
      .join("");
  }
}
