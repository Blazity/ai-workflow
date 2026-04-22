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
}
