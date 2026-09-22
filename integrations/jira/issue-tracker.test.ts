import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraAdapter } from "./issue-tracker";
import { IssueTrackerNotFoundError } from "@integrations/sdk";

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
    // Round 5, A2. Everything downstream that reads a person's words tells what
    // they wrote from what they quoted by the "> " marker, and the flattener
    // used to drop it: a person clicking Jira's quote button on our comment
    // saying a repository was NOT taken, and writing "yes, add it" underneath,
    // handed the reader our own refusal as their own words and was refused for
    // agreeing.
    it("keeps the quote marker on a blockquote a person quoted our comment with", async () => {
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
                {
                  author: { displayName: "Ada", accountId: "acc-ada" },
                  body: {
                    content: [
                      {
                        type: "blockquote",
                        content: [
                          {
                            type: "paragraph",
                            content: [
                              {
                                text: "github:acme/billing is not selected on this work, so the run started without it.",
                              },
                            ],
                          },
                        ],
                      },
                      { type: "paragraph", content: [{ text: "yes, add it" }] },
                    ],
                  },
                  created: "2026-03-20T10:00:00Z",
                },
              ],
              total: 1,
            },
            labels: [],
            status: { id: "10000", name: "AI" },
            attachment: [],
          },
        }),
      });

      const ticket = await jiraAdapter().fetchTicket("10001");

      expect(ticket.comments[0]?.body).toBe(
        "> github:acme/billing is not selected on this work, so the run started without it.\nyes, add it",
      );
    });

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
                { author: { displayName: "Alice", accountId: "acc-alice", accountType: "atlassian" }, body: { content: [{ content: [{ text: "Use OAuth" }] }] }, created: "2026-03-20T10:00:00Z" },
                { author: { displayName: "Automation for Jira", accountId: "acc-bot", accountType: "app" }, body: { content: [{ content: [{ text: "Moved by a rule" }] }] }, created: "2026-03-20T10:05:00Z" },
                { author: { displayName: "Legacy" }, body: { content: [{ content: [{ text: "From before we asked" }] }] }, created: "2026-03-20T10:06:00Z" },
              ],
              total: 3,
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
      expect(ticket.comments).toHaveLength(3);
      // The account type comes through as Jira reports it, because the readers
      // above cannot tell an automation rule from a person without it. Absent
      // stays absent: an author Jira says nothing about is a person, and only
      // the field itself may say otherwise.
      expect(ticket.comments.map((c) => c.accountType)).toEqual([
        "atlassian",
        "app",
        undefined,
      ]);
      expect(ticket.trackerStatus).toBe("AI");
      expect(ticket.trackerStatusId).toBe("10000");
      expect(ticket.attachments).toEqual([]);
      // Jira said it had three and handed over three, so this list is the list.
      expect(ticket.commentsComplete).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("reads a busy ticket with one request when no comment window is asked for", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Busy ticket",
            description: null,
            comment: {
              comments: [
                { author: { displayName: "Alice", accountId: "acc-alice" }, body: { content: [{ content: [{ text: "first" }] }] }, created: "2026-03-20T10:00:00Z" },
              ],
              total: 57,
            },
            labels: [],
            status: { name: "AI" },
            attachment: [],
          },
        }),
      });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001");

      // This is every ticket read in the deployment except the two that resume
      // a clarification: the poll tick, the dispatch, the reconciler, the
      // overview. Chasing the rest of a busy ticket's comments here would put
      // up to twenty extra provider calls behind each of them, and a rate limit
      // reached that way stops every run.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(ticket.comments).toHaveLength(1);
      // And it claims nothing it did not read.
      expect(ticket.commentsComplete).toBe(false);
      expect(ticket.commentsCompleteFrom).toBeUndefined();
    });

    it("reads the comments the issue response left behind on later pages", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "10001",
            key: "PROJ-1",
            fields: {
              summary: "Busy ticket",
              description: null,
              comment: {
                comments: [
                  { author: { displayName: "Alice", accountId: "acc-alice" }, body: { content: [{ content: [{ text: "first" }] }] }, created: "2026-03-20T10:00:00Z" },
                ],
                total: 2,
              },
              labels: [],
              status: { name: "AI" },
              attachment: [],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            total: 2,
            comments: [
              { author: { displayName: "Alice", accountId: "acc-alice" }, body: { content: [{ content: [{ text: "first" }] }] }, created: "2026-03-20T10:00:00Z" },
              { author: { displayName: "Bob", accountId: "acc-bob" }, body: { content: [{ content: [{ text: "second" }] }] }, created: "2026-03-20T11:00:00Z" },
            ],
          }),
        });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001", {
        commentsSince: "2026-03-20T09:00:00Z",
      });

      // The answer nobody could see: the issue response carries one page of
      // comments and says there are more, and the reader that decides whether a
      // person answered would have been handed the page.
      expect(ticket.comments.map((c) => c.body)).toEqual(["first", "second"]);
      expect(ticket.commentsComplete).toBe(true);
      // The order is asked for rather than assumed: which end of the list a
      // page is cut from is the whole basis of the window below.
      expect(mockFetch.mock.calls[1]?.[0]).toBe(
        `${API_BASE}/rest/api/3/issue/10001/comment?startAt=0&maxResults=100&orderBy=created`,
      );
    });

    it("stops at a bound on a ticket longer than one read may page through, and says the list is incomplete", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Busy ticket",
            description: null,
            comment: { comments: [], total: 999999 },
            labels: [],
            status: { name: "AI" },
            attachment: [],
          },
        }),
      });
      // Full pages, and a ticket that keeps growing while we read it, so the
      // end never arrives. The bound is what stops this being an unbounded
      // loop; saying the list is incomplete is what stops the readers treating
      // what came back as the whole ticket.
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          total: 1000000,
          comments: Array.from({ length: 100 }, (_, i) => ({
            author: { displayName: "Alice", accountId: "acc-alice" },
            body: { content: [{ content: [{ text: `page comment ${i}` }] }] },
            created: "2026-03-20T10:00:00Z",
          })),
        }),
      });

      const adapter = jiraAdapter();
      // A window older than every comment on it, so the walk never reaches back
      // past the question and the bound is the only thing that stops it.
      const ticket = await adapter.fetchTicket("10001", {
        commentsSince: "2026-03-01T00:00:00Z",
      });

      expect(ticket.commentsComplete).toBe(false);
      // The provider said there were more comments past where this read
      // started, so the newest of all may be one of them.
      expect(ticket.commentsCompleteFrom).toBeUndefined();
      // One issue read plus the bounded number of comment pages, and not one
      // request more.
      expect(mockFetch).toHaveBeenCalledTimes(21);
      // The first page read is the LAST one on the ticket, and the walk steps
      // backwards from there: the window every reader cares about opens at a
      // question asked recently, and Jira hands comments over oldest first.
      expect(mockFetch.mock.calls[1]?.[0]).toBe(
        `${API_BASE}/rest/api/3/issue/10001/comment?startAt=999899&maxResults=100&orderBy=created`,
      );
    });

    it("reads a ticket longer than one read may page through from its newest end, and says from when the list is whole", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Very busy ticket",
            description: null,
            comment: { comments: [], total: 2100 },
            labels: [],
            status: { name: "AI" },
            attachment: [],
          },
        }),
      });
      // A ticket with a hundred more comments than one read may page through.
      // The read skips the oldest hundred and runs to the end, so the list is
      // not the whole ticket and IS the whole of everything written since the
      // hundredth comment.
      mockFetch.mockImplementation(async (url: string) => {
        // The page the walk actually asked for, so the test cannot agree with
        // itself about which end of the ticket is being read.
        const start = Number(new URL(url).searchParams.get("startAt"));
        return {
          ok: true,
          json: async () => ({
            total: 2100,
            comments: Array.from({ length: 100 }, (_, i) => ({
              author: { displayName: "Alice", accountId: "acc-alice" },
              body: { content: [{ content: [{ text: `comment ${start + i}` }] }] },
              created: new Date(
                Date.UTC(2026, 2, 20) + (start + i) * 60_000,
              ).toISOString(),
            })),
          }),
        };
      });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001", {
        // Inside the newest page, so one page answers the question.
        commentsSince: new Date(Date.UTC(2026, 2, 20) + 2050 * 60_000).toISOString(),
      });

      // One page, not twenty: the walk stops the moment it reaches back past
      // the instant asked about, which is what keeps a ticket this long from
      // costing twenty requests every time somebody answers on it.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(ticket.comments).toHaveLength(100);
      // Not the whole ticket, and honest about it.
      expect(ticket.commentsComplete).toBe(false);
      // The fact that saves the comment channel on a ticket this long: whatever
      // is missing was written before this instant, so a reader whose question
      // was asked after it holds every comment that could answer it.
      expect(ticket.commentsCompleteFrom).toBe(
        new Date(Date.UTC(2026, 2, 20) + 2000 * 60_000).toISOString(),
      );
      expect(ticket.comments[0]?.body).toBe("comment 2000");
    });

    it("reports the comment list as incomplete when the tracker hands over fewer comments than it says it has", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "10001",
            key: "PROJ-1",
            fields: {
              summary: "Busy ticket",
              description: null,
              comment: {
                comments: [
                  { author: { displayName: "Alice", accountId: "acc-alice" }, body: { content: [{ content: [{ text: "first" }] }] }, created: "2026-03-20T10:00:00Z" },
                ],
                total: 5,
              },
              labels: [],
              status: { name: "AI" },
              attachment: [],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            total: 5,
            comments: [
              { author: { displayName: "Alice", accountId: "acc-alice" }, body: { content: [{ content: [{ text: "first" }] }] }, created: "2026-03-20T10:00:00Z" },
              { author: { displayName: "Bob", accountId: "acc-bob" }, body: { content: [{ content: [{ text: "second" }] }] }, created: "2026-03-20T11:00:00Z" },
            ],
          }),
        });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001", {
        commentsSince: "2026-03-20T09:00:00Z",
      });

      // Five, it says, and two is what it gave. Three comments are unaccounted
      // for, and one of them may be the answer somebody is waiting to be read.
      expect(ticket.comments).toHaveLength(2);
      expect(ticket.commentsComplete).toBe(false);
      // It contradicted itself, so nothing it said places the missing three:
      // claiming a window here would be claiming coverage we cannot prove.
      expect(ticket.commentsCompleteFrom).toBeUndefined();
    });

    it("proves the comment list whole from a short page when the tracker never says how many there are", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "10001",
            key: "PROJ-1",
            fields: {
              summary: "Quiet ticket",
              description: null,
              comment: {
                comments: [
                  { author: { displayName: "Alice", accountId: "acc-alice" }, body: { content: [{ content: [{ text: "only one" }] }] }, created: "2026-03-20T10:00:00Z" },
                ],
              },
              labels: [],
              status: { name: "AI" },
              attachment: [],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            comments: [
              { author: { displayName: "Alice", accountId: "acc-alice" }, body: { content: [{ content: [{ text: "only one" }] }] }, created: "2026-03-20T10:00:00Z" },
            ],
          }),
        });

      const adapter = jiraAdapter();
      const ticket = await adapter.fetchTicket("10001", {
        commentsSince: "2026-03-20T09:00:00Z",
      });

      // A page with room left on it is the end of the list, which is how a
      // tracker that reports no count at all still gets its comments read
      // rather than treated as a truncated page for ever.
      expect(ticket.comments.map((c) => c.body)).toEqual(["only one"]);
      expect(ticket.commentsComplete).toBe(true);
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
            comment: { comments: [], total: 0 },
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
            comment: { comments: [], total: 0 },
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
            comment: { comments: [], total: 0 },
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
            comment: { comments: [], total: 0 },
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
            comment: { comments: [], total: 0 },
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

  describe("ticketsInStatus", () => {
    it("returns the keys in one status of the configured project", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issues: [{ key: "PROJ-1" }, { key: "PROJ-2" }],
        }),
      });

      const adapter = jiraAdapter();
      const keys = await adapter.ticketsInStatus("AI");
      expect(keys).toEqual(["PROJ-1", "PROJ-2"]);
    });

    it("scopes the query to the connection's project and orders it oldest first", async () => {
      // The caller passes a column name and nothing else. The project comes
      // from this connection, so no caller can widen the search past it, and
      // the order is part of the port's contract: without it the capped page
      // rotates between polls and the same ticket gets a second "waiting for
      // capacity" comment.
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ issues: [] }) });

      await jiraAdapter().ticketsInStatus("In Progress");

      const url = decodeURIComponent(String(mockFetch.mock.calls.at(-1)?.[0]));
      expect(url).toContain('project = "PROJ"');
      expect(url).toContain('status = "In Progress"');
      expect(url).toContain("ORDER BY created ASC");
    });

    it("never lets a column name break out of its quoted literal", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ issues: [] }) });

      await jiraAdapter().ticketsInStatus('Done" OR project = "OTHER');

      const url = decodeURIComponent(String(mockFetch.mock.calls.at(-1)?.[0]));
      expect(url).not.toContain('project = "OTHER"');
    });
  });

  describe("findTickets", () => {
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
        await jiraAdapter().findTickets({ keywords: [], limit: 5 });

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
      const results = await adapter.findTickets({ keywords: ["login"], limit: 10 });

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
      const [hit] = await adapter.findTickets({ keywords: [], limit: 1 });

      expect(hit!.excerpt).toHaveLength(501);
      expect(hit!.excerpt.endsWith("…")).toBe(true);
    });

    it("returns an empty array when no issues match", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: [] }),
      });

      const adapter = jiraAdapter();
      await expect(adapter.findTickets({ keywords: [], limit: 5 })).resolves.toEqual([]);
    });

    it("throws when the Jira API fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const adapter = jiraAdapter();
      await expect(
        adapter.findTickets({ keywords: [], limit: 5 }),
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
