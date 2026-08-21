import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraAdapter } from "./jira.js";
import { IssueTrackerNotFoundError } from "./types.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const CLOUD_ID = "test-cloud-id";
const API_BASE = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;

function jiraAdapter() {
  return new JiraAdapter({
    baseUrl: "https://test.atlassian.net",
    apiToken: "token",
    projectKey: "PROJ",
    cloudId: CLOUD_ID,
  });
}

function jiraAdapterWithDiscovery() {
  return new JiraAdapter({
    baseUrl: "https://test.atlassian.net",
    apiToken: "token",
    projectKey: "PROJ",
  });
}

describe("JiraAdapter", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("fetchTicket", () => {
    it("returns normalized ticket content", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Add login page",
            description: { content: [{ content: [{ text: "Build a login page" }] }] },
            comment: {
              comments: [
                { author: { displayName: "Alice" }, body: { content: [{ content: [{ text: "Use OAuth" }] }] }, created: "2026-03-20T10:00:00Z" },
              ],
            },
            labels: ["frontend"],
            status: { id: "10000", name: "AI" },
            attachment: [],
          },
        }),
      });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001");

      expect(ticket.id).toBe("10001");
      expect(ticket.identifier).toBe("PROJ-1");
      expect(ticket.title).toBe("Add login page");
      expect(ticket.comments).toHaveLength(1);
      expect(ticket.trackerStatus).toBe("AI");
      expect(ticket.trackerStatusId).toBe("10000");
      expect(ticket.attachments).toEqual([]);
    });
  });

  describe("fetchTicket attachments", () => {
    it("parses attachment metadata into TicketAttachment[]", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Has attachments",
            description: null,
            comment: { comments: [] },
            labels: [],
            status: { name: "AI" },
            attachment: [
              {
                id: "att-1",
                filename: "mockup.png",
                mimeType: "image/png",
                size: 348192,
                content: "https://test.atlassian.net/secure/attachment/att-1/mockup.png",
              },
              {
                id: "att-2",
                filename: "spec.pdf",
                mimeType: "application/pdf",
                size: 52100,
                content: "https://test.atlassian.net/secure/attachment/att-2/spec.pdf",
              },
            ],
          },
        }),
      });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001");

      expect(ticket.attachments).toHaveLength(2);
      expect(ticket.attachments[0]).toEqual({
        id: "att-1",
        filename: "mockup.png",
        mimeType: "image/png",
        size: 348192,
        contentUrl: "https://test.atlassian.net/secure/attachment/att-1/mockup.png",
      });
    });

    it("sanitizes malformed attachment sizes", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Has malformed sizes",
            description: null,
            comment: { comments: [] },
            labels: [],
            status: { name: "AI" },
            attachment: [
              { id: "att-1", size: "64", content: "https://test.atlassian.net/1" },
              { id: "att-2", size: "bad", content: "https://test.atlassian.net/2" },
              { id: "att-3", size: -10, content: "https://test.atlassian.net/3" },
              { id: "att-4", size: Number.POSITIVE_INFINITY, content: "https://test.atlassian.net/4" },
              { id: "att-5", size: 7.9, content: "https://test.atlassian.net/5" },
            ],
          },
        }),
      });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001");

      expect(ticket.attachments.map((a) => a.size)).toEqual([64, 0, 0, 0, 7]);
    });

    it("omits contentUrl when Jira does not provide attachment content", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Has partial attachment metadata",
            description: null,
            comment: { comments: [] },
            labels: [],
            status: { name: "AI" },
            attachment: [
              {
                id: "att-1",
                filename: "spec.pdf",
                mimeType: "application/pdf",
                size: 52100,
              },
            ],
          },
        }),
      });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001");

      expect(ticket.attachments).toHaveLength(1);
      expect(ticket.attachments[0].contentUrl).toBeUndefined();
    });

    it("returns empty attachments array when field is absent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10002",
          key: "PROJ-2",
          fields: {
            summary: "No attachments",
            description: null,
            comment: { comments: [] },
            labels: [],
            status: { name: "AI" },
            // attachment field intentionally omitted
          },
        }),
      });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10002");
      expect(ticket.attachments).toEqual([]);
    });

    it("requests attachment field in the fields query", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10003",
          key: "PROJ-3",
          fields: {
            summary: "x",
            description: null,
            comment: { comments: [] },
            labels: [],
            status: { name: "AI" },
            attachment: [],
          },
        }),
      });

      const adapter = jiraAdapter();
      await adapter.fetchTicket("10003");
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("fields=");
      expect(url).toContain("attachment");
    });
  });

  describe("downloadAttachment", () => {
    it("follows one 302 redirect without Authorization header and drains the first body", async () => {
      const redirectUrl = "https://atlassian-cdn.example/signed?x=1";
      const cancelFn = vi.fn();
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          statusText: "Found",
          headers: { get: (n: string) => (n.toLowerCase() === "location" ? redirectUrl : null) },
          body: { cancel: cancelFn },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer,
        });

      const adapter = jiraAdapter();
      const buf = await adapter.downloadAttachment(
        "https://test.atlassian.net/secure/attachment/att-1/mockup.png",
      );

      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(4);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // First call: to Atlassian API gateway, with Bearer Authorization.
      const firstInit = mockFetch.mock.calls[0][1] as RequestInit;
      expect((firstInit.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
      expect(firstInit.redirect).toBe("manual");
      expect(mockFetch.mock.calls[0][0]).toBe(
        `${API_BASE}/secure/attachment/att-1/mockup.png`,
      );

      // First response body drained to release the socket back to the pool.
      expect(cancelFn).toHaveBeenCalledOnce();

      // Second call: to the CDN, WITHOUT Authorization.
      const secondInit = mockFetch.mock.calls[1][1] as RequestInit;
      const secondHeaders = (secondInit.headers ?? {}) as Record<string, string>;
      expect(secondHeaders.Authorization).toBeUndefined();
      expect(mockFetch.mock.calls[1][0]).toBe(redirectUrl);
    });

    it("does not send Authorization when the initial URL is cross-origin", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      });

      const adapter = jiraAdapter();
      await adapter.downloadAttachment("https://atlassian-cdn.example/signed?x=1");

      const firstInit = mockFetch.mock.calls[0][1] as RequestInit;
      const firstHeaders = (firstInit.headers ?? {}) as Record<string, string>;
      expect(firstHeaders.Authorization).toBeUndefined();
    });

    it("rewrites tenant-origin redirect targets onto the Atlassian gateway and keeps Authorization", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          statusText: "Found",
          headers: {
            get: (n: string) =>
              n.toLowerCase() === "location"
                ? "https://test.atlassian.net/secure/attachment/att-9/file.png?dl=1"
                : null,
          },
          body: { cancel: vi.fn() },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => new Uint8Array([9]).buffer,
        });

      const adapter = jiraAdapter();
      await adapter.downloadAttachment("https://test.atlassian.net/secure/attachment/att-9/file.png");

      expect(mockFetch.mock.calls[0][0]).toBe(
        `${API_BASE}/secure/attachment/att-9/file.png`,
      );
      expect(mockFetch.mock.calls[1][0]).toBe(
        `${API_BASE}/secure/attachment/att-9/file.png?dl=1`,
      );
      const secondInit = mockFetch.mock.calls[1][1] as RequestInit;
      expect((secondInit.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
    });

    it("also follows one 303 redirect", async () => {
      const redirectUrl = "https://atlassian-cdn.example/signed-303?x=1";
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 303,
          statusText: "See Other",
          headers: { get: (n: string) => (n.toLowerCase() === "location" ? redirectUrl : null) },
          body: { cancel: vi.fn() },
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        });

      const adapter = jiraAdapter();
      const buf = await adapter.downloadAttachment(
        "https://test.atlassian.net/secure/attachment/att-303/file.png",
      );

      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(4);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toBe(redirectUrl);
      const secondInit = mockFetch.mock.calls[1][1] as RequestInit;
      const secondHeaders = (secondInit.headers ?? {}) as Record<string, string>;
      expect(secondHeaders.Authorization).toBeUndefined();
    });

    it("drains body and throws when redirect is missing Location", async () => {
      const cancelFn = vi.fn();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 302,
        statusText: "Found",
        headers: { get: () => null },
        body: { cancel: cancelFn },
      });

      const adapter = jiraAdapter();
      await expect(
        adapter.downloadAttachment("https://test.atlassian.net/secure/attachment/att-1/missing"),
      ).rejects.toThrow(/missing Location header/i);
      expect(cancelFn).toHaveBeenCalledOnce();
    });

    it("returns bytes directly on 200 (no redirect)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });

      const adapter = jiraAdapter();
      const buf = await adapter.downloadAttachment(
        "https://test.atlassian.net/secure/attachment/att-1/data.bin",
      );
      expect(Array.from(buf)).toEqual([1, 2, 3]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws on non-2xx, non-redirect responses", async () => {
      const cancelFn = vi.fn();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: { get: () => null },
        body: { cancel: cancelFn },
      });

      const adapter = jiraAdapter();
      await expect(
        adapter.downloadAttachment("https://test.atlassian.net/secure/attachment/att-1/x"),
      ).rejects.toThrow(/500/);
      expect(cancelFn).toHaveBeenCalledOnce();
    });

    it("throws IssueTrackerNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const adapter = jiraAdapter();
      await expect(adapter.fetchTicket("10001")).rejects.toBeInstanceOf(
        IssueTrackerNotFoundError,
      );
    });
  });

  describe("searchTickets", () => {
    it("returns ticket keys matching JQL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issues: [{ key: "PROJ-1" }, { key: "PROJ-2" }],
        }),
      });

      const adapter = jiraAdapter();
      const keys = await adapter.searchTickets('project = PROJ AND status = "AI"');
      expect(keys).toEqual(["PROJ-1", "PROJ-2"]);
    });
  });

  describe("searchTicketSummaries", () => {
    it("bounds Jira search latency with a timeout signal", async () => {
      const controller = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(controller.signal);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: [] }),
      });

      try {
        await jiraAdapter().searchTicketSummaries("project = PROJ", 5);

        expect(timeout).toHaveBeenCalledWith(5000);
        expect(mockFetch.mock.calls[0][1].signal).toBe(controller.signal);
      } finally {
        timeout.mockRestore();
      }
    });

    it("normalizes every evidence field for matching tickets", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issues: [
            {
              key: "PROJ-1",
              fields: {
                summary: "Login fails on Safari",
                status: { name: "In Progress" },
                description: {
                  content: [
                    { content: [{ text: "Safari 17 rejects the session cookie." }] },
                  ],
                },
                reporter: { displayName: "Ada Lovelace" },
                project: { key: "PROJ" },
                updated: "2026-08-10T09:15:00.000+0200",
              },
            },
            {
              key: "PROJ-2",
              fields: { summary: "Login page crashes", status: { name: "Done" } },
            },
          ],
        }),
      });

      const adapter = jiraAdapter();
      const results = await adapter.searchTicketSummaries(
        'project = PROJ AND text ~ "login"',
        10,
      );

      expect(results).toEqual([
        {
          key: "PROJ-1",
          summary: "Login fails on Safari",
          status: "In Progress",
          url: "https://test.atlassian.net/browse/PROJ-1",
          excerpt: "Safari 17 rejects the session cookie.",
          reporter: "Ada Lovelace",
          project: "PROJ",
          updatedAt: "2026-08-10T09:15:00.000+0200",
        },
        // Fields the provider omitted come back as empty strings, never
        // undefined, so consumers never branch on absence.
        {
          key: "PROJ-2",
          summary: "Login page crashes",
          status: "Done",
          url: "https://test.atlassian.net/browse/PROJ-2",
          excerpt: "",
          reporter: "",
          project: "",
          updatedAt: "",
        },
      ]);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(`${API_BASE}/rest/api/3/search/jql?`);
      expect(url).toContain(
        "fields=key,summary,status,description,reporter,project,updated",
      );
      expect(url).toContain("maxResults=10");
    });

    it("truncates a long description instead of shipping the whole body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issues: [
            {
              key: "PROJ-1",
              fields: {
                summary: "Noisy ticket",
                description: { text: `${"x".repeat(600)}\n\nmore` },
              },
            },
          ],
        }),
      });

      const adapter = jiraAdapter();
      const [hit] = await adapter.searchTicketSummaries("project = PROJ", 1);

      expect(hit!.excerpt).toHaveLength(501);
      expect(hit!.excerpt.endsWith("…")).toBe(true);
    });

    it("returns an empty array when no issues match", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: [] }),
      });

      const adapter = jiraAdapter();
      await expect(adapter.searchTicketSummaries("project = PROJ", 5)).resolves.toEqual([]);
    });

    it("throws when the Jira API fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const adapter = jiraAdapter();
      await expect(
        adapter.searchTicketSummaries("project = PROJ", 5),
      ).rejects.toThrow(/500/);
    });
  });

  describe("listStatuses", () => {
    it("flattens and deduplicates statuses configured for the Jira project", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: "10001",
            name: "Task",
            statuses: [
              { id: "1", name: "To Do" },
              { id: 2, name: "In Progress" },
            ],
          },
          {
            id: "10002",
            name: "Bug",
            statuses: [
              { id: "1", name: "To Do" },
              { id: "3", name: "Done" },
            ],
          },
        ],
      });

      await expect(jiraAdapter().listStatuses()).resolves.toEqual([
        { id: "1", name: "To Do" },
        { id: "2", name: "In Progress" },
        { id: "3", name: "Done" },
      ]);
      expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/rest/api/3/project/PROJ/statuses`);
      expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it("times out cloud-id discovery and retries with a clean cache", async () => {
      const controller = new AbortController();
      const retryController = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValueOnce(controller.signal)
        .mockReturnValue(retryController.signal);
      mockFetch.mockImplementationOnce((_url, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          } else {
            queueMicrotask(() => reject(new Error("cloud-id discovery fetch was not abortable")));
          }
        }),
      );
      const adapter = jiraAdapterWithDiscovery();

      try {
        const firstAttempt = adapter.listStatuses().catch((error) => error);
        await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
        controller.abort(new DOMException("timed out", "TimeoutError"));
        await expect(firstAttempt).resolves.toMatchObject({ name: "TimeoutError" });

        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ cloudId: CLOUD_ID }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => [],
          });

        await expect(adapter.listStatuses()).resolves.toEqual([]);
        expect(mockFetch.mock.calls[1][0]).toBe("https://test.atlassian.net/_edge/tenant_info");
      } finally {
        timeout.mockRestore();
      }
    });
  });

  describe("moveTicket", () => {
    it("fetches transitions then posts the matching one", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            transitions: [
              { id: "31", name: "AI Review" },
              { id: "41", name: "Backlog" },
            ],
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const adapter = jiraAdapter();
      await adapter.moveTicket("10001", "AI Review");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const transitionCall = mockFetch.mock.calls[1];
      expect(JSON.parse(transitionCall[1].body)).toEqual({
        transition: { id: "31" },
      });
    });

    it("uses a configured transition id when Jira localizes names", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            transitions: [
              {
                id: "11",
                name: "待办",
                to: { statusCategory: { key: "new" } },
              },
              {
                id: "21",
                name: "正在进行",
                to: { statusCategory: { key: "indeterminate" } },
              },
            ],
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const adapter = jiraAdapter();
      await adapter.moveTicket("10001", {
        name: "To Do",
        transitionId: "11",
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const transitionCall = mockFetch.mock.calls[1];
      expect(JSON.parse(transitionCall[1].body)).toEqual({
        transition: { id: "11" },
      });
    });

    it("resolves a provider status id against the currently valid transitions", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            transitions: [
              { id: "31", name: "Finish", to: { id: "10042", name: "Done" } },
            ],
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await jiraAdapter().moveTicket("10001", { name: "10042", statusId: "10042" });

      expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
        transition: { id: "31" },
      });
    });

    it("falls back to an exact destination name when a custom value is not a status id", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            transitions: [{ id: "31", name: "Code Review", to: { id: "10042" } }],
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await jiraAdapter().moveTicket("10001", {
        name: "Code Review",
        statusId: "Code Review",
      });

      expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
        transition: { id: "31" },
      });
    });
  });

  describe("resolveMoveTargetStatus", () => {
    it("resolves a transition name to the localized status it lands in", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transitions: [
            { id: "3", name: "REVIEW", to: { id: "11418", name: "Weryfikacja" } },
            { id: "4", name: "DONE", to: { id: "10002", name: "Gotowe" } },
          ],
        }),
      });

      await expect(
        jiraAdapter().resolveMoveTargetStatus("PROJ-1", "REVIEW"),
      ).resolves.toEqual({ id: "11418", name: "Weryfikacja" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns null when the target does not resolve from the current status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transitions: [{ id: "4", name: "DONE", to: { id: "10002", name: "Gotowe" } }],
        }),
      });

      await expect(
        jiraAdapter().resolveMoveTargetStatus("PROJ-1", "REVIEW"),
      ).resolves.toBeNull();
    });

    it("returns null for a matched transition that exposes no destination status", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ transitions: [{ id: "3", name: "REVIEW" }] }),
      });

      await expect(
        jiraAdapter().resolveMoveTargetStatus("PROJ-1", "REVIEW"),
      ).resolves.toBeNull();
    });
  });

  describe("postComment", () => {
    it("posts ADF-formatted comment and returns a deep link to the new comment", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "98765" }),
      });

      const adapter = jiraAdapter();
      const url = await adapter.postComment("PROJ-1", "Need more details");

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.body.type).toBe("doc");
      expect(url).toBe(
        "https://test.atlassian.net/browse/PROJ-1?focusedCommentId=98765",
      );
    });

    it("returns null when Jira's response omits a comment id", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const adapter = jiraAdapter();
      const url = await adapter.postComment("PROJ-1", "x");
      expect(url).toBeNull();
    });

    it("splits multi-line comments into separate paragraphs (no \\n inside text nodes)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "1" }),
      });

      const adapter = jiraAdapter();
      await adapter.postComment("10001", "1. First question\n2. Second question");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.body.content).toEqual([
        { type: "paragraph", content: [{ type: "text", text: "1. First question" }] },
        { type: "paragraph", content: [{ type: "text", text: "2. Second question" }] },
      ]);
      const collectText = (n: any): string =>
        n?.text ?? (n?.content?.map(collectText).join("") ?? "");
      expect(collectText(body.body)).not.toContain("\n");
    });

    it("normalizes CRLF line endings into separate paragraphs", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "1" }),
      });

      const adapter = jiraAdapter();
      await adapter.postComment("10001", "1. First question\r\n2. Second question");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.body.content).toEqual([
        { type: "paragraph", content: [{ type: "text", text: "1. First question" }] },
        { type: "paragraph", content: [{ type: "text", text: "2. Second question" }] },
      ]);
      const collectText = (n: any): string =>
        n?.text ?? (n?.content?.map(collectText).join("") ?? "");
      expect(collectText(body.body)).not.toContain("\r");
      expect(collectText(body.body)).not.toContain("\n");
    });
  });

  describe("findCommentByMarker", () => {
    it("scans paginated comments and returns the matching deep link", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            startAt: 0,
            maxResults: 1,
            total: 2,
            comments: [{ id: "1", body: { content: [{ content: [{ text: "unrelated" }] }] } }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            startAt: 1,
            maxResults: 1,
            total: 2,
            comments: [{
              id: "2",
              body: { content: [{ content: [{ text: "Arthur report: run-1:research" }] }] },
            }],
          }),
        });

      await expect(
        jiraAdapter().findCommentByMarker("PROJ-1", "Arthur report: run-1:research"),
      ).resolves.toBe(
        "https://test.atlassian.net/browse/PROJ-1?focusedCommentId=2",
      );
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1]![0]).toBe(
        `${API_BASE}/rest/api/3/issue/PROJ-1/comment?startAt=1&maxResults=100`,
      );
    });

    it("matches the marker as a complete line", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          startAt: 0,
          maxResults: 100,
          total: 1,
          comments: [{
            id: "1",
            body: { content: [{ content: [{ text: "prefix Arthur report: run-1:research suffix" }] }] },
          }],
        }),
      });

      await expect(
        jiraAdapter().findCommentByMarker("PROJ-1", "Arthur report: run-1:research"),
      ).resolves.toBeNull();
    });
  });

  describe("createTicket", () => {
    it("creates in the configured project with an ADF description and returns a browse url", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "10099", key: "PROJ-9" }),
      });

      const adapter = jiraAdapter();
      const created = await adapter.createTicket({
        summary: "Fix the login redirect",
        description: "First line\nSecond line",
        labels: ["mcp-abc123"],
      });

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe(`${API_BASE}/rest/api/3/issue`);
      expect(call[1].method).toBe("POST");
      const body = JSON.parse(call[1].body);
      expect(body.fields.project).toEqual({ key: "PROJ" });
      // The default issue type, because a caller that does not care must not have to
      // know the project's type names to file anything at all.
      expect(body.fields.issuetype).toEqual({ name: "Task" });
      expect(body.fields.labels).toEqual(["mcp-abc123"]);
      expect(body.fields.description.content).toEqual([
        { type: "paragraph", content: [{ type: "text", text: "First line" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
      ]);
      expect(created).toEqual({
        identifier: "PROJ-9",
        url: "https://test.atlassian.net/browse/PROJ-9",
      });
    });

    it("omits description and labels rather than sending empty ones", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ key: "PROJ-10" }),
      });

      const adapter = jiraAdapter();
      await adapter.createTicket({ summary: "Bare ticket", issueType: "Bug" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Jira rejects a null description outright, and an empty labels array would clear
      // labels on a ticket type that inherits them from a template.
      expect(body.fields).not.toHaveProperty("description");
      expect(body.fields).not.toHaveProperty("labels");
      expect(body.fields.issuetype).toEqual({ name: "Bug" });
    });

    it("throws when the response carries no issue key", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "10099" }) });

      const adapter = jiraAdapter();
      // The ticket may well exist; what is missing is the key, so this must not be
      // reported to a caller as "nothing was created".
      await expect(adapter.createTicket({ summary: "x" })).rejects.toThrow(
        /no issue key/,
      );
    });
  });
});
