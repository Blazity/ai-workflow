import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
  type TicketAttachment,
  type TicketContent,
  type TicketComment,
} from "./types.js";

export interface JiraConfig {
  baseUrl: string;
  apiToken: string;
  projectKey: string;
  cloudId?: string;
}

const ATLASSIAN_API_ORIGIN = "https://api.atlassian.com";

export class JiraAdapter implements IssueTrackerAdapter {
  private tenantOrigin: string;
  private authHeader: string;
  private cloudIdPromise: Promise<string> | null;

  constructor(config: JiraConfig) {
    const trimmed = config.baseUrl.replace(/\/$/, "");
    this.tenantOrigin = new URL(trimmed).origin;
    this.authHeader = `Bearer ${config.apiToken}`;
    this.cloudIdPromise = config.cloudId
      ? Promise.resolve(config.cloudId)
      : null;
  }

  private getCloudId(): Promise<string> {
    if (this.cloudIdPromise) return this.cloudIdPromise;
    const pending = this.discoverCloudId();
    this.cloudIdPromise = pending.catch((err) => {
      this.cloudIdPromise = null;
      throw err;
    });
    return this.cloudIdPromise;
  }

  private async discoverCloudId(): Promise<string> {
    const url = `${this.tenantOrigin}/_edge/tenant_info`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Jira cloudId discovery failed: ${res.status} ${res.statusText} on ${url}`,
      );
    }
    const data = (await res.json()) as { cloudId?: unknown };
    if (typeof data?.cloudId !== "string" || data.cloudId === "") {
      throw new Error(
        `Jira cloudId discovery: missing cloudId in ${url} response`,
      );
    }
    return data.cloudId;
  }

  private async apiUrl(path: string): Promise<string> {
    const cloudId = await this.getCloudId();
    return `${ATLASSIAN_API_ORIGIN}/ex/jira/${cloudId}${path}`;
  }

  private async request(path: string, options?: RequestInit) {
    const url = await this.apiUrl(path);
    const res = await fetch(url, {
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

  async postComment(id: string, comment: string): Promise<string | null> {
    const data = await this.request(`/rest/api/3/issue/${id}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: toAdfParagraphs(comment),
        },
      }),
    });
    const commentId = typeof data?.id === "string" ? data.id : null;
    if (!commentId) return null;
    return `${this.tenantOrigin}/browse/${encodeURIComponent(id)}?focusedCommentId=${encodeURIComponent(commentId)}`;
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
    let currentUrl = await this.rewriteIfTenant(
      new URL(url, this.tenantOrigin).toString(),
    );

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
        await res.body?.cancel?.();
        currentUrl = await this.rewriteIfTenant(
          new URL(location, currentUrl).toString(),
        );
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

  private async rewriteIfTenant(url: string): Promise<string> {
    const parsed = new URL(url);
    if (parsed.origin !== this.tenantOrigin) return url;
    const cloudId = await this.getCloudId();
    return `${ATLASSIAN_API_ORIGIN}/ex/jira/${cloudId}${parsed.pathname}${parsed.search}`;
  }

  private buildAttachmentHeaders(url: string): HeadersInit | undefined {
    if (new URL(url).origin !== ATLASSIAN_API_ORIGIN) return undefined;
    return { Authorization: this.authHeader };
  }

  async searchTickets(jql: string): Promise<string[]> {
    const data = await this.request(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=50`,
    );
    return (data.issues ?? []).map((issue: any) => issue.key);
  }
}

function toAdfParagraphs(text: string) {
  const lines = text.split(/\r?\n/);
  const paragraphs = lines.map((line) => {
    if (line === "") return { type: "paragraph" };
    return {
      type: "paragraph",
      content: [{ type: "text", text: line }],
    };
  });
  return paragraphs.length > 0 ? paragraphs : [{ type: "paragraph" }];
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
