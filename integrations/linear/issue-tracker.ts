import {
  IssueTrackerInputRejectedError,
  IssueTrackerNotFoundError,
  RELATED_TICKET_CHILD,
  RELATED_TICKET_PARENT,
  type IntegrationHttp,
  type IssueTrackerAdapter,
  type IssueTrackerMoveTarget,
  type RelatedTicket,
  type TicketComment,
  type TicketContent,
  type TicketSummary,
} from "@integrations/sdk";

export interface LinearConfig {
  apiToken: string;
  projectKey: string;
  fetch: IntegrationHttp["fetch"];
  orgUrlKey?: string;
  teamId?: string;
}

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const MAX_COMMENT_PAGES = 20;

const ACCEPTANCE_LABEL =
  /acceptance criteria[*_]*:?[*_]*|^[ \t>#*_-]*(?:acceptance|ac)[*_]*(?:[ \t]*:[*_]*|[ \t]*$)/im;

/**
 * Extracts acceptance criteria section from ticket description.
 */
export function extractAcceptanceCriteria(description: string): string {
  const text = typeof description === "string" ? description : "";
  const label = ACCEPTANCE_LABEL.exec(text);
  if (!label) return "";
  const rest = text.slice(label.index + label[0].length).replace(/^\s+/, "");
  if (/^#+\s/.test(rest)) return "";
  const match = rest.match(/^([\s\S]*?)(?:\n\n|\n#|$)/);
  return match?.[1]?.trim() ?? "";
}

/**
 * Collapses whitespace and truncates text to max length with ellipsis.
 */
export function truncateExcerpt(text: string, max = 500): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 3).trimEnd()}...`;
}

/**
 * Returns the oldest ISO timestamp among a list of ticket comments.
 */
function oldestCreatedAt(comments: readonly TicketComment[]): string | undefined {
  if (comments.length === 0) return undefined;
  let oldest = comments[0];
  let minTime = Date.parse(oldest.createdAt);
  for (let i = 1; i < comments.length; i++) {
    const t = Date.parse(comments[i].createdAt);
    if (!Number.isNaN(t) && (Number.isNaN(minTime) || t < minTime)) {
      minTime = t;
      oldest = comments[i];
    }
  }
  return oldest.createdAt;
}

/**
 * Returns the oldest ISO timestamp among comment GraphQL nodes.
 */
function oldestNodeCreatedAt(nodes: ReadonlyArray<{ createdAt?: string }>): string | undefined {
  if (nodes.length === 0) return undefined;
  let oldestTime = NaN;
  let oldestStr: string | undefined;
  for (const node of nodes) {
    if (!node.createdAt) continue;
    const t = Date.parse(node.createdAt);
    if (!Number.isNaN(t) && (Number.isNaN(oldestTime) || t < oldestTime)) {
      oldestTime = t;
      oldestStr = node.createdAt;
    }
  }
  return oldestStr;
}

/**
 * Implements IssueTrackerAdapter for Linear using its GraphQL API.
 */
export class LinearAdapter implements IssueTrackerAdapter {
  private readonly apiToken: string;
  public readonly projectKey: string;
  private readonly fetch: IntegrationHttp["fetch"];
  private orgUrlKey: string | null;
  private teamId: string | null;
  private selfAccountIdPromise: Promise<string> | null = null;

  /**
   * Initializes a new Linear adapter with the given credentials and HTTP client.
   */
  constructor(config: LinearConfig) {
    this.apiToken = config.apiToken.trim();
    this.projectKey = config.projectKey.trim();
    this.fetch = config.fetch;
    this.orgUrlKey = config.orgUrlKey ?? null;
    this.teamId = config.teamId ?? null;
  }

  /**
   * Executes a GraphQL query or mutation against Linear's endpoint with error classification.
   */
  private async graphql<T = any>(
    query: string,
    variables?: Record<string, unknown>,
    options?: { signal?: AbortSignal; isMutation?: boolean; readsFieldErrors?: boolean },
  ): Promise<T> {
    const authHeader = this.apiToken.startsWith("Bearer ") ? this.apiToken : this.apiToken;
    const fetchInit: Record<string, unknown> = {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: options?.signal,
    };
    if (!options?.isMutation) {
      fetchInit.retries = 2;
    }

    const res = await this.fetch(LINEAR_GRAPHQL_ENDPOINT, fetchInit as RequestInit);
    if (res.status === 404) {
      throw new IssueTrackerNotFoundError("Linear resource", "graphql");
    }

    const body = (await res.json().catch(() => null)) as {
      data?: T;
      errors?: Array<{ message?: string; extensions?: { code?: string; type?: string } }>;
    } | null;

    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const err = body.errors[0];
      const message = String(err?.message ?? "Linear GraphQL error");
      const code = String(err?.extensions?.code ?? err?.extensions?.type ?? "");

      if (code === "AUTHENTICATION_ERROR" || code === "UNAUTHENTICATED" || /authentication|not authenticated|invalid token/i.test(message)) {
        throw Object.assign(new Error(message), { status: 401 });
      }
      if (code === "FORBIDDEN" || /forbidden|unauthorized/i.test(message)) {
        throw Object.assign(new Error(message), { status: 403 });
      }
      if (code === "RATELIMITED" || code === "RATE_LIMITED" || /rate limit/i.test(message)) {
        throw Object.assign(new Error(message), { status: 429 });
      }
      if (/entity not found|not found/i.test(message)) {
        throw new IssueTrackerNotFoundError("Linear resource", message);
      }
      if (
        options?.readsFieldErrors &&
        (code === "BAD_USER_INPUT" || code === "GRAPHQL_VALIDATION_FAILED" || code === "USER_ERROR")
      ) {
        throw new IssueTrackerInputRejectedError(message, { issueTypeRejected: false });
      }
      throw Object.assign(new Error(message), { status: res.ok ? 500 : res.status });
    }

    if (!res.ok) {
      if (res.status === 400 && options?.readsFieldErrors) {
        throw new IssueTrackerInputRejectedError("Linear refused the request.", { issueTypeRejected: false });
      }
      throw Object.assign(new Error(`Linear API error: ${res.status} ${res.statusText}`), { status: res.status });
    }

    if (body === null) {
      throw Object.assign(new Error("Linear returned an unreadable response."), { status: 502 });
    }

    return body.data as T;
  }

  /**
   * Generates the web URL for an issue key.
   */
  ticketUrl(key: string): string | null {
    if (!ISSUE_KEY.test(key)) return null;
    if (this.orgUrlKey) {
      return `https://linear.app/${encodeURIComponent(this.orgUrlKey)}/issue/${encodeURIComponent(key)}`;
    }
    return `https://linear.app/issue/${encodeURIComponent(key)}`;
  }

  /**
   * Returns the viewer account ID, caching the promise.
   */
  async getCurrentUserAccountId(signal?: AbortSignal): Promise<string> {
    if (this.selfAccountIdPromise) return this.selfAccountIdPromise;

    const promise = (async () => {
      const data = await this.graphql<{ viewer?: { id: string } }>(
        `query Viewer { viewer { id name } }`,
        undefined,
        { signal },
      );
      if (!data?.viewer?.id) {
        throw new Error("Linear did not return a viewer id.");
      }
      return data.viewer.id;
    })();

    this.selfAccountIdPromise = promise;
    try {
      return await promise;
    } catch (error) {
      this.selfAccountIdPromise = null;
      throw error;
    }
  }

  /**
   * Resolves and caches the Linear team ID for the configured team key.
   */
  private async ensureTeamId(signal?: AbortSignal): Promise<string> {
    if (this.teamId) return this.teamId;
    const query = `
      query TeamId($teamKey: String!) {
        teams(filter: { key: { eq: $teamKey } }) {
          nodes {
            id
            key
          }
        }
      }
    `;
    const data = await this.graphql<{ teams?: { nodes?: Array<{ id: string; key: string }> } }>(
      query,
      { teamKey: this.projectKey },
      { signal },
    );
    const node = data?.teams?.nodes?.find(
      (t) => t.key.toUpperCase() === this.projectKey.toUpperCase(),
    );
    if (!node?.id) {
      throw new Error(`Linear team with key "${this.projectKey}" was not found.`);
    }
    this.teamId = node.id;
    return node.id;
  }

  /**
   * Lists workflow states for the team, ordered by position.
   */
  async listStatuses(signal?: AbortSignal): Promise<Array<{ id: string; name: string }>> {
    const query = `
      query TeamStates($teamKey: String!) {
        teams(filter: { key: { eq: $teamKey } }) {
          nodes {
            id
            key
            states {
              nodes {
                id
                name
                type
                position
              }
            }
          }
        }
      }
    `;
    const data = await this.graphql<{
      teams?: {
        nodes?: Array<{
          id: string;
          key: string;
          states?: { nodes?: Array<{ id: string; name: string; position?: number }> };
        }>;
      };
    }>(query, { teamKey: this.projectKey }, { signal });

    const team = data?.teams?.nodes?.find(
      (t) => t.key.toUpperCase() === this.projectKey.toUpperCase(),
    );
    if (!team) return [];
    if (team.id) {
      this.teamId = team.id;
    }

    const stateNodes = team.states?.nodes ?? [];
    const sorted = [...stateNodes].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const seen = new Set<string>();
    const result: Array<{ id: string; name: string }> = [];

    for (const state of sorted) {
      if (!seen.has(state.id)) {
        seen.add(state.id);
        result.push({ id: state.id, name: state.name });
      }
    }

    return result;
  }

  /**
   * Matches a transition target to an existing workflow state.
   */
  async resolveMoveTargetStatus(
    _id: string,
    target: IssueTrackerMoveTarget,
  ): Promise<{ id: string; name: string } | null> {
    const normalized = typeof target === "string" ? { name: target } : target;
    const statuses = await this.listStatuses();

    if (normalized.transitionId) {
      const match = statuses.find((s) => s.id === normalized.transitionId);
      if (match) return match;
    }
    if (normalized.statusId) {
      const match = statuses.find((s) => s.id === normalized.statusId);
      if (match) return match;
    }
    if (normalized.name) {
      const targetName = normalized.name.trim().toLowerCase();
      const match = statuses.find((s) => s.name.trim().toLowerCase() === targetName);
      if (match) return match;
    }

    return null;
  }

  /**
   * Moves an issue to a target workflow state.
   */
  async moveTicket(id: string, target: IssueTrackerMoveTarget): Promise<void> {
    const matched = await this.resolveMoveTargetStatus(id, target);
    if (!matched) {
      const statuses = await this.listStatuses();
      const targetDescription = typeof target === "string" ? target : target.name || target.statusId || target.transitionId || "";
      throw new Error(
        `No workflow state matching "${targetDescription}" found for issue ${id}. Available: ${statuses
          .map((s) => `${s.name} (${s.id})`)
          .join(", ")}`,
      );
    }

    const mutation = `
      mutation MoveIssue($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
          issue {
            id
            state {
              id
              name
            }
          }
        }
      }
    `;
    await this.graphql(mutation, { id, stateId: matched.id }, { isMutation: true });
  }

  /**
   * Fetches full ticket details including comments and relations.
   */
  async fetchTicket(id: string, options?: { commentsSince?: string }): Promise<TicketContent> {
    const query = `
      query IssueByIdentifier($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          url
          state { id name }
          team { id key }
          labels { nodes { id name } }
          comments(first: 100, orderBy: createdAt) {
            nodes {
              id
              body
              url
              createdAt
              user { id name }
              botActor { id name }
            }
            pageInfo { hasNextPage endCursor }
          }
          attachments { nodes { id title url } }
          parent { identifier title state { name } }
          children { nodes { identifier title state { name } } }
          relations {
            nodes {
              type
              relatedIssue { identifier title state { name } }
            }
          }
          inverseRelations {
            nodes {
              type
              issue { identifier title state { name } }
            }
          }
        }
      }
    `;

    const data = await this.graphql<{ issue?: any }>(query, { id });
    const issue = data?.issue;
    if (!issue) {
      throw new IssueTrackerNotFoundError("Linear issue", id);
    }

    if (typeof issue.url === "string") {
      const match = issue.url.match(/^https:\/\/linear\.app\/([^/]+)\/issue\//);
      if (match?.[1]) {
        this.orgUrlKey = match[1];
      }
    }

    const projectKey = issue.team?.key ?? issue.identifier.split("-")[0] ?? this.projectKey;
    const title = issue.title ?? "";
    const description = issue.description ?? "";
    const acceptanceCriteria = extractAcceptanceCriteria(description);

    const initialNodes = issue.comments?.nodes ?? [];
    let pageInfo = issue.comments?.pageInfo ?? { hasNextPage: false, endCursor: null };
    const allCommentNodes = [...initialNodes];
    let covered = false;

    if (options?.commentsSince) {
      const sinceMs = Date.parse(options.commentsSince);
      if (!Number.isNaN(sinceMs)) {
        const oldestInitial = oldestNodeCreatedAt(initialNodes);
        if (oldestInitial !== undefined && Date.parse(oldestInitial) <= sinceMs) {
          covered = true;
        } else if (pageInfo.hasNextPage) {
          let pagesCount = 1;
          while (pageInfo.hasNextPage && pagesCount < MAX_COMMENT_PAGES) {
            const nextPageQuery = `
              query IssueCommentsPaged($id: String!, $cursor: String!) {
                issue(id: $id) {
                  comments(first: 100, after: $cursor, orderBy: createdAt) {
                    nodes {
                      id
                      body
                      url
                      createdAt
                      user { id name }
                      botActor { id name }
                    }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }
            `;
            const nextPageData = await this.graphql<{ issue?: { comments?: { nodes?: any[]; pageInfo?: any } } }>(
              nextPageQuery,
              { id, cursor: pageInfo.endCursor },
            );
            const nextComments = nextPageData?.issue?.comments;
            const nextNodes = nextComments?.nodes ?? [];
            allCommentNodes.push(...nextNodes);
            pageInfo = nextComments?.pageInfo ?? { hasNextPage: false, endCursor: null };
            pagesCount++;

            const oldestLoaded = oldestNodeCreatedAt(allCommentNodes);
            if (oldestLoaded !== undefined && Date.parse(oldestLoaded) <= sinceMs) {
              covered = true;
              break;
            }
          }
        }
      }
    }

    const comments: TicketComment[] = allCommentNodes.map((node: any) => ({
      author: node.user?.name ?? node.botActor?.name ?? "unknown",
      accountId: node.user?.id ?? node.botActor?.id,
      accountType: node.botActor ? "bot" : undefined,
      body: node.body ?? "",
      createdAt: node.createdAt,
    }));

    comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    let commentsComplete: boolean;
    let commentsCompleteFrom: string | undefined;

    if (!pageInfo.hasNextPage) {
      commentsComplete = true;
      commentsCompleteFrom = oldestCreatedAt(comments);
    } else if (covered) {
      commentsComplete = false;
      commentsCompleteFrom = oldestCreatedAt(comments);
    } else {
      commentsComplete = false;
      commentsCompleteFrom = undefined;
    }

    const labels = (issue.labels?.nodes ?? []).map((l: any) => l.name);
    const trackerStatus = issue.state?.name ?? "";
    const trackerStatusId = issue.state?.id ?? undefined;

    const attachments = (issue.attachments?.nodes ?? []).map((a: any) => ({
      id: String(a.id),
      filename: a.title ?? "",
      mimeType: "text/uri-list",
      size: 0,
      contentUrl: a.url || undefined,
    }));

    const related: RelatedTicket[] = [];
    const addRelated = (key: unknown, titleVal: unknown, statusVal: unknown, relation: string) => {
      if (typeof key !== "string" || key === "") return;
      if (related.some((entry) => entry.key === key && entry.relation === relation)) return;
      related.push({
        key,
        title: typeof titleVal === "string" ? titleVal : "",
        status: typeof statusVal === "string" ? statusVal : "",
        relation,
      });
    };

    if (issue.parent) {
      addRelated(issue.parent.identifier, issue.parent.title, issue.parent.state?.name, RELATED_TICKET_PARENT);
    }

    for (const child of issue.children?.nodes ?? []) {
      addRelated(child.identifier, child.title, child.state?.name, RELATED_TICKET_CHILD);
    }

    for (const rel of issue.relations?.nodes ?? []) {
      const typeStr = String(rel.type ?? "");
      let phrase = "relates to";
      if (typeStr === "blocks") phrase = "blocks";
      else if (typeStr === "duplicate") phrase = "duplicates";
      else if (typeStr === "related") phrase = "relates to";
      else if (typeStr === "similar") phrase = "is similar to";
      else if (typeStr) phrase = typeStr;

      addRelated(rel.relatedIssue?.identifier, rel.relatedIssue?.title, rel.relatedIssue?.state?.name, phrase);
    }

    for (const inv of issue.inverseRelations?.nodes ?? []) {
      const typeStr = String(inv.type ?? "");
      let phrase = "relates to";
      if (typeStr === "blocks") phrase = "is blocked by";
      else if (typeStr === "duplicate") phrase = "is duplicated by";
      else if (typeStr === "related") phrase = "relates to";
      else if (typeStr === "similar") phrase = "is similar to";
      else if (typeStr) phrase = typeStr;

      addRelated(inv.issue?.identifier, inv.issue?.title, inv.issue?.state?.name, phrase);
    }

    return {
      id: issue.id,
      identifier: issue.identifier,
      projectKey,
      title,
      description,
      acceptanceCriteria,
      comments,
      commentsComplete,
      commentsCompleteFrom,
      labels,
      trackerStatus,
      trackerStatusId,
      attachments,
      relatedTickets: related,
    };
  }

  /**
   * Posts a new comment to an issue.
   */
  async postComment(id: string, comment: string, options?: { signal?: AbortSignal }): Promise<string | null> {
    const mutation = `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment {
            id
            url
          }
        }
      }
    `;
    const data = await this.graphql<{ commentCreate?: { comment?: { url?: string } } }>(
      mutation,
      { issueId: id, body: comment },
      { signal: options?.signal, isMutation: true },
    );
    return data?.commentCreate?.comment?.url ?? null;
  }

  /**
   * Finds a comment containing a marker string.
   */
  async findCommentByMarker(id: string, marker: string): Promise<string | null> {
    let hasNextPage = true;
    let endCursor: string | null = null;
    let pagesCount = 0;

    while (hasNextPage && pagesCount < MAX_COMMENT_PAGES) {
      const query = `
        query IssueCommentsForMarker($id: String!, $cursor: String) {
          issue(id: $id) {
            comments(first: 100, after: $cursor) {
              nodes {
                id
                body
                url
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `;
      type MarkerCommentData = {
        issue?: {
          comments?: {
            nodes?: Array<{ id: string; body: string; url?: string }>;
            pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
          };
        };
      };
      const data: MarkerCommentData = await this.graphql<MarkerCommentData>(query, { id, cursor: endCursor });

      const nodes = data?.issue?.comments?.nodes ?? [];
      for (const node of nodes) {
        const lines = (node.body ?? "").split(/\r?\n/u);
        if (lines.some((line: string) => line.trim() === marker)) {
          return node.url ?? `${this.ticketUrl(id)}#comment-${node.id}`;
        }
      }

      hasNextPage = data?.issue?.comments?.pageInfo?.hasNextPage === true;
      endCursor = data?.issue?.comments?.pageInfo?.endCursor ?? null;
      pagesCount++;
    }

    return null;
  }

  /**
   * Resolves existing label IDs or creates missing ones for the team.
   */
  private async resolveLabelIds(teamId: string, labelNames: readonly string[]): Promise<string[]> {
    const names = Array.from(new Set(labelNames.map((n) => n.trim()).filter(Boolean)));
    if (names.length === 0) return [];

    const query = `
      query TeamLabels($filter: IssueLabelFilter!) {
        issueLabels(filter: $filter, first: 250) {
          nodes {
            id
            name
          }
        }
      }
    `;
    const filter = {
      and: [
        { or: names.map((name) => ({ name: { eqIgnoreCase: name } })) },
        {
          or: [
            { team: { key: { eq: this.projectKey } } },
            { team: { null: true } },
          ],
        },
      ],
    };
    const data = await this.graphql<{
      issueLabels?: { nodes?: Array<{ id: string; name: string }> };
    }>(query, { filter });

    const existingLabels = data?.issueLabels?.nodes ?? [];
    const labelMap = new Map<string, string>();
    for (const label of existingLabels) {
      if (label?.id && label?.name) {
        labelMap.set(label.name.toLowerCase(), label.id);
      }
    }

    const resolvedIds: string[] = [];
    for (const name of names) {
      const lower = name.toLowerCase();
      const existingId = labelMap.get(lower);
      if (existingId) {
        resolvedIds.push(existingId);
      } else {
        const createMutation = `
          mutation CreateLabel($input: IssueLabelCreateInput!) {
            issueLabelCreate(input: $input) {
              success
              issueLabel {
                id
                name
              }
            }
          }
        `;
        const res = await this.graphql<{ issueLabelCreate?: { issueLabel?: { id: string; name: string } } }>(
          createMutation,
          { input: { teamId, name } },
          { isMutation: true, readsFieldErrors: true },
        );
        const createdId = res?.issueLabelCreate?.issueLabel?.id;
        if (!createdId) {
          throw new IssueTrackerInputRejectedError(`Linear did not create the label "${name}".`, {
            issueTypeRejected: false,
          });
        }
        labelMap.set(lower, createdId);
        resolvedIds.push(createdId);
      }
    }

    return resolvedIds;
  }

  /**
   * Creates a new issue in Linear with title, description, and labels.
   */
  async createTicket(input: {
    summary: string;
    description?: string;
    issueType?: string;
    labels?: string[];
  }): Promise<{ identifier: string; url: string | null }> {
    const teamId = await this.ensureTeamId();
    const labelIds = input.labels?.length ? await this.resolveLabelIds(teamId, input.labels) : [];

    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            url
          }
        }
      }
    `;
    const issueInput: Record<string, unknown> = {
      teamId,
      title: input.summary,
      ...(input.description ? { description: input.description } : {}),
      ...(labelIds.length > 0 ? { labelIds } : {}),
    };

    const data = await this.graphql<{ issueCreate?: { issue?: { id: string; identifier: string; url?: string } } }>(
      mutation,
      { input: issueInput },
      { isMutation: true, readsFieldErrors: true },
    );

    const issue = data?.issueCreate?.issue;
    if (!issue?.identifier) {
      throw new Error("Linear did not return an issue identifier upon creation.");
    }

    return {
      identifier: issue.identifier,
      url: issue.url ?? this.ticketUrl(issue.identifier),
    };
  }

  /**
   * Lists issue types (Linear does not use issue types, returns empty array).
   */
  async listIssueTypes(): Promise<Array<{ id: string; name: string }>> {
    return [];
  }

  /**
   * Finds issue keys in a specific workflow status.
   */
  async ticketsInStatus(status: string, options?: { limit?: number }): Promise<string[]> {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const query = `
      query IssuesInState($teamKey: String!, $stateName: String!, $first: Int!) {
        issues(
          filter: {
            team: { key: { eq: $teamKey } }
            state: { name: { eqIgnoreCase: $stateName } }
          }
          orderBy: createdAt
          first: $first
        ) {
          nodes {
            identifier
            createdAt
          }
        }
      }
    `;
    const data = await this.graphql<{ issues?: { nodes?: Array<{ identifier: string; createdAt: string }> } }>(
      query,
      { teamKey: this.projectKey, stateName: status, first: limit },
    );

    const nodes = data?.issues?.nodes ?? [];
    const sorted = [...nodes].sort((a, b) => {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
      return ta - tb;
    });

    return sorted.map((n) => n.identifier);
  }

  /**
   * Finds issue keys carrying a specific label.
   */
  async ticketsWithLabel(label: string): Promise<string[]> {
    const query = `
      query IssuesWithLabel($teamKey: String!, $labelName: String!, $first: Int!) {
        issues(
          filter: {
            team: { key: { eq: $teamKey } }
            labels: { name: { eqIgnoreCase: $labelName } }
          }
          first: $first
        ) {
          nodes {
            identifier
          }
        }
      }
    `;
    const data = await this.graphql<{ issues?: { nodes?: Array<{ identifier: string }> } }>(
      query,
      { teamKey: this.projectKey, labelName: label, first: 50 },
    );
    return (data?.issues?.nodes ?? []).map((n) => n.identifier);
  }

  /**
   * Searches for issues using keywords.
   */
  async findTickets(input: {
    keywords: readonly string[];
    limit: number;
    providerQuery?: string;
  }): Promise<TicketSummary[]> {
    const queryStr = input.keywords.map((k) => k.trim()).filter(Boolean).join(" ");
    if (queryStr === "") return [];

    const first = Math.min(Math.max(input.limit || 10, 1), 50);
    const query = `
      query FindIssues($teamKey: String!, $query: String!, $first: Int!) {
        issues(
          filter: {
            team: { key: { eq: $teamKey } }
            searchableContent: { contains: $query }
          }
          first: $first
        ) {
          nodes {
            identifier
            title
            description
            url
            updatedAt
            state { name }
            creator { name }
            team { key }
          }
        }
      }
    `;
    const data = await this.graphql<{
      issues?: {
        nodes?: Array<{
          identifier: string;
          title?: string;
          description?: string;
          url?: string;
          updatedAt?: string;
          state?: { name?: string };
          creator?: { name?: string };
          team?: { key?: string };
        }>;
      };
    }>(query, { teamKey: this.projectKey, query: queryStr, first });

    const nodes = data?.issues?.nodes ?? [];
    return nodes.map((node) => ({
      key: node.identifier,
      summary: node.title ?? "",
      status: node.state?.name ?? "",
      url: node.url ?? this.ticketUrl(node.identifier) ?? "",
      excerpt: truncateExcerpt(node.description ?? ""),
      reporter: node.creator?.name ?? "",
      project: node.team?.key ?? this.projectKey,
      updatedAt: node.updatedAt ?? "",
    }));
  }

  /**
   * Adds and removes labels on an issue.
   */
  async updateLabels(id: string, changes: { add?: string[]; remove?: string[] }): Promise<void> {
    const toAdd = changes.add?.filter(Boolean) ?? [];
    const toRemove = changes.remove?.filter(Boolean) ?? [];
    if (toAdd.length === 0 && toRemove.length === 0) return;

    const query = `
      query IssueLabelsForUpdate($id: String!) {
        issue(id: $id) {
          id
          labels {
            nodes {
              id
              name
            }
          }
        }
      }
    `;
    const data = await this.graphql<{ issue?: { id: string; labels?: { nodes?: Array<{ id: string; name: string }> } } }>(
      query,
      { id },
    );
    const existingNodes = data?.issue?.labels?.nodes ?? [];
    const teamId = await this.ensureTeamId();

    const addIds = toAdd.length > 0 ? await this.resolveLabelIds(teamId, toAdd) : [];
    const removeSet = new Set(toRemove.map((r) => r.trim().toLowerCase()));

    const keptIds = existingNodes
      .filter((node) => !removeSet.has(node.name.trim().toLowerCase()))
      .map((node) => node.id);

    const mergedIds = Array.from(new Set([...keptIds, ...addIds]));

    const mutation = `
      mutation UpdateIssueLabels($id: String!, $labelIds: [String!]!) {
        issueUpdate(id: $id, input: { labelIds: $labelIds }) {
          success
        }
      }
    `;
    await this.graphql(mutation, { id, labelIds: mergedIds }, { isMutation: true });
  }

  /**
   * Lists registered webhooks in the workspace.
   */
  async listWebhookRegistrations(
    signal?: AbortSignal | null,
  ): Promise<Array<{ url: string; enabled: boolean; events: string[] }> | null> {
    const query = `
      query Webhooks {
        webhooks {
          nodes {
            id
            url
            enabled
            resourceTypes
          }
        }
      }
    `;
    try {
      const data = await this.graphql<{
        webhooks?: {
          nodes?: Array<{
            id: string;
            url?: string;
            enabled?: boolean;
            resourceTypes?: string[];
          }>;
        };
      }>(query, undefined, { signal: signal ?? undefined });

      const nodes = data?.webhooks?.nodes ?? [];
      return nodes.map((node) => ({
        url: node.url ?? "",
        enabled: node.enabled === true,
        events: Array.isArray(node.resourceTypes) ? node.resourceTypes : [],
      }));
    } catch (error: any) {
      if (error?.status === 401 || error?.status === 403 || error?.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
