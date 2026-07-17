/**
 * Minimal client for the Arthur GenAI Engine tasks API.
 *
 * Used by the workflow to auto-create a per-ticket Arthur task so every run
 * gets its own observability bucket. Re-runs of the same ticket get a
 * `.1`, `.2`, … suffix.
 */

export interface ArthurTask {
  id: string;
  name: string;
  is_archived?: boolean;
}

export interface AgenticPrompt {
  name: string;
  version?: number | string;
  messages: Array<{ role: string; content: string }>;
}

interface SearchResponse {
  count: number;
  tasks: ArthurTask[];
}

/**
 * One trace row from `GET /api/v1/traces`. Arthur has no pre-aggregated overview
 * endpoint, so the cost collector pulls these rows and aggregates client-side.
 * Token/cost come straight from Arthur (`*_token_cost` may be null when cost is
 * unavailable — callers treat null as 0). Extra fields the API returns are
 * ignored.
 */
export interface TraceRow {
  task_id: string;
  total_token_count: number;
  total_token_cost: number | null;
  /** Trace start, ISO. Used to bucket daily spend. */
  start_time: string;
}

interface TraceListResponse {
  count: number;
  traces: TraceRow[];
}

/** One Arthur prompt version's metadata (no message body). */
export interface ArthurPromptVersion {
  version: number;
  created_at: string;
  deleted_at: string | null;
  model_provider: string;
  model_name: string;
  tags: string[];
  num_messages: number;
  num_tools: number;
}

interface AgenticPromptVersionListResponse {
  count: number;
  versions: ArthurPromptVersion[];
}

/** One rule outcome from `validate_prompt`, coerced to a stable minimal shape. */
export interface PromptValidationFinding {
  rule: string;
  result: string;
  details?: string;
}

export interface PromptValidationResult {
  ok: boolean;
  findings: PromptValidationFinding[];
}

/** Max characters kept from a rule's details payload. */
const VALIDATION_DETAILS_MAX_CHARS = 500;

/** Split `items` into consecutive chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class ArthurClient {
  /** Page size for the paginated trace endpoint. */
  private static readonly PAGE_SIZE = 100;
  /** One oversized page for task enumeration (`GET /api/v2/tasks` pagination is unreliable). */
  private static readonly TASK_PAGE_SIZE = 1000;
  /** Max `task_ids` per trace query — keeps the GET URL well under server limits. */
  private static readonly TASK_ID_BATCH = 50;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  /**
   * Derive the Arthur base URL from the full traces endpoint by stripping
   * `/api/v1/traces` (the tracer writes the full path; the tasks API lives
   * under the same host at `/api/v2/tasks`).
   */
  static fromTraceEndpoint(endpoint: string, apiKey: string): ArthurClient {
    const base = endpoint.replace(/\/api\/v1\/traces\/?$/, "").replace(/\/+$/, "");
    return new ArthurClient(base, apiKey);
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Arthur ${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** GET that treats 404 as "absent" (returns null) instead of throwing — for the prompt read paths. */
  private async getAllowing404<T>(path: string): Promise<T | null> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}`, "ngrok-skip-browser-warning": "true" },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Arthur GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Return tasks whose name equals `prefix` or matches `^prefix\.\d+$`.
   * Arthur's `task_name` search is substring-based, so we post-filter to
   * avoid `AWT-1` catching `AWT-10`.
   */
  async findTicketTasks(prefix: string): Promise<ArthurTask[]> {
    const { tasks } = await this.request<SearchResponse>("/api/v2/tasks/search", {
      method: "POST",
      body: JSON.stringify({ task_name: prefix }),
    });
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}(\\.\\d+)?$`);
    return tasks.filter((t) => re.test(t.name) && !t.is_archived);
  }

  async createTask(name: string): Promise<ArthurTask> {
    return this.request<ArthurTask>("/api/v2/tasks", {
      method: "POST",
      body: JSON.stringify({ name, is_agentic: true }),
    });
  }

  /**
   * Resolve-or-create a task for a ticket identifier.
   *   first run:  "AWT-42"
   *   re-runs:    "AWT-42.1", "AWT-42.2", ...
   *
   * Uses max(existing suffix) + 1 so sparse histories (e.g. AWT-42.2 present
   * without AWT-42.1) don't collide with an existing name.
   */
  async ensureTaskForTicket(identifier: string): Promise<ArthurTask> {
    const existing = await this.findTicketTasks(identifier);
    if (existing.length === 0) return this.createTask(identifier);
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const suffixRe = new RegExp(`^${escaped}\\.(\\d+)$`);
    let max = 0;
    for (const t of existing) {
      const m = t.name.match(suffixRe);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return this.createTask(`${identifier}.${max + 1}`);
  }

  /** Exact-name lookup. Returns the task if found (non-archived), else null. */
  async findTaskByName(name: string): Promise<ArthurTask | null> {
    const { tasks } = await this.request<{ count: number; tasks: ArthurTask[] }>(
      "/api/v2/tasks/search",
      { method: "POST", body: JSON.stringify({ task_name: name }) },
    );
    return tasks.find((t) => t.name === name && !t.is_archived) ?? null;
  }

  /**
   * Create a task for non-ticket purposes (e.g. the shared prompt-host task).
   * Body is identical to `createTask` today — kept as a separate method so
   * callers signal intent and so the two paths can diverge later without
   * touching each other's call sites.
   */
  async createPlainTask(name: string): Promise<ArthurTask> {
    return this.request<ArthurTask>("/api/v2/tasks", {
      method: "POST",
      body: JSON.stringify({ name, is_agentic: true }),
    });
  }

  /**
   * Run the task's prompt rules against `content` via `validate_prompt`.
   * The raw Arthur response contract is intentionally not load-bearing:
   * entries are coerced defensively, and a response without an array
   * `rule_results` throws so callers can treat the check as skipped.
   * `ok` is true only when every rule result is exactly "Pass" (Arthur's
   * enum is "Pass"/"Fail", case-sensitive).
   */
  async validatePrompt(taskId: string, content: string): Promise<PromptValidationResult> {
    const response = await this.request<{ rule_results?: unknown }>(
      `/api/v2/tasks/${encodeURIComponent(taskId)}/validate_prompt`,
      { method: "POST", body: JSON.stringify({ prompt: content }) },
    );
    const raw = response?.rule_results;
    if (!Array.isArray(raw)) {
      throw new Error("unexpected validate_prompt response shape");
    }
    const findings: PromptValidationFinding[] = raw.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      const finding: PromptValidationFinding = {
        rule: String(e.name ?? e.id ?? "unknown"),
        result: String(e.result ?? "Unavailable"),
      };
      if (e.details != null) {
        const text = typeof e.details === "string" ? e.details : JSON.stringify(e.details);
        finding.details = text.slice(0, VALIDATION_DETAILS_MAX_CHARS);
      }
      return finding;
    });
    return { ok: findings.every((f) => f.result === "Pass"), findings };
  }

  /** Fetch a tagged prompt version. Returns the first message's content, or null if 404. */
  async getPromptByTag(taskId: string, name: string, tag: string): Promise<string | null> {
    const path = `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}/versions/tags/${encodeURIComponent(tag)}`;
    const prompt = await this.getAllowing404<AgenticPrompt>(path);
    return prompt?.messages?.[0]?.content ?? null;
  }

  /** Create a new version of a named prompt on a task. Content is sent as a single user message. */
  async createPromptVersion(
    taskId: string,
    name: string,
    content: string,
    opts: { modelName?: string; modelProvider?: string } = {},
  ): Promise<AgenticPrompt> {
    return this.request<AgenticPrompt>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}`,
      {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content }],
          model_name: opts.modelName ?? "claude-opus-4-6",
          model_provider: opts.modelProvider ?? "anthropic",
        }),
      },
    );
  }

  /** Add a tag (e.g. "production") to a specific version. */
  async tagPromptVersion(taskId: string, name: string, version: number | string, tag: string): Promise<void> {
    await this.request<AgenticPrompt>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}/versions/${encodeURIComponent(String(version))}/tags`,
      {
        method: "PUT",
        body: JSON.stringify({ tag }),
      },
    );
  }

  /**
   * Enumerate every task via `GET /api/v2/tasks` (one large page). The trace read
   * endpoints require an explicit `task_ids` list (empty → 400), so cost/evals
   * fan these ids into `listTraces`/`countTraces`. Includes archived tasks so
   * historical spend stays in the totals.
   *
   * NOTE: `tasks/search` and the `page` param are unreliable on this Arthur build
   * (page is effectively ignored, the result set drifts with page size), so we
   * read a single oversized page rather than looping. Single-tenant task counts
   * stay well under the cap; dedupe defensively.
   */
  async listAllTasks(): Promise<ArthurTask[]> {
    const tasks = await this.request<ArthurTask[]>(
      `/api/v2/tasks?page_size=${ArthurClient.TASK_PAGE_SIZE}`,
      { method: "GET" },
    );
    const seen = new Set<string>();
    return tasks.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }

  /**
   * All trace rows for `taskIds` in the window, from `GET /api/v1/traces`.
   * Batches the ids (the list lands in the query string, so we cap each request)
   * and pages each batch via the `count` field. The collector aggregates these
   * client-side — Arthur exposes no pre-aggregated cost/overview endpoint.
   */
  async listTraces(taskIds: string[], startTime: string, endTime: string): Promise<TraceRow[]> {
    const out: TraceRow[] = [];
    for (const batch of chunk(taskIds, ArthurClient.TASK_ID_BATCH)) {
      let collected = 0;
      let total = Infinity;
      // Arthur pages are 0-indexed — page=1 skips the first page of results.
      for (let page = 0; collected < total; page++) {
        const qs = this.traceQuery(batch, startTime, endTime, { page: String(page) });
        const { count, traces } = await this.request<TraceListResponse>(
          `/api/v1/traces?${qs}`,
          { method: "GET" },
        );
        total = count;
        if (traces.length === 0) break;
        out.push(...traces);
        collected += traces.length;
      }
    }
    return out;
  }

  /**
   * Count of traces matching the window + optional `filters` (e.g. an eval-status
   * filter). Reads the `count` field with `page_size=1` so no rows are fetched;
   * sums across task-id batches (the batches are disjoint, so counts add).
   */
  async countTraces(
    taskIds: string[],
    startTime: string,
    endTime: string,
    filters: Record<string, string> = {},
  ): Promise<number> {
    let total = 0;
    for (const batch of chunk(taskIds, ArthurClient.TASK_ID_BATCH)) {
      const qs = this.traceQuery(batch, startTime, endTime, { page_size: "1", ...filters });
      const { count } = await this.request<TraceListResponse>(`/api/v1/traces?${qs}`, {
        method: "GET",
      });
      total += count;
    }
    return total;
  }

  /** Build the shared `GET /api/v1/traces` query (repeated `task_ids` + window + extras). */
  private traceQuery(
    taskIds: string[],
    startTime: string,
    endTime: string,
    extra: Record<string, string>,
  ): URLSearchParams {
    const p = new URLSearchParams();
    for (const id of taskIds) p.append("task_ids", id);
    p.set("start_time", startTime);
    p.set("end_time", endTime);
    if (!("page_size" in extra)) p.set("page_size", String(ArthurClient.PAGE_SIZE));
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }

  /** List version metadata for a named prompt (newest first). First page only. Empty on 404. */
  async listPromptVersions(taskId: string, name: string): Promise<ArthurPromptVersion[]> {
    const path = `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}/versions`;
    const data = await this.getAllowing404<AgenticPromptVersionListResponse>(path);
    return [...(data?.versions ?? [])].sort((a, b) => b.version - a.version);
  }

  /**
   * Fetch the body of a specific version. `version` accepts an integer,
   * `"latest"`, an ISO datetime, or a tag. Returns the first message's content,
   * or null on 404. Generalizes the by-version GET that `getPromptByTag` uses.
   */
  async getPromptVersionBody(taskId: string, name: string, version: number | string): Promise<string | null> {
    const path = `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}/versions/${encodeURIComponent(String(version))}`;
    const prompt = await this.getAllowing404<AgenticPrompt>(path);
    return prompt?.messages?.[0]?.content ?? null;
  }
}
