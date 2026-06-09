import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArthurClient } from "./arthur-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ArthurClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("fromTraceEndpoint", () => {
    it("strips /api/v1/traces from the endpoint", () => {
      const c = ArthurClient.fromTraceEndpoint("https://host.example/api/v1/traces", "k");
      expect((c as unknown as { baseUrl: string }).baseUrl).toBe("https://host.example");
    });

    it("handles trailing slash", () => {
      const c = ArthurClient.fromTraceEndpoint("https://host.example/api/v1/traces/", "k");
      expect((c as unknown as { baseUrl: string }).baseUrl).toBe("https://host.example");
    });
  });

  describe("findTicketTasks", () => {
    it("filters substring matches to exact prefix or prefix.N", async () => {
      // Arthur search is substring-based: "AWT-1" matches AWT-1, AWT-10, AWT-1.1, AWT-100, AWT-123
      mockFetch.mockResolvedValueOnce(jsonResponse({
        count: 5,
        tasks: [
          { id: "a", name: "AWT-1" },
          { id: "b", name: "AWT-10" },
          { id: "c", name: "AWT-1.1" },
          { id: "d", name: "AWT-1.2" },
          { id: "e", name: "AWT-100" },
        ],
      }));

      const client = new ArthurClient("http://host", "k");
      const result = await client.findTicketTasks("AWT-1");
      expect(result.map((t) => t.name)).toEqual(["AWT-1", "AWT-1.1", "AWT-1.2"]);
    });

    it("excludes archived tasks", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        count: 2,
        tasks: [
          { id: "a", name: "AWT-42", is_archived: true },
          { id: "b", name: "AWT-42.1", is_archived: false },
        ],
      }));

      const client = new ArthurClient("http://host", "k");
      const result = await client.findTicketTasks("AWT-42");
      expect(result.map((t) => t.id)).toEqual(["b"]);
    });

    it("sends auth header and correct body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 0, tasks: [] }));
      const client = new ArthurClient("http://host", "secret");
      await client.findTicketTasks("AWT-1");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v2/tasks/search");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer secret");
      expect(JSON.parse(init.body)).toEqual({ task_name: "AWT-1" });
    });
  });

  describe("ensureTaskForTicket", () => {
    it("first run → creates task with exact identifier", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ count: 0, tasks: [] })) // search
        .mockResolvedValueOnce(jsonResponse({ id: "new-id", name: "AWT-42" })); // create

      const client = new ArthurClient("http://host", "k");
      const task = await client.ensureTaskForTicket("AWT-42");

      expect(task).toEqual({ id: "new-id", name: "AWT-42" });
      const createCall = mockFetch.mock.calls[1];
      expect(JSON.parse(createCall[1].body)).toEqual({ name: "AWT-42", is_agentic: true });
    });

    it("second run → creates AWT-42.1", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ count: 1, tasks: [{ id: "a", name: "AWT-42" }] }))
        .mockResolvedValueOnce(jsonResponse({ id: "new", name: "AWT-42.1" }));

      const client = new ArthurClient("http://host", "k");
      const task = await client.ensureTaskForTicket("AWT-42");

      expect(task.name).toBe("AWT-42.1");
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).name).toBe("AWT-42.1");
    });

    it("third run → creates AWT-42.2", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          count: 2,
          tasks: [
            { id: "a", name: "AWT-42" },
            { id: "b", name: "AWT-42.1" },
          ],
        }))
        .mockResolvedValueOnce(jsonResponse({ id: "new", name: "AWT-42.2" }));

      const client = new ArthurClient("http://host", "k");
      const task = await client.ensureTaskForTicket("AWT-42");

      expect(task.name).toBe("AWT-42.2");
    });

    it("sparse suffixes → uses max+1 (AWT-42 + AWT-42.2 → AWT-42.3)", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          count: 2,
          tasks: [
            { id: "a", name: "AWT-42" },
            { id: "b", name: "AWT-42.2" },
          ],
        }))
        .mockResolvedValueOnce(jsonResponse({ id: "new", name: "AWT-42.3" }));

      const client = new ArthurClient("http://host", "k");
      const task = await client.ensureTaskForTicket("AWT-42");

      expect(task.name).toBe("AWT-42.3");
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).name).toBe("AWT-42.3");
    });

    it("does not collide with AWT-420 when resolving AWT-42", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          count: 3,
          tasks: [
            { id: "a", name: "AWT-42" },
            { id: "b", name: "AWT-420" },
            { id: "c", name: "AWT-421" },
          ],
        }))
        .mockResolvedValueOnce(jsonResponse({ id: "new", name: "AWT-42.1" }));

      const client = new ArthurClient("http://host", "k");
      const task = await client.ensureTaskForTicket("AWT-42");

      expect(task.name).toBe("AWT-42.1"); // only AWT-42 counted, not AWT-420/AWT-421
    });
  });

  describe("error handling", () => {
    it("throws on non-2xx responses", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response("nope", { status: 401 }),
      );

      const client = new ArthurClient("http://host", "k");
      await expect(client.findTicketTasks("AWT-1")).rejects.toThrow(/401/);
    });
  });

  describe("findTaskByName", () => {
    it("returns exact-name match, excluding archived", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        count: 3,
        tasks: [
          { id: "a", name: "ai-workflow-prompts" },
          { id: "b", name: "ai-workflow-prompts-old", is_archived: true },
          { id: "c", name: "ai-workflow-prompts", is_archived: true },
        ],
      }));
      const client = new ArthurClient("http://host", "k");
      const t = await client.findTaskByName("ai-workflow-prompts");
      expect(t?.id).toBe("a");
    });

    it("returns null on no match", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 0, tasks: [] }));
      const client = new ArthurClient("http://host", "k");
      expect(await client.findTaskByName("nothing")).toBeNull();
    });
  });

  describe("prompts", () => {
    it("getPromptByTag returns messages[0].content on 200", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        name: "research-plan",
        version: 3,
        messages: [{ role: "user", content: "the prompt body" }],
      }));
      const client = new ArthurClient("http://host", "k");
      const body = await client.getPromptByTag("task-uuid", "research-plan", "production");
      expect(body).toBe("the prompt body");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v1/tasks/task-uuid/prompts/research-plan/versions/tags/production");
    });

    it("getPromptByTag returns null on 404", async () => {
      mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
      const client = new ArthurClient("http://host", "k");
      expect(await client.getPromptByTag("t", "research-plan", "production")).toBeNull();
    });

    it("createPromptVersion POSTs single-message body with user role", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        name: "implement",
        version: 5,
        messages: [{ role: "user", content: "x" }],
      }));
      const client = new ArthurClient("http://host", "k");
      const result = await client.createPromptVersion("task-uuid", "implement", "x");
      expect(result.version).toBe(5);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v1/tasks/task-uuid/prompts/implement");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.messages).toEqual([{ role: "user", content: "x" }]);
    });

    it("tagPromptVersion PUTs the tag", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ name: "review", version: 2, messages: [] }));
      const client = new ArthurClient("http://host", "k");
      await client.tagPromptVersion("t", "review", 2, "production");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v1/tasks/t/prompts/review/versions/2/tags");
      expect(init.method).toBe("PUT");
      expect(JSON.parse(init.body)).toEqual({ tag: "production" });
    });

    it("getPromptByTag throws on non-404 non-2xx (5xx)", async () => {
      mockFetch.mockResolvedValueOnce(new Response("boom", { status: 500 }));
      const client = new ArthurClient("http://host", "k");
      await expect(client.getPromptByTag("t", "x", "production")).rejects.toThrow(/500/);
    });
  });

  describe("listAllTasks", () => {
    it("GETs one oversized page and dedupes by id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([
        { id: "t1", name: "AWT-1" },
        { id: "t2", name: "AWT-2" },
        { id: "t1", name: "AWT-1" },
      ]));
      const client = new ArthurClient("http://host", "secret");
      const tasks = await client.listAllTasks();

      expect(tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v2/tasks?page_size=1000");
      expect(init.method).toBe("GET");
      expect(init.headers.Authorization).toBe("Bearer secret");
    });
  });

  describe("listTraces", () => {
    it("pages from 0 (0-indexed) and accumulates until count is reached", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          count: 4,
          traces: [
            { task_id: "AWT-42", total_token_count: 100, total_token_cost: 0.5, start_time: "2026-06-01T00:00:00Z" },
            { task_id: "AWT-42", total_token_count: 200, total_token_cost: 1.0, start_time: "2026-06-01T01:00:00Z" },
          ],
        }))
        .mockResolvedValueOnce(jsonResponse({
          count: 4,
          traces: [
            { task_id: "AWT-43", total_token_count: 50, total_token_cost: null, start_time: "2026-06-02T00:00:00Z" },
            { task_id: "AWT-43", total_token_count: 70, total_token_cost: 0.3, start_time: "2026-06-02T00:00:00Z" },
          ],
        }));
      const client = new ArthurClient("http://host", "k");
      const traces = await client.listTraces(["AWT-42", "AWT-43"], "s", "e");

      expect(traces).toHaveLength(4);
      const url0 = mockFetch.mock.calls[0][0] as string;
      const url1 = mockFetch.mock.calls[1][0] as string;
      expect(url0).toContain("/api/v1/traces?");
      expect(url0).toContain("task_ids=AWT-42");
      expect(url0).toContain("task_ids=AWT-43");
      expect(url0).toContain("page=0");
      expect(url1).toContain("page=1");
    });

    it("stops on an empty page", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 99, traces: [] }));
      const client = new ArthurClient("http://host", "k");
      const traces = await client.listTraces(["AWT-42"], "s", "e");
      expect(traces).toEqual([]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("countTraces", () => {
    it("reads the count field with page_size=1 and passes filters", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ count: 7, traces: [] }));
      const client = new ArthurClient("http://host", "k");
      const n = await client.countTraces(["AWT-42"], "s", "e", {
        continuous_eval_run_status: "passed",
      });

      expect(n).toBe(7);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("page_size=1");
      expect(url).toContain("continuous_eval_run_status=passed");
      expect(init.method).toBe("GET");
    });

    it("sums counts across task-id batches", async () => {
      const ids = Array.from({ length: 60 }, (_, i) => `t${i}`); // > TASK_ID_BATCH (50) → 2 batches
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ count: 2, traces: [] }))
        .mockResolvedValueOnce(jsonResponse({ count: 3, traces: [] }));
      const client = new ArthurClient("http://host", "k");
      const n = await client.countTraces(ids, "s", "e");

      expect(n).toBe(5);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("listPromptVersions", () => {
    it("GETs the versions endpoint and sorts newest-first", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        count: 2,
        versions: [
          {
            version: 1,
            created_at: "2026-06-01T00:00:00Z",
            deleted_at: null,
            model_provider: "anthropic",
            model_name: "claude-opus-4-6",
            tags: [],
            num_messages: 1,
            num_tools: 0,
          },
          {
            version: 2,
            created_at: "2026-06-02T00:00:00Z",
            deleted_at: null,
            model_provider: "anthropic",
            model_name: "claude-opus-4-6",
            tags: ["production"],
            num_messages: 1,
            num_tools: 0,
          },
        ],
      }));
      const client = new ArthurClient("http://host", "k");
      const versions = await client.listPromptVersions("task-uuid", "research-plan");

      expect(versions.map((v) => v.version)).toEqual([2, 1]);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v1/tasks/task-uuid/prompts/research-plan/versions");
      expect(init.method).toBe("GET");
      expect(init.headers.Authorization).toBe("Bearer k");
    });

    it("returns [] on 404", async () => {
      mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
      const client = new ArthurClient("http://host", "k");
      expect(await client.listPromptVersions("t", "research-plan")).toEqual([]);
    });

    it("throws on 5xx", async () => {
      mockFetch.mockResolvedValueOnce(new Response("boom", { status: 500 }));
      const client = new ArthurClient("http://host", "k");
      await expect(client.listPromptVersions("t", "x")).rejects.toThrow(/500/);
    });
  });

  describe("getPromptVersionBody", () => {
    it("GETs the by-version endpoint and returns messages[0].content", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        name: "research-plan",
        version: 3,
        messages: [{ role: "user", content: "v3 body" }],
      }));
      const client = new ArthurClient("http://host", "k");
      const body = await client.getPromptVersionBody("task-uuid", "research-plan", 3);
      expect(body).toBe("v3 body");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v1/tasks/task-uuid/prompts/research-plan/versions/3");
      expect(init.method).toBe("GET");
    });

    it("accepts a string version specifier (latest/tag/datetime)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        name: "implement",
        messages: [{ role: "user", content: "latest body" }],
      }));
      const client = new ArthurClient("http://host", "k");
      const body = await client.getPromptVersionBody("t", "implement", "latest");
      expect(body).toBe("latest body");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v1/tasks/t/prompts/implement/versions/latest");
    });

    it("returns null on 404", async () => {
      mockFetch.mockResolvedValueOnce(new Response("not found", { status: 404 }));
      const client = new ArthurClient("http://host", "k");
      expect(await client.getPromptVersionBody("t", "x", 1)).toBeNull();
    });

    it("throws on 5xx", async () => {
      mockFetch.mockResolvedValueOnce(new Response("boom", { status: 500 }));
      const client = new ArthurClient("http://host", "k");
      await expect(client.getPromptVersionBody("t", "x", 1)).rejects.toThrow(/500/);
    });
  });
});
