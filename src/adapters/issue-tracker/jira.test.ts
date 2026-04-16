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
