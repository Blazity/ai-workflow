import type { IssueTrackerAdapter, TicketContent, TicketComment, TicketAttachment } from "./types.js";

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

export class JiraAdapter implements IssueTrackerAdapter {
  private baseUrl: string;
  private authHeader: string;

  constructor(private config: JiraConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.authHeader =
      "Basic " +
      Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  }

  private async request(path: string, options?: RequestInit) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`Jira API error: ${res.status} ${res.statusText} on ${path}`);
    }
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  async fetchTicket(id: string): Promise<TicketContent> {
    const data = await this.request(
      `/rest/api/3/issue/${id}?fields=summary,description,comment,labels,status,attachment`,
    );
    return {
      id: data.id,
      identifier: data.key,
      title: data.fields.summary ?? "",
      description: extractAdfText(data.fields.description),
      acceptanceCriteria: extractAcceptanceCriteria(data.fields.description),
      comments: (data.fields.comment?.comments ?? []).map(
        (c: any): TicketComment => ({
          author: c.author?.displayName ?? "unknown",
          body: extractAdfText(c.body),
          createdAt: c.created,
        }),
      ),
      labels: data.fields.labels ?? [],
      trackerStatus: data.fields.status?.name ?? "",
      attachments: (data.fields.attachment ?? []).map(
        (a: any): TicketAttachment => ({
          id: String(a.id),
          filename: a.filename ?? "",
          mimeType: a.mimeType ?? "application/octet-stream",
          size: Number(a.size ?? 0),
          contentUrl: a.content ?? "",
        }),
      ),
    };
  }

  async moveTicket(id: string, column: string): Promise<void> {
    const data = await this.request(`/rest/api/3/issue/${id}/transitions`);
    const transition = data.transitions.find(
      (t: any) => t.name.toLowerCase() === column.toLowerCase(),
    );
    if (!transition) {
      throw new Error(
        `No transition to "${column}" found for issue ${id}. Available: ${data.transitions.map((t: any) => t.name).join(", ")}`,
      );
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

  async downloadAttachment(
    url: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<Buffer> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const signal = AbortSignal.timeout(timeoutMs);

    // First request: authenticated, manual redirect handling.
    const first = await fetch(url, {
      method: "GET",
      headers: { Authorization: this.authHeader },
      redirect: "manual",
      signal,
    });

    if (first.status === 302 || first.status === 301) {
      const location = first.headers.get("location");
      if (!location) {
        throw new Error(
          `Jira attachment redirect (${first.status}) missing Location header for ${url}`,
        );
      }
      // Drain first response body to release the socket back to the pool.
      await first.body?.cancel?.();
      // Re-fetch the signed CDN URL WITHOUT Authorization (its signature IS the auth).
      // Use redirect: "follow" here since the auth header is already stripped — further
      // CDN-internal redirects (e.g. S3 region redirects) are safe and common.
      const second = await fetch(location, {
        method: "GET",
        redirect: "follow",
        signal,
      });
      if (!second.ok) {
        throw new Error(
          `Jira attachment CDN error: ${second.status} ${second.statusText} on ${location}`,
        );
      }
      return Buffer.from(await second.arrayBuffer());
    }

    if (!first.ok) {
      throw new Error(
        `Jira attachment error: ${first.status} ${first.statusText} on ${url}`,
      );
    }
    return Buffer.from(await first.arrayBuffer());
  }

  async searchTickets(jql: string): Promise<string[]> {
    const data = await this.request(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=50`,
    );
    return (data.issues ?? []).map((issue: any) => issue.key);
  }
}

function extractAdfText(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.text) return adf.text;
  if (adf.content) {
    return adf.content.map(extractAdfText).join("\n");
  }
  return "";
}

function extractAcceptanceCriteria(description: any): string {
  const text = extractAdfText(description);
  const match = text.match(/acceptance criteria[:\s]*([\s\S]*?)(?:\n\n|\n#|$)/i);
  return match?.[1]?.trim() ?? "";
}
