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
});
