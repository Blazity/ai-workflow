import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type TicketAttachment,
  type TicketContent,
  type TicketComment,
} from "./types.js";

export interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

export class JiraAdapter implements IssueTrackerAdapter {
  private baseUrl: string;
  private jiraBaseOrigin: string;
  private authHeader: string;

  constructor(private config: JiraConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.jiraBaseOrigin = new URL(this.baseUrl).origin;
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
      if (res.status === 404) {
        throw new IssueTrackerNotFoundError("Jira resource", path);
      }
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
      `/rest/api/3/issue/${id}?fields=summary,description,comment,labels,status,project,attachment`,
    );
    return {
      id: data.id,
      identifier: data.key,
      projectKey: data.fields.project?.key ?? extractProjectKey(data.key),
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
      attachments: (data.fields.attachment ?? []).map((a: any): TicketAttachment => {
        const contentUrl =
          a.content == null ? undefined : String(a.content).trim();
        return {
          id: String(a.id),
          filename: a.filename ?? "",
          mimeType: a.mimeType ?? "application/octet-stream",
          size: sanitizeAttachmentSize(a.size),
          contentUrl: contentUrl || undefined,
        };
      }),
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
    const redirectStatuses = new Set([301, 302, 303, 307, 308]);
    const maxRedirects = 5;
    if (!url || url.trim() === "") {
      throw new Error("Jira attachment error: missing attachment content URL");
    }
    let currentUrl = new URL(url, this.baseUrl).toString();

    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const res = await fetch(currentUrl, {
        method: "GET",
        headers: this.buildAttachmentHeaders(currentUrl),
        redirect: "manual",
        signal,
      });

      if (redirectStatuses.has(res.status)) {
        const location = res.headers.get("location");
        if (!location) {
          await res.body?.cancel?.();
          throw new Error(
            `Jira attachment redirect (${res.status}) missing Location header for ${currentUrl}`,
          );
        }
        // Drain redirect response body to release the socket back to the pool.
        await res.body?.cancel?.();
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel?.();
        throw new Error(
          `Jira attachment error: status ${res.status} ${res.statusText} on ${currentUrl}`,
        );
      }
      return Buffer.from(await res.arrayBuffer());
    }

    throw new Error(
      `Jira attachment error: too many redirects while fetching ${url}`,
    );
  }

  private buildAttachmentHeaders(url: string): HeadersInit | undefined {
    if (new URL(url).origin !== this.jiraBaseOrigin) return undefined;
    return { Authorization: this.authHeader };
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

function extractProjectKey(identifier: string): string | undefined {
  if (!identifier) return undefined;
  const dash = identifier.indexOf("-");
  if (dash <= 0) return undefined;
  return identifier.slice(0, dash).toUpperCase();
}

function sanitizeAttachmentSize(size: unknown): number {
  const parsed = Number(size ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed <= 0) return 0;
  return Math.trunc(parsed);
}
