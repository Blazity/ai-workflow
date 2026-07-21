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

  describe("validatePrompt", () => {
    it("POSTs the prompt and returns ok=true when every rule passes", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        inference_id: "inf-1",
        rule_results: [
          { id: "r1", name: "PII Leak", result: "Pass" },
          { id: "r2", name: "Prompt Injection", result: "Pass" },
        ],
      }));

      const client = new ArthurClient("http://host", "secret");
      const result = await client.validatePrompt("task-uuid", "the prompt");

      expect(result).toEqual({
        ok: true,
        findings: [
          { rule: "PII Leak", result: "Pass" },
          { rule: "Prompt Injection", result: "Pass" },
        ],
      });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://host/api/v2/tasks/task-uuid/validate_prompt");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer secret");
      expect(JSON.parse(init.body)).toEqual({ prompt: "the prompt" });
    });

    it("returns ok=false with findings when a rule fails", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        inference_id: "inf-2",
        rule_results: [
          { id: "r1", name: "PII Leak", result: "Pass" },
          { id: "r2", name: "Prompt Injection", result: "Fail", details: "injection detected" },
          { id: "r3", result: "Unavailable" },
        ],
      }));

      const client = new ArthurClient("http://host", "k");
      const result = await client.validatePrompt("t", "content");

      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        { rule: "PII Leak", result: "Pass" },
        { rule: "Prompt Injection", result: "Fail", details: "injection detected" },
        // No name → falls back to the rule id.
        { rule: "r3", result: "Unavailable" },
      ]);
    });

    it("throws when rule_results is not an array", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ inference_id: "inf-3" }));

      const client = new ArthurClient("http://host", "k");
      await expect(client.validatePrompt("t", "content")).rejects.toThrow(
        "unexpected validate_prompt response shape",
      );
    });

    it("stringifies object details and truncates them to 500 chars", async () => {
      const bigDetails = { message: "x".repeat(600) };
      mockFetch.mockResolvedValueOnce(jsonResponse({
        rule_results: [
          { id: "r1", name: "Toxicity", result: "Fail", details: bigDetails },
        ],
      }));

      const client = new ArthurClient("http://host", "k");
      const result = await client.validatePrompt("t", "content");

      const details = result.findings[0].details!;
      expect(details).toHaveLength(500);
      expect(details).toBe(JSON.stringify(bigDetails).slice(0, 500));
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
});
