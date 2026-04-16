import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraAdapter } from "./jira.js";
import { IssueTrackerNotFoundError } from "./types.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

function jiraAdapter() {
  return new JiraAdapter({
    baseUrl: "https://test.atlassian.net",
    email: "test@example.com",
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
            status: { name: "AI" },
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

      // First call: to Jira, with Authorization.
      const firstInit = mockFetch.mock.calls[0][1] as RequestInit;
      expect((firstInit.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
      expect(firstInit.redirect).toBe("manual");

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

    it("resolves relative redirect targets and keeps Authorization for same-origin refetches", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 302,
          statusText: "Found",
          headers: {
            get: (n: string) => (n.toLowerCase() === "location" ? "/secure/attachment/att-9/file.png?dl=1" : null),
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

      expect(mockFetch.mock.calls[1][0]).toBe(
        "https://test.atlassian.net/secure/attachment/att-9/file.png?dl=1",
      );
      const secondInit = mockFetch.mock.calls[1][1] as RequestInit;
      expect((secondInit.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
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
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: { get: () => null },
      });

      const adapter = jiraAdapter();
      await expect(
        adapter.downloadAttachment("https://test.atlassian.net/secure/attachment/att-1/x"),
      ).rejects.toThrow(/500/);
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
  });

  describe("postComment", () => {
    it("posts ADF-formatted comment", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      const adapter = jiraAdapter();
      await adapter.postComment("10001", "Need more details");

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.body.type).toBe("doc");
    });
  });
});
