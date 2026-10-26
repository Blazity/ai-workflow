import { readFileSync } from "node:fs";
import {
  IssueTrackerInputRejectedError,
  IssueTrackerNotFoundError,
} from "@integrations/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  LinearAdapter,
  extractAcceptanceCriteria,
  truncateExcerpt,
} from "./issue-tracker";

function recorded(name: string): any {
  return JSON.parse(
    readFileSync(new URL(`./test-fixtures/${name}.json`, import.meta.url), "utf8"),
  );
}

function mockFetch(handler: (query: string, variables: any) => any) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse((init?.body as string) ?? "{}");
    const result = await handler(parsed.query ?? "", parsed.variables ?? {});
    if (result instanceof Response) return result;
    return Response.json(result);
  });
}

describe("LinearAdapter", () => {
  describe("ticketUrl", () => {
    it("returns null for invalid keys", () => {
      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch: vi.fn(),
      });
      expect(adapter.ticketUrl("invalid")).toBeNull();
      expect(adapter.ticketUrl("123-ABC")).toBeNull();
      expect(adapter.ticketUrl("")).toBeNull();
    });

    it("returns fallback URL when orgUrlKey is not yet known", () => {
      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch: vi.fn(),
      });
      expect(adapter.ticketUrl("CUK-16")).toBe("https://linear.app/issue/CUK-16");
    });

    it("returns org-scoped URL when orgUrlKey is known", () => {
      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        orgUrlKey: "test-workspace",
        fetch: vi.fn(),
      });
      expect(adapter.ticketUrl("CUK-16")).toBe(
        "https://linear.app/test-workspace/issue/CUK-16",
      );
    });
  });

  describe("extractAcceptanceCriteria and truncateExcerpt", () => {
    it("extracts acceptance criteria from description", () => {
      const desc =
        "Some details.\n\nAcceptance Criteria:\n- Works in dark mode\n- Fast\n\n# Next section";
      expect(extractAcceptanceCriteria(desc)).toBe(
        "- Works in dark mode\n- Fast",
      );

      const desc2 = "Intro\n\nAC:\n- One thing\n\nOther stuff";
      expect(extractAcceptanceCriteria(desc2)).toBe("- One thing");

      expect(extractAcceptanceCriteria("No criteria here")).toBe("");
    });

    it("truncates excerpt properly with ... and no em/en dashes", () => {
      expect(truncateExcerpt("short", 10)).toBe("short");
      expect(truncateExcerpt("hello world this is long", 15)).toBe(
        "hello world...",
      );
    });

    it("collapses whitespace before truncating excerpt", () => {
      expect(truncateExcerpt("  hello \n\t  world  this is  long  ", 15)).toBe(
        "hello world...",
      );
      expect(truncateExcerpt("   line1 \n\n line2   ", 50)).toBe("line1 line2");
    });
  });

  describe("getCurrentUserAccountId", () => {
    it("fetches and caches viewer id", async () => {
      let callCount = 0;
      const fetch = mockFetch((query) => {
        if (query.includes("Viewer")) {
          callCount++;
          return recorded("viewer-and-org");
        }
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      const id1 = await adapter.getCurrentUserAccountId();
      const id2 = await adapter.getCurrentUserAccountId();

      expect(id1).toBe("9269b25b-5b9a-464c-85f1-be8d77a186e7");
      expect(id2).toBe("9269b25b-5b9a-464c-85f1-be8d77a186e7");
      expect(callCount).toBe(1);
    });
  });

  describe("listStatuses", () => {
    it("returns states sorted by position ascending and deduplicated", async () => {
      const fetch = mockFetch((query) => {
        if (query.includes("TeamStates")) {
          return recorded("team-states");
        }
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      const statuses = await adapter.listStatuses();

      expect(statuses.length).toBe(7);
      expect(statuses[0]).toEqual({
        id: "7e83acb5-d9bf-405f-a524-ab7ae4883908",
        name: "Backlog",
      });
      expect(statuses[1]).toEqual({
        id: "5a3e6c63-ce3f-408d-91b6-c1217be3abe6",
        name: "Todo",
      });
      expect(statuses.at(-1)).toEqual({
        id: "d5731f6b-342e-46ef-be72-228e1d1ce0f6",
        name: "In Review",
      });
    });
  });

  describe("fetchTicket", () => {
    it("fetches ticket details from live recorded fixture", async () => {
      const fetch = mockFetch((query) => {
        if (query.includes("IssueByIdentifier")) {
          return recorded("issue-fetch");
        }
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      const ticket = await adapter.fetchTicket("CUK-16");

      expect(ticket.id).toBe("5f32fe30-b85e-4a3a-ab68-04c3c743f0c8");
      expect(ticket.identifier).toBe("CUK-16");
      expect(ticket.projectKey).toBe("CUK");
      expect(ticket.title).toBe("Test Issue");
      expect(ticket.trackerStatus).toBe("Backlog");
      expect(ticket.trackerStatusId).toBe("7e83acb5-d9bf-405f-a524-ab7ae4883908");
      expect(ticket.commentsComplete).toBe(true);
      expect(ticket.comments).toEqual([]);
    });

    it("throws IssueTrackerNotFoundError when issue is not found", async () => {
      const fetch = mockFetch(() => ({ data: { issue: null } }));
      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });

      await expect(adapter.fetchTicket("MISSING-1")).rejects.toThrow(
        IssueTrackerNotFoundError,
      );
    });

    it("maps parent, children and relations correctly", async () => {
      const fetch = mockFetch(() => ({
        data: {
          issue: {
            id: "issue-1",
            identifier: "CUK-10",
            title: "Main Issue",
            description: "Some description",
            state: { id: "s1", name: "In Progress" },
            team: { key: "CUK" },
            parent: { identifier: "CUK-1", title: "Parent", state: { name: "Todo" } },
            children: {
              nodes: [{ identifier: "CUK-11", title: "Child 1", state: { name: "Done" } }],
            },
            relations: {
              nodes: [
                {
                  type: "blocks",
                  relatedIssue: { identifier: "CUK-12", title: "Blocked", state: { name: "Backlog" } },
                },
                {
                  type: "duplicate",
                  relatedIssue: { identifier: "CUK-13", title: "Duplicate", state: { name: "Todo" } },
                },
              ],
            },
            inverseRelations: {
              nodes: [
                {
                  type: "blocks",
                  issue: { identifier: "CUK-14", title: "Blocker", state: { name: "In Progress" } },
                },
              ],
            },
            comments: { nodes: [], pageInfo: { hasNextPage: false } },
            labels: { nodes: [{ id: "l1", name: "Bug" }] },
            attachments: { nodes: [] },
          },
        },
      }));

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      const ticket = await adapter.fetchTicket("CUK-10");

      expect(ticket.relatedTickets).toEqual([
        { key: "CUK-1", title: "Parent", status: "Todo", relation: "is a child of" },
        { key: "CUK-11", title: "Child 1", status: "Done", relation: "is the parent of" },
        { key: "CUK-12", title: "Blocked", status: "Backlog", relation: "blocks" },
        { key: "CUK-13", title: "Duplicate", status: "Todo", relation: "duplicates" },
        { key: "CUK-14", title: "Blocker", status: "In Progress", relation: "is blocked by" },
      ]);
    });

    it("handles commentsSince when initial page already covers the window", async () => {
      let pagedCalled = false;
      const fetch = mockFetch((query) => {
        if (query.includes("IssueByIdentifier")) {
          return {
            data: {
              issue: {
                id: "issue-1",
                identifier: "CUK-10",
                title: "Ticket",
                comments: {
                  nodes: [
                    { id: "c1", body: "Recent comment", createdAt: "2026-10-21T14:00:00.000Z" },
                    { id: "c2", body: "Older comment", createdAt: "2026-10-21T10:00:00.000Z" },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                },
                labels: { nodes: [] },
              },
            },
          };
        }
        if (query.includes("IssueCommentsPaged")) {
          pagedCalled = true;
          return { data: { issue: { comments: { nodes: [], pageInfo: { hasNextPage: false } } } } };
        }
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({ apiToken: "test", projectKey: "CUK", fetch });
      const ticket = await adapter.fetchTicket("CUK-10", {
        commentsSince: "2026-10-21T12:00:00.000Z",
      });

      expect(pagedCalled).toBe(false);
      expect(ticket.comments.length).toBe(2);
      expect(ticket.commentsComplete).toBe(false);
      expect(ticket.commentsCompleteFrom).toBe("2026-10-21T10:00:00.000Z");
    });

    it("paginates until commentsSince is covered and sets commentsCompleteFrom", async () => {
      let pageCount = 0;
      const fetch = mockFetch((query) => {
        if (query.includes("IssueByIdentifier")) {
          return {
            data: {
              issue: {
                id: "issue-1",
                identifier: "CUK-10",
                title: "Ticket",
                comments: {
                  nodes: [
                    { id: "c1", body: "Newest", createdAt: "2026-10-21T15:00:00.000Z" },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                },
                labels: { nodes: [] },
              },
            },
          };
        }
        if (query.includes("IssueCommentsPaged")) {
          pageCount++;
          return {
            data: {
              issue: {
                comments: {
                  nodes: [
                    { id: "c2", body: "Older", createdAt: "2026-10-21T11:00:00.000Z" },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
                },
              },
            },
          };
        }
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({ apiToken: "test", projectKey: "CUK", fetch });
      const ticket = await adapter.fetchTicket("CUK-10", {
        commentsSince: "2026-10-21T12:00:00.000Z",
      });

      expect(pageCount).toBe(1);
      expect(ticket.comments.length).toBe(2);
      expect(ticket.commentsComplete).toBe(false);
      expect(ticket.commentsCompleteFrom).toBe("2026-10-21T11:00:00.000Z");
    });
  });

  describe("resolveMoveTargetStatus and moveTicket", () => {
    it("resolves status by transitionId, statusId, and name", async () => {
      const fetch = mockFetch(() => recorded("team-states"));
      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });

      const byTransitionId = await adapter.resolveMoveTargetStatus("CUK-16", {
        name: "In Progress",
        transitionId: "75a9e150-4a59-4864-b7be-6a7bb43e08b8",
      });
      expect(byTransitionId).toEqual({
        id: "75a9e150-4a59-4864-b7be-6a7bb43e08b8",
        name: "In Progress",
      });

      const byStatusId = await adapter.resolveMoveTargetStatus("CUK-16", {
        name: "Done",
        statusId: "a52f3682-356e-408d-a64a-42ca11194fcc",
      });
      expect(byStatusId).toEqual({
        id: "a52f3682-356e-408d-a64a-42ca11194fcc",
        name: "Done",
      });

      const byName = await adapter.resolveMoveTargetStatus("CUK-16", "In Review");
      expect(byName).toEqual({
        id: "d5731f6b-342e-46ef-be72-228e1d1ce0f6",
        name: "In Review",
      });

      const missing = await adapter.resolveMoveTargetStatus("CUK-16", "Nonexistent");
      expect(missing).toBeNull();
    });

    it("executes issueUpdate mutation on moveTicket", async () => {
      let updatedStateId = "";
      const fetch = mockFetch((query, variables) => {
        if (query.includes("TeamStates")) return recorded("team-states");
        if (query.includes("MoveIssue")) {
          updatedStateId = variables.stateId;
          return { data: { issueUpdate: { success: true } } };
        }
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      await adapter.moveTicket("CUK-16", "Done");

      expect(updatedStateId).toBe("a52f3682-356e-408d-a64a-42ca11194fcc");
    });

    it("throws error when target state is not found", async () => {
      const fetch = mockFetch(() => recorded("team-states"));
      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });

      await expect(adapter.moveTicket("CUK-16", "Nonexistent")).rejects.toThrow(
        /No workflow state matching "Nonexistent" found/,
      );
    });
  });

  describe("postComment and findCommentByMarker", () => {
    it("posts comment and returns url from recorded fixture", async () => {
      const fetch = mockFetch((query) => {
        if (query.includes("CreateComment")) return recorded("comment-create");
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      const url = await adapter.postComment("CUK-16", "test body");

      expect(url).toBe(
        "https://linear.app/test-workspace/issue/CUK-16/test-issue#comment-82c69b4a",
      );
    });

    it("finds comment by marker", async () => {
      const fetch = mockFetch((query) => {
        if (query.includes("IssueCommentsForMarker")) {
          return {
            data: {
              issue: {
                comments: {
                  nodes: [
                    { id: "c1", body: "Hello\nworld", url: "https://linear.app/c1" },
                    { id: "c2", body: "Summary\n<!-- marker-42 -->", url: "https://linear.app/c2" },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        }
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      const found = await adapter.findCommentByMarker("CUK-16", "<!-- marker-42 -->");
      expect(found).toBe("https://linear.app/c2");

      const notFound = await adapter.findCommentByMarker("CUK-16", "<!-- missing -->");
      expect(notFound).toBeNull();
    });
  });

  describe("createTicket", () => {
    it("creates ticket with summary and creates missing labels", async () => {
      const createdLabels: string[] = [];
      let createdIssueInput: any = null;

      const fetch = mockFetch((query, variables) => {
        if (query.includes("TeamId")) {
          return { data: { teams: { nodes: [{ id: "team-cuk", key: "CUK" }] } } };
        }
        if (query.includes("TeamLabels")) {
          return {
            data: {
              issueLabels: {
                nodes: [{ id: "l-bug", name: "Bug" }],
              },
            },
          };
        }
        if (query.includes("CreateLabel")) {
          createdLabels.push(variables.input.name);
          return {
            data: {
              issueLabelCreate: {
                success: true,
                issueLabel: { id: `l-${variables.input.name}`, name: variables.input.name },
              },
            },
          };
        }
        if (query.includes("CreateIssue")) {
          createdIssueInput = variables.input;
          return recorded("issue-create");
        }
        throw new Error(`unexpected query: ${query}`);
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      const res = await adapter.createTicket({
        summary: "New Ticket",
        description: "Ticket details",
        labels: ["Bug", "New-Auto-Label"],
      });

      expect(res.identifier).toBe("CUK-17");
      expect(res.url).toBe(
        "https://linear.app/test-workspace/issue/CUK-17/api-created-test-ticket",
      );
      expect(createdLabels).toEqual(["New-Auto-Label"]);
      expect(createdIssueInput).toEqual({
        teamId: "team-cuk",
        title: "New Ticket",
        description: "Ticket details",
        labelIds: ["l-bug", "l-New-Auto-Label"],
      });
    });

    it("throws IssueTrackerInputRejectedError when issueLabelCreate returns no ID", async () => {
      const fetch = mockFetch((query) => {
        if (query.includes("TeamId")) {
          return { data: { teams: { nodes: [{ id: "team-cuk", key: "CUK" }] } } };
        }
        if (query.includes("TeamLabels")) {
          return { data: { issueLabels: { nodes: [] } } };
        }
        if (query.includes("CreateLabel")) {
          return { data: { issueLabelCreate: { success: false, issueLabel: null } } };
        }
        throw new Error(`unexpected query: ${query}`);
      });

      const adapter = new LinearAdapter({ apiToken: "test", projectKey: "CUK", fetch });
      await expect(
        adapter.createTicket({
          summary: "Ticket with missing label creation",
          labels: ["FailedLabel"],
        }),
      ).rejects.toThrow(IssueTrackerInputRejectedError);
    });

    it("resolves workspace-level labels from issueLabels and does not re-create them", async () => {
      let createLabelCalled = false;
      const fetch = mockFetch((query) => {
        if (query.includes("TeamId")) {
          return { data: { teams: { nodes: [{ id: "team-cuk", key: "CUK" }] } } };
        }
        if (query.includes("TeamLabels")) {
          return {
            data: {
              issueLabels: {
                nodes: [
                  { id: "l-ws-feature", name: "Feature" },
                  { id: "l-ws-bug", name: "Bug" },
                ],
              },
            },
          };
        }
        if (query.includes("CreateLabel")) {
          createLabelCalled = true;
          return { data: { issueLabelCreate: { success: true } } };
        }
        if (query.includes("CreateIssue")) {
          return recorded("issue-create");
        }
        throw new Error(`unexpected query: ${query}`);
      });

      const adapter = new LinearAdapter({ apiToken: "test", projectKey: "CUK", fetch });
      const res = await adapter.createTicket({
        summary: "Ticket with workspace label",
        labels: ["Feature"],
      });

      expect(res.identifier).toBe("CUK-17");
      expect(createLabelCalled).toBe(false);
    });

    it("matches existing labels case-insensitively with eqIgnoreCase filter without creating new labels", async () => {
      let passedFilter: any = null;
      let createLabelCalled = false;
      let createdIssueInput: any = null;

      const fetch = mockFetch((query, variables) => {
        if (query.includes("TeamId")) {
          return { data: { teams: { nodes: [{ id: "team-cuk", key: "CUK" }] } } };
        }
        if (query.includes("TeamLabels")) {
          passedFilter = variables.filter;
          return {
            data: {
              issueLabels: {
                nodes: [{ id: "l-bug", name: "Bug" }],
              },
            },
          };
        }
        if (query.includes("CreateLabel")) {
          createLabelCalled = true;
          return { data: { issueLabelCreate: { success: true } } };
        }
        if (query.includes("CreateIssue")) {
          createdIssueInput = variables.input;
          return recorded("issue-create");
        }
        throw new Error(`unexpected query: ${query}`);
      });

      const adapter = new LinearAdapter({ apiToken: "test", projectKey: "CUK", fetch });
      const res = await adapter.createTicket({
        summary: "Ticket with lowercase bug label",
        labels: ["bug"],
      });

      expect(res.identifier).toBe("CUK-17");
      expect(passedFilter).toEqual({
        and: [
          { or: [{ name: { eqIgnoreCase: "bug" } }] },
          {
            or: [
              { team: { key: { eq: "CUK" } } },
              { team: { null: true } },
            ],
          },
        ],
      });
      expect(createLabelCalled).toBe(false);
      expect(createdIssueInput.labelIds).toEqual(["l-bug"]);
    });
  });

  describe("ticketsInStatus", () => {
    it("sorts tickets ascending by createdAt", async () => {
      const fetch = mockFetch((query) => {
        if (query.includes("IssuesInState")) {
          return {
            data: {
              issues: {
                nodes: [
                  { identifier: "CUK-2", createdAt: "2026-10-21T12:00:00.000Z" },
                  { identifier: "CUK-1", createdAt: "2026-10-21T10:00:00.000Z" },
                  { identifier: "CUK-3", createdAt: "2026-10-21T14:00:00.000Z" },
                ],
              },
            },
          };
        }
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      const ids = await adapter.ticketsInStatus("Backlog");

      expect(ids).toEqual(["CUK-1", "CUK-2", "CUK-3"]);
    });
  });

  describe("ticketsWithLabel and findTickets", () => {
    it("finds tickets with label", async () => {
      const fetch = mockFetch((query) => {
        if (query.includes("IssuesWithLabel")) {
          expect(query).toContain("labels: { name: { eqIgnoreCase: $labelName } }");
          return { data: { issues: { nodes: [{ identifier: "CUK-10" }] } } };
        }
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      const ids = await adapter.ticketsWithLabel("ai-pending");
      expect(ids).toEqual(["CUK-10"]);
    });

    it("finds tickets by keywords", async () => {
      const fetch = mockFetch((query, variables) => {
        if (query.includes("FindIssues")) {
          expect(variables.query).toBe("auth login");
          return {
            data: {
              issues: {
                nodes: [
                  {
                    identifier: "CUK-5",
                    title: "Auth bug",
                    description: "Login fails",
                    url: "https://linear.app/cukorborsok/issue/CUK-5",
                    updatedAt: "2026-10-21T10:00:00.000Z",
                    state: { name: "Backlog" },
                    creator: { name: "Anna" },
                    team: { key: "CUK" },
                  },
                ],
              },
            },
          };
        }
        throw new Error("unexpected query");
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      const summaries = await adapter.findTickets({
        keywords: ["auth", "login"],
        limit: 10,
      });

      expect(summaries.length).toBe(1);
      expect(summaries[0]).toEqual({
        key: "CUK-5",
        summary: "Auth bug",
        status: "Backlog",
        url: "https://linear.app/cukorborsok/issue/CUK-5",
        excerpt: "Login fails",
        reporter: "Anna",
        project: "CUK",
        updatedAt: "2026-10-21T10:00:00.000Z",
      });
    });

    it("returns empty array when keywords are empty", async () => {
      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch: vi.fn(),
      });
      const summaries = await adapter.findTickets({ keywords: [], limit: 10 });
      expect(summaries).toEqual([]);
    });
  });

  describe("updateLabels", () => {
    it("adds and removes labels", async () => {
      let finalLabelIds: string[] = [];
      const fetch = mockFetch((query, variables) => {
        if (query.includes("IssueLabelsForUpdate")) {
          return {
            data: {
              issue: {
                id: "issue-1",
                labels: {
                  nodes: [
                    { id: "l-keep", name: "KeepMe" },
                    { id: "l-remove", name: "RemoveMe" },
                  ],
                },
              },
            },
          };
        }
        if (query.includes("TeamId")) {
          return { data: { teams: { nodes: [{ id: "team-cuk", key: "CUK" }] } } };
        }
        if (query.includes("TeamLabels")) {
          return {
            data: {
              issueLabels: {
                nodes: [{ id: "l-add", name: "AddMe" }],
              },
            },
          };
        }
        if (query.includes("UpdateIssueLabels")) {
          finalLabelIds = variables.labelIds;
          return { data: { issueUpdate: { success: true } } };
        }
        throw new Error(`unexpected query: ${query}`);
      });

      const adapter = new LinearAdapter({
        apiToken: "test",
        projectKey: "CUK",
        fetch,
      });
      await adapter.updateLabels("issue-1", {
        add: ["AddMe"],
        remove: ["RemoveMe"],
      });

      expect(finalLabelIds).toEqual(["l-keep", "l-add"]);
    });
  });

  describe("error classification", () => {
    it("throws 401 on authentication error", async () => {
      const fetch = mockFetch(() => ({
        errors: [{ message: "Invalid token", extensions: { code: "AUTHENTICATION_ERROR" } }],
      }));
      const adapter = new LinearAdapter({ apiToken: "bad", projectKey: "CUK", fetch });
      await expect(adapter.getCurrentUserAccountId()).rejects.toMatchObject({ status: 401 });
    });

    it("throws 403 on forbidden error", async () => {
      const fetch = mockFetch(() => ({
        errors: [{ message: "Forbidden resource", extensions: { code: "FORBIDDEN" } }],
      }));
      const adapter = new LinearAdapter({ apiToken: "bad", projectKey: "CUK", fetch });
      await expect(adapter.listStatuses()).rejects.toMatchObject({ status: 403 });
    });

    it("throws 429 on rate limit error", async () => {
      const fetch = mockFetch(() => ({
        errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }],
      }));
      const adapter = new LinearAdapter({ apiToken: "bad", projectKey: "CUK", fetch });
      await expect(adapter.listStatuses()).rejects.toMatchObject({ status: 429 });
    });

    it("classifies HTTP 400 with RATELIMITED as status 429", async () => {
      const fetch = mockFetch(() =>
        new Response(
          JSON.stringify({
            errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }],
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      );
      const adapter = new LinearAdapter({ apiToken: "test", projectKey: "CUK", fetch });
      await expect(adapter.listStatuses()).rejects.toMatchObject({ status: 429 });
    });

    it("throws IssueTrackerInputRejectedError on BAD_USER_INPUT for mutations", async () => {
      const fetch = mockFetch((query) => {
        if (query.includes("TeamId")) {
          return { data: { teams: { nodes: [{ id: "t1", key: "CUK" }] } } };
        }
        return {
          errors: [{ message: "Title is required", extensions: { code: "BAD_USER_INPUT" } }],
        };
      });
      const adapter = new LinearAdapter({ apiToken: "test", projectKey: "CUK", fetch });
      await expect(adapter.createTicket({ summary: "" })).rejects.toThrow(
        IssueTrackerInputRejectedError,
      );
    });
  });
});
