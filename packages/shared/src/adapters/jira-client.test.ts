import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraClient } from "./jira-client.js";

describe("JiraClient", () => {
  const baseUrl = "https://team.atlassian.net";
  const email = "bot@team.com";
  const apiToken = "test-token";
  let client: JiraClient;

  beforeEach(() => {
    client = new JiraClient(baseUrl, email, apiToken);
    vi.restoreAllMocks();
  });

  describe("fetchTicket", () => {
    it("fetches ticket and maps to Ticket interface", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            key: "PROJ-42",
            fields: {
              summary: "Add dark mode",
              description: "Implement dark mode across all pages",
              comment: {
                comments: [
                  {
                    author: { displayName: "Alice" },
                    body: "Use CSS variables",
                    created: "2026-03-10T10:00:00.000+0000",
                  },
                ],
              },
              labels: ["frontend", "ui"],
            },
          }),
          { status: 200 },
        ),
      );

      const ticket = await client.fetchTicket("PROJ-42");

      expect(ticket.externalId).toBe("PROJ-42");
      expect(ticket.identifier).toBe("PROJ-42");
      expect(ticket.title).toBe("Add dark mode");
      expect(ticket.description).toBe("Implement dark mode across all pages");
      expect(ticket.labels).toEqual(["frontend", "ui"]);
      expect(ticket.comments).toHaveLength(1);
      expect(ticket.comments[0]!.author).toBe("Alice");
    });

    it("handles Atlassian Document Format description", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            key: "PROJ-42",
            fields: {
              summary: "Title",
              description: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "ADF description" }],
                  },
                ],
              },
              comment: { comments: [] },
              labels: [],
            },
          }),
          { status: 200 },
        ),
      );

      const ticket = await client.fetchTicket("PROJ-42");
      expect(ticket.description).toBe("ADF description");
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Not Found", { status: 404 }),
      );

      await expect(client.fetchTicket("PROJ-999")).rejects.toThrow(
        "Jira API error: 404",
      );
    });
  });

  describe("postComment", () => {
    it("posts an ADF-formatted comment", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ id: "123" }), { status: 201 }),
        );

      await client.postComment("PROJ-42", "Need clarification on X");

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://team.atlassian.net/rest/api/3/issue/PROJ-42/comment",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Authorization: expect.stringContaining("Basic "),
          }),
          body: JSON.stringify({
            body: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Need clarification on X" }],
                },
              ],
            },
          }),
        }),
      );
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Not Found", { status: 404 }),
      );

      await expect(client.postComment("PROJ-999", "text")).rejects.toThrow(
        "Jira API error: 404",
      );
    });
  });

  describe("moveTicket", () => {
    it("fetches transitions then posts the matching one", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              transitions: [
                { id: "11", name: "Backlog" },
                { id: "21", name: "AI Review" },
              ],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.moveTicket("PROJ-42", "AI Review");

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        "https://team.atlassian.net/rest/api/3/issue/PROJ-42/transitions",
        expect.objectContaining({ method: "GET" }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        "https://team.atlassian.net/rest/api/3/issue/PROJ-42/transitions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ transition: { id: "21" } }),
        }),
      );
    });

    it("throws when no matching transition found", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transitions: [{ id: "11", name: "Done" }],
          }),
          { status: 200 },
        ),
      );

      await expect(client.moveTicket("PROJ-42", "AI Review")).rejects.toThrow(
        "No transition found matching 'AI Review'",
      );
    });
  });

  describe("searchTickets", () => {
    it("sends JQL query and returns ticket keys", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            issues: [{ key: "PROJ-1" }, { key: "PROJ-5" }, { key: "PROJ-12" }],
          }),
          { status: 200 },
        ),
      );

      const keys = await client.searchTickets(
        'status = "AI" AND project = PROJ',
      );

      expect(keys).toEqual(["PROJ-1", "PROJ-5", "PROJ-12"]);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://team.atlassian.net/rest/api/3/search/jql",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("Basic "),
          }),
          body: JSON.stringify({
            jql: 'status = "AI" AND project = PROJ',
            fields: ["key"],
            maxResults: 50,
          }),
        }),
      );
    });

    it("returns empty array when no issues match", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ issues: [] }), { status: 200 }),
      );

      const keys = await client.searchTickets(
        'status = "AI" AND project = PROJ',
      );
      expect(keys).toEqual([]);
    });

    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Bad Request", { status: 400 }),
      );

      await expect(client.searchTickets("invalid jql")).rejects.toThrow(
        "Jira API error: 400",
      );
    });
  });

  describe("parseWebhook", () => {
    it("delegates to parseJiraWebhook (tested separately)", () => {
      const result = client.parseWebhook({
        user: { accountId: "abc", displayName: "Mia" },
        issue: { key: "PROJ-1" },
        changelog: {
          items: [
            {
              field: "status",
              fieldtype: "jira",
              fromString: "To Do",
              toString: "AI",
            },
          ],
        },
      });

      expect(result).toEqual({
        type: "ticket_moved",
        ticketId: "PROJ-1",
        fromColumn: "To Do",
        toColumn: "AI",
        triggeredBy: "Mia",
        triggeredByAccountId: "abc",
      });
    });
  });
});
