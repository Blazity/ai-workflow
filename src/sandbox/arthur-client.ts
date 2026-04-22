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
   */
  async ensureTaskForTicket(identifier: string): Promise<ArthurTask> {
    const existing = await this.findTicketTasks(identifier);
    const name = existing.length === 0 ? identifier : `${identifier}.${existing.length}`;
    return this.createTask(name);
  }

  /** Exact-name lookup. Returns the task if found (non-archived), else null. */
  async findTaskByName(name: string): Promise<ArthurTask | null> {
    const { tasks } = await this.request<{ count: number; tasks: ArthurTask[] }>(
      "/api/v2/tasks/search",
      { method: "POST", body: JSON.stringify({ task_name: name }) },
    );
    return tasks.find((t) => t.name === name && !t.is_archived) ?? null;
  }

  /** Create a task without the agent-metadata/is_agentic defaults used by ensureTaskForTicket. */
  async createPlainTask(name: string): Promise<ArthurTask> {
    return this.request<ArthurTask>("/api/v2/tasks", {
      method: "POST",
      body: JSON.stringify({ name, is_agentic: true }),
    });
  }

  /** Fetch a tagged prompt version. Returns the first message's content, or null if 404. */
  async getPromptByTag(taskId: string, name: string, tag: string): Promise<string | null> {
    const path = `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}/versions/tags/${encodeURIComponent(tag)}`;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "ngrok-skip-browser-warning": "true",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Arthur GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    const prompt = (await res.json()) as AgenticPrompt;
    const first = prompt.messages?.[0];
    return first?.content ?? null;
  }

  /** Create a new version of a named prompt on a task. Content is sent as a single user message. */
  async createPromptVersion(taskId: string, name: string, content: string): Promise<AgenticPrompt> {
    return this.request<AgenticPrompt>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/prompts/${encodeURIComponent(name)}`,
      {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content }],
          model_name: "claude-sonnet-4",
          model_provider: "anthropic",
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
}
