/**
 * The slice of Arthur's GenAI Engine API this integration uses: tasks, the
 * prompt validator, and the trace counts the Evals page reads.
 *
 * Every request goes through `ctx.http`, so the timeout, the retry policy for
 * reads and the redaction of the API key from anything core records are the
 * contract's, not this file's.
 */
import type { IntegrationContext } from "@integrations/sdk";
import type { manifest } from "./manifest";

export type ArthurContext = IntegrationContext<typeof manifest>;

export interface ArthurTask {
  id: string;
  name: string;
  is_archived?: boolean;
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
/** One oversized page for task enumeration; this engine's `page` param is unreliable. */
const TASK_PAGE_SIZE = 1000;
/** Max `task_ids` per trace query, which keeps the GET URL well under server limits. */
const TASK_ID_BATCH = 50;

/**
 * The engine's base URL, read from the traces endpoint the deployment
 * configured.
 *
 * The variable has always held the full OTLP path because that is what the
 * in-sandbox tracer posts to, and the tasks API lives under the same host at
 * `/api/v2/tasks`. Deriving one from the other is what lets a deployment name
 * its engine once, and it is why this integration takes a trace endpoint
 * rather than a base URL: changing the meaning of the variable would point
 * every existing deployment at the wrong paths while its card still read
 * Connected.
 */
export function engineBaseUrl(traceEndpoint: string): string {
  return traceEndpoint.replace(/\/api\/v1\/traces\/?$/, "").replace(/\/+$/, "");
}

export class ArthurClient {
  private readonly baseUrl: string;

  constructor(private readonly ctx: ArthurContext) {
    this.baseUrl = engineBaseUrl(ctx.connection.traceEndpoint);
  }

  private async request<T>(path: string, init: RequestInit & { retries?: number }): Promise<T> {
    const response = await this.ctx.http.fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: this.ctx.signal,
      headers: {
        "Authorization": `Bearer ${this.ctx.connection.apiKey}`,
        "Content-Type": "application/json",
        // Some deployments sit behind an ngrok tunnel, which otherwise answers
        // the browser warning page instead of the API.
        "ngrok-skip-browser-warning": "true",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Arthur ${init.method ?? "GET"} ${path} -> ${response.status}: ${body.slice(0, 300)}`,
      );
    }
    return (await response.json()) as T;
  }

  /** Whether the engine accepts this key: the cheapest call it offers. */
  async ping(): Promise<void> {
    await this.request<unknown>("/api/v2/tasks?page_size=1", { method: "GET", retries: 0 });
  }

  /**
   * Tasks whose name is `prefix` or matches `^prefix\.\d+$`. The engine's
   * search is substring based, so `AWT-1` would otherwise catch `AWT-10`.
   */
  async findTicketTasks(prefix: string): Promise<ArthurTask[]> {
    const { tasks } = await this.request<{ tasks: ArthurTask[] }>("/api/v2/tasks/search", {
      method: "POST",
      body: JSON.stringify({ task_name: prefix }),
    });
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}(\\.\\d+)?$`);
    return tasks.filter((task) => pattern.test(task.name) && !task.is_archived);
  }

  async createTask(name: string): Promise<ArthurTask> {
    return this.request<ArthurTask>("/api/v2/tasks", {
      method: "POST",
      body: JSON.stringify({ name, is_agentic: true }),
    });
  }

  /**
   * Attach a prompt-injection rule to a task so `validate_prompt` actually
   * screens for injection. The create endpoint takes no rules inline and this
   * engine configures no default prompt rule, so a fresh task has an empty
   * rule set and would pass every prompt. `apply_to_response` must be false:
   * the engine rejects a prompt-injection rule that also applies to responses.
   */
  async addPromptInjectionRule(taskId: string): Promise<void> {
    await this.request<unknown>(`/api/v2/tasks/${encodeURIComponent(taskId)}/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: "Prompt Injection Rule",
        type: "PromptInjectionRule",
        apply_to_prompt: true,
        apply_to_response: false,
      }),
    });
  }

  /**
   * Resolve or create the task for a subject: `AWT-42` the first time,
   * `AWT-42.1`, `AWT-42.2` after that. It is not idempotent, which is exactly
   * why a run creates its task once and carries the id (see the manifest's
   * `runState`).
   *
   * max(existing suffix) + 1, so a sparse history (`AWT-42.2` without
   * `AWT-42.1`) does not collide with a name already taken.
   */
  async ensureTaskForSubject(subjectKey: string): Promise<ArthurTask> {
    const existing = await this.findTicketTasks(subjectKey);
    if (existing.length === 0) return this.createTask(subjectKey);
    const escaped = subjectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const suffix = new RegExp(`^${escaped}\\.(\\d+)$`);
    let highest = 0;
    for (const task of existing) {
      const match = task.name.match(suffix);
      if (match) highest = Math.max(highest, Math.trunc(Number(match[1])));
    }
    return this.createTask(`${subjectKey}.${highest + 1}`);
  }

  /**
   * Run the task's prompt rules against `content`.
   *
   * The response contract is deliberately not load-bearing: entries are coerced
   * defensively, and a response without an array `rule_results` throws, because
   * a shape this integration cannot read is not a clean bill of health. `ok` is
   * true only when every rule result is exactly "Pass" (the engine's enum is
   * "Pass" and "Fail", case sensitive).
   */
  async validatePrompt(taskId: string, content: string): Promise<PromptValidationResult> {
    const response = await this.request<{ rule_results?: unknown }>(
      `/api/v2/tasks/${encodeURIComponent(taskId)}/validate_prompt`,
      { method: "POST", body: JSON.stringify({ prompt: content }) },
    );
    const raw = response?.rule_results;
    if (!Array.isArray(raw)) {
      // The caller reads this as the engine failing, not as a mistake in ours.
      // oxlint-disable-next-line unicorn/prefer-type-error -- see above
      throw new Error("The engine answered validate_prompt in a shape this build cannot read.");
    }
    const findings: PromptValidationFinding[] = raw.map((entry) => {
      const fields = (entry ?? {}) as Record<string, unknown>;
      const finding: PromptValidationFinding = {
        rule: String(fields.name ?? fields.id ?? "unknown"),
        result: String(fields.result ?? "Unavailable"),
      };
      if (fields.details != null) {
        const text =
          typeof fields.details === "string" ? fields.details : JSON.stringify(fields.details);
        finding.details = text.slice(0, VALIDATION_DETAILS_MAX_CHARS);
      }
      return finding;
    });
    return { ok: findings.every((finding) => finding.result === "Pass"), findings };
  }

  /**
   * Every task, in one oversized page. The trace endpoints require an explicit
   * `task_ids` list (an empty one is a 400), so the counts below fan these ids
   * out. Archived tasks are included so historical grading stays in the totals.
   *
   * `tasks/search` and the `page` parameter are unreliable on this engine (the
   * result set drifts with the page size), so this reads one page rather than
   * looping, dedupes what comes back, and says when that page was full.
   */
  async listAllTasks(): Promise<{ tasks: ArthurTask[]; truncated: boolean }> {
    const page = await this.request<ArthurTask[]>(`/api/v2/tasks?page_size=${TASK_PAGE_SIZE}`, {
      method: "GET",
    });
    const seen = new Set<string>();
    const tasks = page.filter((task) => (seen.has(task.id) ? false : (seen.add(task.id), true)));
    // A full page is the only sign there is more: the engine sends no total.
    return { tasks, truncated: page.length >= TASK_PAGE_SIZE };
  }

  /**
   * How many traces match the window and the filters. Reads the `count` field
   * with `page_size=1` so no rows travel, and sums across id batches, which are
   * disjoint and therefore add.
   */
  async countTraces(
    taskIds: string[],
    startTime: string,
    endTime: string,
    filters: Record<string, string> = {},
  ): Promise<number> {
    let total = 0;
    for (const batch of chunk(taskIds, TASK_ID_BATCH)) {
      const query = new URLSearchParams();
      for (const id of batch) query.append("task_ids", id);
      query.set("start_time", startTime);
      query.set("end_time", endTime);
      query.set("page_size", "1");
      for (const [key, value] of Object.entries(filters)) query.set(key, value);
      const { count } = await this.request<{ count: number }>(`/api/v1/traces?${query}`, {
        method: "GET",
      });
      total += count;
    }
    return total;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}
