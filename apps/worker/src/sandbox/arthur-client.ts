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
 * Per-task aggregate over a window from `POST /api/v1/traces/overview`.
 * Token/cost fields come from Arthur's `TokenCountCostSchema`; `trace_token_cost`
 * may be null when cost is unavailable. Typed per the documented shape — these
 * read endpoints are UNVERIFIED against a live instance, so parsing stays
 * defensive (callers treat null cost as 0).
 */
export interface TraceOverview {
  task_id: string;
  trace_count: number;
  trace_token_count: number;
  trace_token_cost: number | null;
  eval_count: number;
  continuous_eval_success_rate: number;
  last_active?: string;
}

export interface TraceOverviewListResponse {
  count: number;
  overviews: TraceOverview[];
}

/** One bucket from `POST /api/v1/traces/overview/timeseries` (single task). */
export interface TraceTimeseriesPoint {
  timestamp: string;
  trace_count: number;
  trace_token_count: number;
  trace_token_cost: number | null;
  continuous_eval_success_rate?: number;
}

/** Token/cost-by-model aggregation result (one row per Arthur `model_name`). */
export interface ModelTokenCost {
  model: string;
  tokens: number;
  cost: number;
}

/** A span row from `GET /api/v1/traces/spans` carrying model + token/cost fields. */
interface SpanTokenCost {
  model_name: string | null;
  total_token_count: number | null;
  total_token_cost: number | null;
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

export class ArthurClient {
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
   * Fleet eval/cost aggregate over a window. One call covers multiple tasks;
   * sum across `overviews` for fleet totals. `taskIds` may be empty (see the
   * empty-means-all-org open question in the specs). Shared by /evals + /cost.
   */
  async getTracesOverview(
    taskIds: string[],
    startTime: string,
    endTime: string,
  ): Promise<TraceOverviewListResponse> {
    return this.request<TraceOverviewListResponse>("/api/v1/traces/overview", {
      method: "POST",
      body: JSON.stringify({
        task_ids: taskIds,
        start_time: startTime,
        end_time: endTime,
      }),
    });
  }

  /**
   * Per-bucket timeseries for a single task. The caller fans out one call per
   * task and merges points by timestamp. The response envelope key is
   * unverified, so accept both a bare array and a `{ points }` wrapper.
   */
  async getTracesTimeseries(
    taskId: string,
    startTime: string,
    endTime: string,
    bucketSize: string,
  ): Promise<TraceTimeseriesPoint[]> {
    const res = await this.request<{ points?: TraceTimeseriesPoint[] } | TraceTimeseriesPoint[]>(
      "/api/v1/traces/overview/timeseries",
      {
        method: "POST",
        body: JSON.stringify({
          task_id: taskId,
          start_time: startTime,
          end_time: endTime,
          bucket_size: bucketSize,
        }),
      },
    );
    return Array.isArray(res) ? res : (res.points ?? []);
  }

  /**
   * By-model token/cost aggregation — Arthur has no per-model overview, so we
   * fetch span rows (which carry `model_name` + token/cost fields) and sum
   * grouped by `model_name`. Spans with a null `model_name` are skipped.
   */
  async aggregateSpanTokensByModel(
    taskIds: string[],
    startTime: string,
    endTime: string,
  ): Promise<ModelTokenCost[]> {
    // TODO(arthur-verify): pagination — first page only, bounded to N spans. The
    // read endpoints are unverified, so we send a bounded `limit` rather than
    // looping pages; this makes the ceiling explicit instead of pulling an
    // unbounded result set and summing it silently in memory.
    const res = await this.request<{ spans?: SpanTokenCost[] } | SpanTokenCost[]>(
      "/api/v1/traces/spans",
      {
        method: "POST",
        body: JSON.stringify({
          task_ids: taskIds,
          start_time: startTime,
          end_time: endTime,
          limit: 1000,
        }),
      },
    );
    const spans = Array.isArray(res) ? res : (res.spans ?? []);
    const byModel = new Map<string, ModelTokenCost>();
    for (const span of spans) {
      if (!span.model_name) continue;
      const row = byModel.get(span.model_name) ?? {
        model: span.model_name,
        tokens: 0,
        cost: 0,
      };
      row.tokens += span.total_token_count ?? 0;
      row.cost += span.total_token_cost ?? 0;
      byModel.set(span.model_name, row);
    }
    return [...byModel.values()];
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
