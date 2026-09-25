import {
  IssueTrackerNotFoundError,
  RELATED_TICKET_CHILD,
  RELATED_TICKET_PARENT,
  type IntegrationHttp,
  type IssueTrackerAdapter,
  type IssueTrackerMoveTarget,
  type IssueTrackerTransitionTarget,
  type RelatedTicket,
  type TicketAttachment,
  type TicketContent,
  type TicketComment,
  type TicketSummary,
} from "@integrations/sdk";
import { jqlFragmentProblem } from "./jql";

export interface JiraConfig {
  baseUrl: string;
  apiToken: string;
  projectKey: string;
  cloudId?: string;
  /**
   * How this adapter reaches Jira: always the context's `ctx.http.fetch`, and
   * required so that no request can take a path production never takes. It
   * gives each attempt its own deadline, retries reads, honours `Retry-After`,
   * joins a `signal` passed here to every attempt and to the waits between
   * them, and takes the connection's secrets out of any error it throws.
   * Errors this adapter builds from a response it received are its own.
   */
  fetch: IntegrationHttp["fetch"];
}

const ATLASSIAN_API_ORIGIN = "https://api.atlassian.com";

/**
 * A Jira issue key: the project key, a dash, the issue's number. Atlassian:
 * a project key "must be at least two characters long", must "start with an
 * uppercase letter" and may "contain only uppercase letters or numbers"
 * (Jira Cloud administration, "Edit a space's details").
 */
const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/**
 * An answer from Jira that was not a success, with the status on the error.
 * Whoever catches it reads what Jira said from `status` (the SDK's
 * `readProviderFailure` among them) rather than parsing the sentence.
 */
function answered(message: string, res: Response): Error {
  return Object.assign(new Error(message), { status: res.status });
}

type JiraTransition = {
  id: string;
  name?: string;
  to?: {
    id?: string;
    name?: string;
    statusCategory?: {
      key?: string;
    };
  };
};

const STATUS_DISCOVERY_TIMEOUT_MS = 5000;
const COMMENT_PAGE_SIZE = 100;
/** How many tickets one column read hands back. The poller dispatches from
 *  this page, so it is a page of work rather than a page of results. */
const DISCOVERY_PAGE_SIZE = 50;
/** How many comment pages one ticket read may cost. Twenty pages is two
 *  thousand comments, which no ticket a person answers a question on reaches;
 *  the bound is here so a provider that keeps reporting a larger total than it
 *  hands over cannot turn one read into an unbounded loop. Hitting it is not
 *  "that is all of them": the read says so, and every reader of the answer
 *  window treats a bounded read as ignorance rather than absence. */
const MAX_COMMENT_PAGES = 20;

/** One Jira comment as the rest of this codebase reads it. Shared by the
 *  embedded envelope on the issue and the paged comment endpoint, so a comment
 *  cannot arrive differently shaped depending on which read found it. */
function toTicketComment(c: any): TicketComment {
  return {
    author: c.author?.displayName ?? "unknown",
    accountId: c.author?.accountId,
    // Carried, not interpreted: Jira already says whether an author is a
    // person or an app on every comment, and dropping it here is what
    // left the readers above unable to tell them apart.
    accountType: c.author?.accountType,
    body: extractAdfText(c.body),
    createdAt: c.created,
  };
}

/** The earliest instant any of these comments was written at, or undefined when
 *  one of them carries a timestamp nobody can read: a boundary derived from a
 *  date we could not parse would claim coverage we cannot prove. */
function oldestCreatedAt(comments: TicketComment[]): string | undefined {
  let oldest: string | undefined;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const comment of comments) {
    const ms = Date.parse(comment.createdAt);
    if (!Number.isFinite(ms)) return undefined;
    if (ms < oldestMs) {
      oldestMs = ms;
      oldest = comment.createdAt;
    }
  }
  return oldest;
}

export class JiraAdapter implements IssueTrackerAdapter {
  private tenantOrigin: string;
  private authHeader: string;
  private cloudId: string | null;
  private selfAccountIdPromise: Promise<string> | null = null;
  private projectKey: string;
  private fetch: IntegrationHttp["fetch"];

  constructor(config: JiraConfig) {
    const trimmed = config.baseUrl.replace(/\/$/, "");
    this.tenantOrigin = new URL(trimmed).origin;
    this.authHeader = `Bearer ${config.apiToken}`;
    this.projectKey = config.projectKey;
    this.cloudId = config.cloudId ?? null;
    this.fetch = config.fetch;
  }

  /**
   * The issue's page on this site, which Jira Cloud serves at `/browse/<KEY>`
   * on the site's origin whatever path the Site URL was saved with. Null for a
   * subject key Jira never issued (a webhook delivery, a schedule occurrence,
   * a pull request with no ticket): there is no page for it, and a link would
   * be a 404.
   */
  ticketUrl(key: string): string | null {
    return ISSUE_KEY.test(key) ? this.issuePage(key) : null;
  }

  /** Where an issue Jira itself named lives: the one spelling of the link. */
  private issuePage(key: string, commentId?: string): string {
    const page = `${this.tenantOrigin}/browse/${encodeURIComponent(key)}`;
    return commentId ? `${page}?focusedCommentId=${encodeURIComponent(commentId)}` : page;
  }

  private async getCloudId(signal?: AbortSignal | null): Promise<string> {
    if (this.cloudId) return this.cloudId;
    const cloudId = await this.discoverCloudId(signal);
    this.cloudId = cloudId;
    return cloudId;
  }

  private async discoverCloudId(signal?: AbortSignal | null): Promise<string> {
    const url = `${this.tenantOrigin}/_edge/tenant_info`;
    const res = await this.fetch(url, { signal });
    if (!res.ok) {
      throw answered(`Jira cloudId discovery failed: ${res.status} ${res.statusText} on ${url}`, res);
    }
    const data = (await res.json()) as { cloudId?: unknown };
    if (typeof data?.cloudId !== "string" || data.cloudId === "") {
      throw new Error(
        `Jira cloudId discovery: missing cloudId in ${url} response`,
      );
    }
    return data.cloudId;
  }

  private async apiUrl(path: string, signal?: AbortSignal | null): Promise<string> {
    const cloudId = await this.getCloudId(signal);
    return `${ATLASSIAN_API_ORIGIN}/ex/jira/${cloudId}${path}`;
  }

  private async request(path: string, options?: RequestInit) {
    const url = await this.apiUrl(path, options?.signal);
    const res = await this.fetch(url, {
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
      throw answered(`Jira API error: ${res.status} ${res.statusText} on ${path}`, res);
    }
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  async fetchTicket(
    id: string,
    options?: { commentsSince?: string },
  ): Promise<TicketContent> {
    const data = await this.request(
      `/rest/api/3/issue/${id}?fields=summary,description,comment,labels,status,project,attachment,parent,subtasks,issuelinks`,
    );
    const { raw, complete, reachedLatest } = await this.readComments(
      id,
      data.fields.comment,
      options?.commentsSince,
    );
    const comments = raw.map(toTicketComment);
    // The oldest comment we can vouch for, and only when the read ran to the
    // end of the list: from that instant onwards, nothing is missing.
    const completeFrom = reachedLatest ? oldestCreatedAt(comments) : undefined;
    return {
      id: data.id,
      identifier: data.key,
      projectKey: data.fields.project?.key ?? extractProjectKey(data.key),
      title: data.fields.summary ?? "",
      description: extractAdfText(data.fields.description),
      acceptanceCriteria: extractAcceptanceCriteria(data.fields.description),
      comments,
      commentsComplete: complete,
      ...(completeFrom === undefined ? {} : { commentsCompleteFrom: completeFrom }),
      labels: data.fields.labels ?? [],
      trackerStatus: data.fields.status?.name ?? "",
      trackerStatusId:
        data.fields.status?.id == null ? undefined : String(data.fields.status.id),
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
      relatedTickets: relatedTicketsOf(data.fields),
    };
  }

  /**
   * The comments this read is allowed to claim, and what can be proven about
   * them.
   *
   * WITHOUT A WINDOW, and that is every ordinary ticket read, this is one
   * request and no more: the comments the issue response already carried. The
   * issue read embeds a PAGE of comments rather than the comments, so that page
   * is only the whole list when the provider's own count says so, and when it
   * does not the list travels as unproven rather than being chased. Chasing it
   * here would put up to `MAX_COMMENT_PAGES` extra calls behind every ticket
   * read in the deployment, on every poll tick, for a window almost none of
   * them wants. A provider rate limit reached that way takes down every run.
   *
   * WITH A WINDOW, which is the clarification path asking "hold every comment
   * written since this instant", the pages are read, and only as far back as
   * the window reaches. Jira returns comments oldest first, and the request
   * below says so explicitly rather than hoping: the walk starts at the newest
   * end (`total` minus one page) and steps BACKWARDS, because the window opens
   * at a question asked recently. It stops as soon as a page reaches back past
   * the instant asked about, so a ticket with thousands of comments normally
   * costs one extra request rather than twenty.
   *
   * `complete` is the fact that has to travel with the list. False means the
   * list may be missing comments, whether because the walk stopped once the
   * window was covered, because the bound was hit, or because the provider said
   * there were more and then handed over a page with room on it. It is never a
   * claim that a comment is absent.
   *
   * `reachedLatest` is the narrower fact, and the useful one: the read holds
   * the newest end of the list, so whatever is missing is OLDER than what came
   * back. That is what lets a reader decide a bounded read still holds every
   * comment written after some moment. It is false when the provider claimed
   * comments it then did not hand over, because that says nothing about which
   * end the missing ones are on.
   */
  private async readComments(
    id: string,
    envelope: any,
    since?: string,
  ): Promise<{ raw: any[]; complete: boolean; reachedLatest: boolean }> {
    const embedded: any[] = Array.isArray(envelope?.comments) ? envelope.comments : [];
    const total = Number(envelope?.total);
    const embeddedIsAll = Number.isFinite(total) && embedded.length >= total;
    // The common ticket: the issue read carried every comment it has, and said
    // so. No second request, and no doubt about the list.
    if (embeddedIsAll) return { raw: embedded, complete: true, reachedLatest: true };
    // No window asked for, so nothing is chased and nothing is claimed.
    if (since === undefined) return { raw: embedded, complete: false, reachedLatest: false };

    const sinceMs = Date.parse(since);
    // A window nobody can read is not a window. Falling back to the embedded
    // page keeps the request count where it was and leaves the claim unmade.
    if (!Number.isFinite(sinceMs)) {
      return { raw: embedded, complete: false, reachedLatest: false };
    }
    // Without a count there is no newest end to start from, so the walk runs
    // forward from the beginning and a short page is what proves the list
    // whole. That is the small ticket, which is the only kind a provider that
    // reports no total is likely to be handing over.
    let startAt = Number.isFinite(total) && total > COMMENT_PAGE_SIZE ? total - COMMENT_PAGE_SIZE : 0;
    const backwards = startAt > 0;
    const pages: any[][] = [];
    let complete = false;
    // Nothing is proven yet in either direction. The forward walk earns it by
    // reaching the end of the list; the backward walk by starting at it.
    let reachedLatest = false;
    for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
      const data = await this.request(
        `/rest/api/3/issue/${encodeURIComponent(id)}/comment?startAt=${startAt}&maxResults=${COMMENT_PAGE_SIZE}&orderBy=created`,
      );
      const batch = Array.isArray(data?.comments) ? data.comments : [];
      const reported = Number(data?.total);
      if (backwards) {
        pages.unshift(batch);
        if (page === 0) {
          // Did this page reach the end of the list? A ticket that grew between
          // the issue read and this one has its newest comments past where we
          // started, and nothing here says how many.
          reachedLatest = Number.isFinite(reported)
            ? startAt + batch.length >= reported
            : batch.length < COMMENT_PAGE_SIZE;
        }
        if (startAt === 0) {
          complete = true;
          break;
        }
        // Covered: this page reaches back past the instant asked about, so
        // every comment after it is already in hand.
        const oldest = oldestCreatedAt(batch.map(toTicketComment));
        if (oldest !== undefined && Date.parse(oldest) <= sinceMs) break;
        startAt = Math.max(0, startAt - COMMENT_PAGE_SIZE);
        continue;
      }
      pages.push(batch);
      startAt += batch.length;
      // A page with room to spare is the end of the list, which is how a count
      // nobody reported can still be proven whole. When there is a count, it
      // decides.
      const shortPage = batch.length < COMMENT_PAGE_SIZE;
      const moreToRead = Number.isFinite(reported) ? startAt < reported : !shortPage;
      if (!moreToRead) {
        complete = true;
        reachedLatest = true;
        break;
      }
      // It says there are more and hands over a page with room on it, so it has
      // contradicted itself: nothing here proves what is on the rest, or which
      // end of the list they are on.
      if (shortPage) break;
    }
    return { raw: pages.flat(), complete, reachedLatest };
  }

  async moveTicket(id: string, target: IssueTrackerMoveTarget): Promise<void> {
    const data = await this.request(`/rest/api/3/issue/${id}/transitions`);
    const transitions = data.transitions as JiraTransition[];
    const transitionTarget = normalizeTransitionTarget(target);
    const transition = findTransition(transitions, transitionTarget);
    if (!transition) {
      const targetDescription = transitionTarget.transitionId
        ? `${transitionTarget.name} (${transitionTarget.transitionId})`
        : transitionTarget.name;
      throw new Error(
        `No transition to "${targetDescription}" found for issue ${id}. Available: ${transitions.map((t) => `${t.name} (${t.id})`).join(", ")}`,
      );
    }
    await this.request(`/rest/api/3/issue/${id}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
  }

  async resolveMoveTargetStatus(
    id: string,
    target: IssueTrackerMoveTarget,
  ): Promise<{ id: string; name: string } | null> {
    const data = await this.request(`/rest/api/3/issue/${id}/transitions`);
    const transitions = (data?.transitions ?? []) as JiraTransition[];
    const transition = findTransition(transitions, normalizeTransitionTarget(target));
    const statusId = transition?.to?.id == null ? "" : String(transition.to.id).trim();
    const statusName =
      typeof transition?.to?.name === "string" ? transition.to.name.trim() : "";
    if (!statusId || !statusName) return null;
    return { id: statusId, name: statusName };
  }

  async listStatuses(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
    const groups = await this.request(
      `/rest/api/3/project/${encodeURIComponent(this.projectKey)}/statuses`,
      { signal: signal ?? AbortSignal.timeout(STATUS_DISCOVERY_TIMEOUT_MS) },
    );
    const seen = new Set<string>();
    const statuses: Array<{ id: string; name: string }> = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const status of Array.isArray(group?.statuses) ? group.statuses : []) {
        const id = status?.id == null ? "" : String(status.id).trim();
        const name = typeof status?.name === "string" ? status.name.trim() : "";
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);
        statuses.push({ id, name });
      }
    }
    return statuses;
  }

  async postComment(
    id: string,
    comment: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | null> {
    const data = await this.request(`/rest/api/3/issue/${id}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: toAdfParagraphs(comment),
        },
      }),
      signal: options?.signal,
    });
    const commentId = typeof data?.id === "string" ? data.id : null;
    if (!commentId) return null;
    return this.issuePage(id, commentId);
  }

  async findCommentByMarker(id: string, marker: string): Promise<string | null> {
    let startAt = 0;
    while (true) {
      const data = await this.request(
        `/rest/api/3/issue/${encodeURIComponent(id)}/comment?startAt=${startAt}&maxResults=${COMMENT_PAGE_SIZE}`,
      );
      const comments = Array.isArray(data?.comments) ? data.comments : [];
      for (const comment of comments) {
        const body = extractAdfText(comment?.body);
        const hasMarker = body
          .split(/\r?\n/u)
          .some((line) => line.trim() === marker);
        if (!hasMarker) continue;
        const commentId = comment?.id == null ? "" : String(comment.id);
        return this.issuePage(id, commentId || undefined);
      }

      const total = Number(data?.total);
      if (comments.length === 0 || !Number.isFinite(total) || startAt + comments.length >= total) {
        return null;
      }
      startAt += comments.length;
    }
  }

  async createTicket(input: {
    summary: string;
    description?: string;
    issueType?: string;
    labels?: string[];
  }): Promise<{ identifier: string; url: string | null }> {
    const data = await this.request(`/rest/api/3/issue`, {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: this.projectKey },
          // "Task" is Jira's default issue type in every project template that has one;
          // a project without it answers with a field error naming what it does have.
          issuetype: { name: input.issueType ?? "Task" },
          summary: input.summary,
          ...(input.description
            ? {
                description: {
                  type: "doc",
                  version: 1,
                  content: toAdfParagraphs(input.description),
                },
              }
            : {}),
          ...(input.labels?.length ? { labels: input.labels } : {}),
        },
      }),
    });
    const key = typeof data?.key === "string" ? data.key.trim() : "";
    if (!key) {
      // The ticket may well exist; what is missing is its key, so a caller must not
      // read this as "nothing was created".
      throw new Error("Jira create issue: response carried no issue key");
    }
    return {
      identifier: key,
      url: this.issuePage(key),
    };
  }

  async downloadAttachment(
    url: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<Buffer> {
    // The operator's per-attachment setting is the deadline for the whole
    // download, every redirect included, so it is a signal. It is also each
    // request's own timeout: the SDK's default of 30 s would otherwise cut a
    // download an operator allowed longer for, and retry it from the start.
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
      const res = await this.fetch(currentUrl, {
        method: "GET",
        headers: this.buildAttachmentHeaders(currentUrl),
        redirect: "manual",
        signal,
        timeoutMs,
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
        throw answered(
          `Jira attachment error: status ${res.status} ${res.statusText} on ${currentUrl}`,
          res,
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

  /**
   * System webhooks registered in Jira (Settings → System → Webhooks). Returns
   * null when the token is not allowed to list them, so callers can fall back
   * to delivery evidence instead of reporting a false failure.
   */
  async listWebhookRegistrations(
    signal?: AbortSignal | null,
  ): Promise<Array<{ url: string; enabled: boolean; events: string[] }> | null> {
    const path = "/rest/webhooks/1.0/webhook";
    const url = await this.apiUrl(path, signal);
    const res = await this.fetch(url, {
      headers: { Authorization: this.authHeader },
      signal: signal ?? undefined,
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return null;
    if (!res.ok) {
      throw answered(`Jira API error: ${res.status} ${res.statusText} on ${path}`, res);
    }
    const body = (await res.json().catch(() => null)) as Array<{
      url?: unknown;
      enabled?: unknown;
      events?: unknown;
    }> | null;
    if (!Array.isArray(body)) return [];
    return body.map((entry) => ({
      url: typeof entry.url === "string" ? entry.url : "",
      enabled: entry.enabled === true,
      events: Array.isArray(entry.events)
        ? entry.events.filter((event): event is string => typeof event === "string")
        : [],
    }));
  }

  /**
   * The keys of every ticket in one status of the configured project, oldest
   * first.
   *
   * The ORDER BY is not decoration. The page is capped and unpaginated, so
   * without a stable order a still queued ticket rotates out of one poll's
   * page and back into the next, and the at-capacity bookkeeping deletes and
   * re-inserts its row: a second "waiting for capacity" comment on the same
   * ticket. That sentence used to live in the poller, beside the JQL it built;
   * the query moved here and the reason moved with it.
   */
  async ticketsInStatus(
    status: string,
    options?: { limit?: number },
  ): Promise<string[]> {
    const jql = `project = "${jqlLiteral(this.projectKey)}" AND status = "${jqlLiteral(status)}" ORDER BY created ASC`;
    const data = await this.request(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=${options?.limit ?? DISCOVERY_PAGE_SIZE}`,
    );
    return (data.issues ?? []).map((issue: any) => issue.key);
  }

  /** The keys of every ticket in the configured project carrying one label. */
  async ticketsWithLabel(label: string): Promise<string[]> {
    const jql = `project = "${jqlLiteral(this.projectKey)}" AND labels = "${jqlLiteral(label)}"`;
    const data = await this.request(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=${DISCOVERY_PAGE_SIZE}`,
    );
    return (data.issues ?? []).map((issue: any) => issue.key);
  }

  /**
   * Tickets worth reading about a subject.
   *
   * The configured project is ANDed in FIRST and unconditionally, so no
   * combination of keywords or authored query can reach a project this
   * connection was not configured for: an authored query narrows inside the
   * project and cannot widen past it. One naming another project yields
   * nothing rather than that project's tickets.
   *
   * `providerQuery` is a JQL fragment a workflow author typed. It is used only
   * when it stays inside the parentheses it is wrapped in (`jqlFragmentProblem`
   * finds nothing wrong with it), which is what makes the promise above hold
   * for text nobody here wrote.
   */
  async findTickets(input: {
    keywords: readonly string[];
    limit: number;
    providerQuery?: string;
  }): Promise<TicketSummary[]> {
    const clauses = [`project = "${jqlLiteral(this.projectKey)}"`];
    const authored = input.providerQuery?.trim() ?? "";
    if (authored !== "" && jqlFragmentProblem(authored) === null) clauses.push(authored);
    const keywordClause = input.keywords
      .map(jqlLiteral)
      .filter((keyword) => keyword !== "")
      .map((keyword) => `text ~ "${keyword}"`)
      .join(" OR ");
    if (keywordClause !== "") clauses.push(keywordClause);
    const jql = clauses.map((clause) => `(${clause})`).join(" AND ");
    const data = await this.request(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key,summary,status,description,reporter,project,updated&maxResults=${input.limit}`,
      { signal: AbortSignal.timeout(STATUS_DISCOVERY_TIMEOUT_MS) },
    );
    return (data.issues ?? []).map((issue: any): TicketSummary => {
      const fields = issue.fields ?? {};
      return {
        key: issue.key,
        summary: fields.summary ?? "",
        status: fields.status?.name ?? "",
        url: this.issuePage(issue.key),
        // Truncated here rather than by the caller: a search over a whole
        // project must not pull entire ticket bodies across the wire only for
        // them to be cut down afterwards.
        excerpt: truncateExcerpt(extractAdfText(fields.description)),
        reporter: fields.reporter?.displayName ?? "",
        project: fields.project?.key ?? "",
        updatedAt: typeof fields.updated === "string" ? fields.updated : "",
      };
    });
  }

  async updateLabels(
    id: string,
    changes: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    const ops = [
      ...(changes.add ?? []).map((label) => ({ add: label })),
      ...(changes.remove ?? []).map((label) => ({ remove: label })),
    ];
    if (ops.length === 0) return;
    await this.request(`/rest/api/3/issue/${id}`, {
      method: "PUT",
      body: JSON.stringify({ update: { labels: ops } }),
    });
  }

  async getCurrentUserAccountId(signal?: AbortSignal): Promise<string> {
    if (!this.selfAccountIdPromise) {
      this.selfAccountIdPromise = this.request(`/rest/api/3/myself`, { signal })
        .then((data: any) => {
          const accountId = data?.accountId;
          if (typeof accountId !== "string" || accountId === "") {
            throw new Error("Jira /myself: missing accountId");
          }
          return accountId;
        })
        .catch((err) => {
          this.selfAccountIdPromise = null;
          throw err;
        });
    }
    return this.selfAccountIdPromise;
  }
}

function normalizeTransitionTarget(
  target: IssueTrackerMoveTarget,
): IssueTrackerTransitionTarget {
  return typeof target === "string" ? { name: target } : target;
}

function findTransition(
  transitions: JiraTransition[],
  target: IssueTrackerTransitionTarget,
) {
  if (target.transitionId) {
    return transitions.find(
      (transition) => String(transition.id) === target.transitionId,
    );
  }

  if (target.statusId) {
    const statusTransition = transitions.find(
      (transition) => String(transition.to?.id ?? "") === target.statusId,
    );
    if (statusTransition) return statusTransition;
  }

  // A configured target may name the transition action ("Mark as done") or the
  // status it lands on ("已完成"); Jira localizes statuses but not transitions,
  // so the two can read completely differently, and `listStatuses` (what
  // callers are told is available) only ever knows status names. Accepting
  // either keeps a caller who quotes the status name from the error message
  // working, not just one who happens to know the transition's own label.
  const normalizedColumn = target.name.toLowerCase();
  const byTransitionName = transitions.find(
    (transition) => transition.name?.toLowerCase() === normalizedColumn,
  );
  if (byTransitionName) return byTransitionName;
  return transitions.find(
    (transition) => transition.to?.name?.toLowerCase() === normalizedColumn,
  );
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

/**
 * Jira's rich text as plain text.
 *
 * A BLOCKQUOTE KEEPS ITS MARKER, and it is the one node type this function
 * marks at all. Everything downstream that reads a person's words has to tell
 * what they wrote from what they quoted: the repository answer reader drops
 * quoted lines before it decides whether a reply says no
 * (`withoutQuotedText` in `engine/work-scope/answer.ts`), because every
 * sentence this system posts about a repository it left out is built around the
 * word "not". Flattened without the marker, a person clicking Jira's quote
 * button and typing "yes, add it" underneath handed us our own refusal as if it
 * were theirs, and the answer that could not be plainer was the one that never
 * worked. "> " is the marker every other channel writes, so one reader knows
 * them all.
 */
function extractAdfText(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.text) return adf.text;
  if (adf.content) {
    const text = adf.content.map(extractAdfText).join("\n");
    if (adf.type !== "blockquote") return text;
    return text
      .split("\n")
      .map((line: string) => `> ${line}`)
      .join("\n");
  }
  return "";
}

/** Bound for a search hit's snippet. A retrieval hit exists to be judged for
 *  relevance, so the opening of the description is enough; whoever wants the
 *  whole ticket opens the link. */
const MAX_EXCERPT_CHARS = 500;

function truncateExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_EXCERPT_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_EXCERPT_CHARS)}…`;
}

/**
 * Where the acceptance criteria start: the label people write in front of
 * them. "Acceptance criteria" anywhere, as before, because "these are the
 * acceptance criteria:" introduces them mid-sentence. The short forms
 * ("Acceptance", "AC") only as a label, at the start of a line and followed by
 * a colon or by nothing, because both are ordinary words elsewhere
 * ("Acceptance tests live in ...", "ACME:", "Voltage AC: 230V"). Markdown a
 * person put around a label (a heading, a bullet, bold) is part of the label.
 */
const ACCEPTANCE_LABEL =
  /acceptance criteria[*_]*:?[*_]*|^[ \t>#*_-]*(?:acceptance|ac)[*_]*(?:[ \t]*:[*_]*|[ \t]*$)/im;

/** The criteria are what follows the label and any blank lines after it, up
 *  to the next blank line or markdown heading, or to the end of the
 *  description. A heading right after the label is the next section, so the
 *  label had nothing under it. */
function extractAcceptanceCriteria(description: any): string {
  const text = extractAdfText(description);
  const label = ACCEPTANCE_LABEL.exec(text);
  if (!label) return "";
  const rest = text.slice(label.index + label[0].length).replace(/^\s+/, "");
  if (/^#+\s/.test(rest)) return "";
  const match = rest.match(/^([\s\S]*?)(?:\n\n|\n#|$)/);
  return match?.[1]?.trim() ?? "";
}

/**
 * The tickets one issue read names, in the order the port promises: the
 * parent, then the subtasks as the team ranked them, then every link as Jira
 * listed it. An entry without a key is skipped, because a line naming a ticket
 * nobody can find is worse than no line.
 *
 * A link is one row seen from both ends, and Jira says which end this ticket
 * is by which side it fills in: the other issue under `outwardIssue` makes
 * this ticket the subject of the outward phrase ("this blocks that"), under
 * `inwardIssue` of the inward one ("this is blocked by that"). That is the
 * phrase Jira itself prints beside the link on this ticket's page.
 */
function relatedTicketsOf(fields: any): RelatedTicket[] {
  const related: RelatedTicket[] = [];
  const add = (issue: any, relation: unknown) => {
    const key = issue?.key;
    if (typeof key !== "string" || key === "") return;
    related.push({
      key,
      title: typeof issue.fields?.summary === "string" ? issue.fields.summary : "",
      status: typeof issue.fields?.status?.name === "string" ? issue.fields.status.name : "",
      relation: typeof relation === "string" ? relation : "",
    });
  };
  if (fields?.parent) add(fields.parent, RELATED_TICKET_PARENT);
  for (const subtask of Array.isArray(fields?.subtasks) ? fields.subtasks : []) {
    add(subtask, RELATED_TICKET_CHILD);
  }
  for (const link of Array.isArray(fields?.issuelinks) ? fields.issuelinks : []) {
    if (link?.outwardIssue) add(link.outwardIssue, link.type?.outward ?? link.type?.name);
    else if (link?.inwardIssue) add(link.inwardIssue, link.type?.inward ?? link.type?.name);
  }
  return related;
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

/** A value safe to sit inside a double-quoted JQL literal. Quotes and
 *  backslashes become spaces rather than being escaped: every caller here
 *  passes a project key, a status name or a search word, none of which mean
 *  anything with a quote in them, and a rule that cannot be got wrong beats an
 *  escape that can. */
function jqlLiteral(value: string): string {
  return value.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}
