import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraAdapter } from "./issue-tracker";
import { IssueTrackerNotFoundError } from "@integrations/sdk";

// The adapter reaches Jira only through the fetch its context hands it, which
// is the one production passes (`ctx.http.fetch`). The global one is a
// tripwire: a request that fell back to it would be a path production never
// takes, so it fails the test instead of answering.
const mockFetch = vi.fn();
global.fetch = (() => {
  throw new Error("a Jira request went through the global fetch, not the context's");
}) as typeof fetch;

const CLOUD_ID = "test-cloud-id";
const API_BASE = `https://api.atlassian.com/ex/jira/${CLOUD_ID}`;

function jiraAdapter() {
  return new JiraAdapter({
    baseUrl: "https://test.atlassian.net",
    apiToken: "token",
    projectKey: "PROJ",
    cloudId: CLOUD_ID,
    fetch: mockFetch,
  });
}

/** The JQL of the most recent request, decoded the way Jira reads it. */
function sentJql(): string {
  const url = new URL(String(mockFetch.mock.calls.at(-1)?.[0]));
  return url.searchParams.get("jql") ?? "";
}

function jiraAdapterWithDiscovery() {
  return new JiraAdapter({
    baseUrl: "https://test.atlassian.net",
    apiToken: "token",
    projectKey: "PROJ",
    fetch: mockFetch,
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

  // P2.3. A team that plans a parent with subtasks and links ("blocks",
  // "relates to") expects the agent planning the parent to know its children
  // and their order, and the agent on a subtask to know its parent. The read
  // asked Jira for none of it, so planning on a parent whose three subtasks
  // named their files saw no subtask at all.
  //
  // The shapes below are Jira's own, cut down from real issues exported by
  // Jira's REST API and kept at github.com/tidev/jira-archive (ALOY-210 for
  // subtasks, ALOY-717 for a parent, ALOY-330 and ALOY-323 for the two
  // directions of one "Depends" link), plus Atlassian's "Blocks" link type.
  describe("fetchTicket related tickets", () => {
    function issueWith(fields: Record<string, unknown>) {
      return {
        ok: true,
        json: async () => ({
          id: "99986",
          key: "ALOY-210",
          fields: {
            summary: "Support Dynamic Styling",
            description: null,
            comment: { comments: [], total: 0 },
            labels: [],
            status: { name: "AI" },
            attachment: [],
            ...fields,
          },
        }),
      };
    }

    it("asks for the parent, the subtasks and the links in the same one request", async () => {
      mockFetch.mockResolvedValueOnce(issueWith({ subtasks: [], issuelinks: [], parent: null }));

      await jiraAdapter().fetchTicket("ALOY-210");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fields = new URL(String(mockFetch.mock.calls[0][0])).searchParams.get("fields")?.split(",");
      expect(fields).toEqual(expect.arrayContaining(["subtasks", "parent", "issuelinks", "issuetype"]));
    });

    it("lists a parent's subtasks in the order the team ranked them", async () => {
      mockFetch.mockResolvedValueOnce(
        issueWith({
          subtasks: [
            { id: "112534", key: "ALOY-613", fields: { summary: "Develop API for adding/removing style classes", status: { id: "5", name: "Resolved" }, issuetype: { name: "Sub-task", subtask: true } } },
            { id: "115689", key: "ALOY-695", fields: { summary: "Create controller-specific version of Alloy.UI.create() that doesn't require controller name", status: { id: "6", name: "Closed" }, issuetype: { name: "Sub-task", subtask: true } } },
            { id: "115747", key: "ALOY-698", fields: { summary: "Change require('alloy/styler').generateStyle() to Alloy.createStyle()", status: { id: "5", name: "Resolved" }, issuetype: { name: "Sub-task", subtask: true } } },
          ],
          issuelinks: [],
          parent: null,
        }),
      );

      const ticket = await jiraAdapter().fetchTicket("ALOY-210");

      expect(ticket.relatedTickets).toEqual([
        { key: "ALOY-613", title: "Develop API for adding/removing style classes", status: "Resolved", relation: "is the parent of" },
        { key: "ALOY-695", title: "Create controller-specific version of Alloy.UI.create() that doesn't require controller name", status: "Closed", relation: "is the parent of" },
        { key: "ALOY-698", title: "Change require('alloy/styler').generateStyle() to Alloy.createStyle()", status: "Resolved", relation: "is the parent of" },
      ]);
    });

    it("names a subtask's parent, ahead of its links", async () => {
      mockFetch.mockResolvedValueOnce(
        issueWith({
          subtasks: [],
          parent: { id: "99986", key: "ALOY-210", fields: { summary: "Support Dynamic Styling", status: { name: "Closed" }, issuetype: { name: "New Feature" } } },
          issuelinks: [
            { id: "30247", type: { id: "10003", name: "Relates", inward: "relates to", outward: "relates to" }, outwardIssue: { id: "117259", key: "TIMOB-14575", fields: { summary: "iOS: setting borderRadius to null causes error", status: { name: "Open" } } } },
          ],
        }),
      );

      const ticket = await jiraAdapter().fetchTicket("ALOY-717");

      expect(ticket.relatedTickets).toEqual([
        { key: "ALOY-210", title: "Support Dynamic Styling", status: "Closed", relation: "is a child of" },
        { key: "TIMOB-14575", title: "iOS: setting borderRadius to null causes error", status: "Open", relation: "relates to" },
      ]);
    });

    // A link is one row seen from two ends, and Jira says which end this
    // ticket is by which side it fills in: the other issue under
    // `outwardIssue` means this ticket is the one the outward phrase is
    // about ("ALOY-330 depends on ALOY-323"), under `inwardIssue` the inward
    // one ("ALOY-323 is dependent of ALOY-134"). A team's own phrases, awkward
    // ones included, go through as written.
    it("keeps each link's own phrase for the direction this ticket is on", async () => {
      mockFetch.mockResolvedValueOnce(
        issueWith({
          subtasks: [],
          parent: null,
          issuelinks: [
            { id: "21863", type: { id: "10020", name: "Depends", inward: "is dependent of", outward: "depends on" }, outwardIssue: { key: "ALOY-323", fields: { summary: "Make Alloy support only TiSDK 3.0+", status: { name: "Resolved" } } } },
            { id: "23220", type: { id: "10020", name: "Depends", inward: "is dependent of", outward: "depends on" }, inwardIssue: { key: "ALOY-405", fields: { summary: "'orientation' device query", status: { name: "Open" } } } },
            { id: "10010", type: { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: "ALOY-209", fields: { summary: "ti.physicalSizeCategory module removed for Alloy 1.0.0 (TiSDK 3.0+)", status: { name: "Resolved" } } } },
          ],
        }),
      );

      const ticket = await jiraAdapter().fetchTicket("ALOY-330");

      expect(ticket.relatedTickets?.map(({ key, relation }) => `${relation} ${key}`)).toEqual([
        "depends on ALOY-323",
        "is dependent of ALOY-405",
        "is blocked by ALOY-209",
      ]);
    });

    it("says there are none when Jira lists none, and when the site has the feature off", async () => {
      mockFetch.mockResolvedValueOnce(issueWith({ subtasks: [], issuelinks: [], parent: null }));
      // Subtasks and issue linking can each be switched off for a site, and
      // then the field is simply not in the answer.
      mockFetch.mockResolvedValueOnce(issueWith({}));

      const adapter = jiraAdapter();
      expect((await adapter.fetchTicket("PROJ-1")).relatedTickets).toEqual([]);
      expect((await adapter.fetchTicket("PROJ-2")).relatedTickets).toEqual([]);
    });

    it("skips an entry without a key rather than naming a ticket that is not there", async () => {
      mockFetch.mockResolvedValueOnce(
        issueWith({
          subtasks: [{ id: "1", fields: { summary: "No key" } }],
          parent: { id: "2" },
          issuelinks: [
            { id: "3", type: { name: "Blocks", inward: "is blocked by", outward: "blocks" } },
            { id: "4", type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "PROJ-9" } },
          ],
        }),
      );

      const ticket = await jiraAdapter().fetchTicket("PROJ-1");

      expect(ticket.relatedTickets).toEqual([
        { key: "PROJ-9", title: "", status: "", relation: "blocks" },
      ]);
    });

    // An epic's stories are not in its own read: Jira lists `subtasks` there,
    // and an epic's children are issues whose `parent` is the epic. Planning an
    // epic without them plans it blind to the breakdown the team already made,
    // so an epic, and only an epic, costs one more request, a search for its
    // children. The issue type shape is Jira's (`hierarchyLevel` 1 is the epic
    // level, 0 a story, -1 a subtask), as the AWP project's own read returns it.
    describe("an epic's children", () => {
      const epicType = { id: "10821", name: "Epik", subtask: false, hierarchyLevel: 1 };

      function searchAnswer(issues: unknown[]) {
        return { ok: true, json: async () => ({ issues, isLast: true }) };
      }

      it("lists an epic's child issues after its subtasks and before its links, from one bounded search", async () => {
        mockFetch.mockResolvedValueOnce(
          issueWith({
            issuetype: epicType,
            parent: null,
            subtasks: [{ id: "50164", key: "AWP-275", fields: { summary: "Promo banner shows when the code expires", status: { name: "Gotowe" } } }],
            issuelinks: [
              { id: "1", type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "AWP-300", fields: { summary: "Launch the spring campaign", status: { name: "Do zrobienia" } } } },
            ],
          }),
        );
        mockFetch.mockResolvedValueOnce(
          searchAnswer([
            { id: "50165", key: "AWP-276", fields: { summary: "Basket API refuses expired codes", status: { name: "Gotowe" } } },
            // A subtask is a child too, so the search finds it again.
            { id: "50164", key: "AWP-275", fields: { summary: "Promo banner shows when the code expires", status: { name: "Gotowe" } } },
            { id: "50166", key: "AWP-277", fields: { summary: "Pricing module: discount rules get an optional expiry date", status: { name: "W toku" } } },
          ]),
        );

        const ticket = await jiraAdapter().fetchTicket("AWP-274");

        expect(ticket.relatedTickets).toEqual([
          { key: "AWP-275", title: "Promo banner shows when the code expires", status: "Gotowe", relation: "is the parent of" },
          { key: "AWP-276", title: "Basket API refuses expired codes", status: "Gotowe", relation: "is the parent of" },
          { key: "AWP-277", title: "Pricing module: discount rules get an optional expiry date", status: "W toku", relation: "is the parent of" },
          { key: "AWP-300", title: "Launch the spring campaign", status: "Do zrobienia", relation: "blocks" },
        ]);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const search = new URL(String(mockFetch.mock.calls[1][0]));
        expect(search.pathname).toMatch(/\/rest\/api\/3\/search\/jql$/);
        expect(search.searchParams.get("jql")).toBe('parent = "ALOY-210" ORDER BY Rank ASC');
        expect(search.searchParams.get("maxResults")).toBe("25");
        expect(search.searchParams.get("fields")?.split(",")).toEqual(["summary", "status"]);
      });

      // One line per ticket AND relation: the child the search finds again is
      // one line, and a link the epic also has to one of its children stays,
      // because "blocks" says something "is the parent of" does not.
      it("keeps a link to one of the epic's children beside the child line", async () => {
        mockFetch.mockResolvedValueOnce(
          issueWith({
            issuetype: epicType,
            parent: null,
            subtasks: [],
            issuelinks: [
              { id: "1", type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "AWP-276", fields: { summary: "Basket API refuses expired codes", status: { name: "Gotowe" } } } },
            ],
          }),
        );
        mockFetch.mockResolvedValueOnce(
          searchAnswer([{ id: "50165", key: "AWP-276", fields: { summary: "Basket API refuses expired codes", status: { name: "Gotowe" } } }]),
        );

        const ticket = await jiraAdapter().fetchTicket("AWP-274");

        expect(ticket.relatedTickets?.map(({ key, relation }) => `${relation} ${key}`)).toEqual([
          "is the parent of AWP-276",
          "blocks AWP-276",
        ]);
      });

      it("asks nothing more for a story, a task or a subtask", async () => {
        mockFetch.mockResolvedValueOnce(
          issueWith({ issuetype: { name: "Zadanie", subtask: false, hierarchyLevel: 0 }, parent: null, subtasks: [], issuelinks: [] }),
        );

        await jiraAdapter().fetchTicket("AWP-280");

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      // Every reader of a ticket goes through this read (dispatch, the
      // reconciler, the answer poller), so the children are the one part of it
      // allowed to fail: an epic whose children cannot be searched is still an
      // epic somebody can run.
      it("still reads an epic whose children cannot be searched, without them", async () => {
        mockFetch.mockResolvedValueOnce(
          issueWith({
            issuetype: epicType,
            parent: null,
            subtasks: [],
            issuelinks: [
              { id: "1", type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "AWP-300", fields: { summary: "Launch", status: { name: "Do zrobienia" } } } },
            ],
          }),
        );
        mockFetch.mockResolvedValueOnce({ ok: false, status: 400, statusText: "Bad Request", json: async () => ({}) });

        const ticket = await jiraAdapter().fetchTicket("AWP-274");

        expect(ticket.title).toBe("Support Dynamic Styling");
        expect(ticket.relatedTickets).toEqual([
          { key: "AWP-300", title: "Launch", status: "Do zrobienia", relation: "blocks" },
        ]);
      });
    });
  });

  // QA round 2 nit: the description said "Acceptance: ..." and the plan read
  // "Acceptance Criteria: None specified", because the only label the reader
  // knew was the two-word one. These are the labels people actually write.
  describe("fetchTicket acceptance criteria", () => {
    function withDescription(lines: string[]) {
      return {
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Pricing table",
            description: {
              type: "doc",
              content: lines.map((line) =>
                line === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text: line }] },
              ),
            },
            comment: { comments: [], total: 0 },
            labels: [],
            status: { name: "AI" },
            attachment: [],
          },
        }),
      };
    }

    it.each([
      ["Acceptance: prices show in zł with two decimals", "prices show in zł with two decimals"],
      ["Acceptance criteria: prices show in zł with two decimals", "prices show in zł with two decimals"],
      ["AC: prices show in zł with two decimals", "prices show in zł with two decimals"],
      ["ac: prices show in zł with two decimals", "prices show in zł with two decimals"],
      ["**Acceptance:** prices show in zł with two decimals", "prices show in zł with two decimals"],
      ["- AC: prices show in zł with two decimals", "prices show in zł with two decimals"],
    ])("reads %j as the acceptance criteria", async (line, expected) => {
      mockFetch.mockResolvedValueOnce(withDescription(["Build the pricing table.", "", line]));

      const ticket = await jiraAdapter().fetchTicket("PROJ-1");

      expect(ticket.acceptanceCriteria).toBe(expected);
    });

    it("reads a heading on its own line followed by the criteria", async () => {
      mockFetch.mockResolvedValueOnce(
        withDescription(["Build the pricing table.", "", "Acceptance", "Totals match the CSV", "", "Notes: none"]),
      );

      const ticket = await jiraAdapter().fetchTicket("PROJ-1");

      expect(ticket.acceptanceCriteria).toBe("Totals match the CSV");
    });

    it.each([["Acceptance Criteria"], ["Acceptance:"], ["AC:"]])(
      "reads the criteria a blank line after the %j heading",
      async (heading) => {
        mockFetch.mockResolvedValueOnce(
          withDescription(["Build the pricing table.", "", heading, "", "Totals match the CSV", "", "Notes: none"]),
        );

        const ticket = await jiraAdapter().fetchTicket("PROJ-1");

        expect(ticket.acceptanceCriteria).toBe("Totals match the CSV");
      },
    );

    it.each([["**Acceptance Criteria:**"], ["**AC:**"]])(
      "reads the criteria after a bold %j label, not the closing marker",
      async (label) => {
        mockFetch.mockResolvedValueOnce(
          withDescription(["Build the pricing table.", "", label, "", "Totals match the CSV", "", "Notes: none"]),
        );

        const ticket = await jiraAdapter().fetchTicket("PROJ-1");

        expect(ticket.acceptanceCriteria).toBe("Totals match the CSV");
      },
    );

    it("reads an empty section as no criteria rather than taking the next heading", async () => {
      mockFetch.mockResolvedValueOnce(withDescription(["AC:", "", "## Notes", "Use the staging prices"]));

      const ticket = await jiraAdapter().fetchTicket("PROJ-1");

      expect(ticket.acceptanceCriteria).toBe("");
    });

    it("still reads the criteria a sentence introduces", async () => {
      mockFetch.mockResolvedValueOnce(
        withDescription(["These are the acceptance criteria:", "Totals match the CSV", "", "Notes: none"]),
      );

      const ticket = await jiraAdapter().fetchTicket("PROJ-1");

      expect(ticket.acceptanceCriteria).toBe("Totals match the CSV");
    });

    it.each([
      ["ACME: pricing for the ACME account"],
      ["Acceptance tests live in e2e/pricing.spec.ts"],
      ["Voltage AC: 230V"],
    ])("does not take %j for acceptance criteria", async (line) => {
      mockFetch.mockResolvedValueOnce(withDescription(["Build the pricing table.", "", line]));

      const ticket = await jiraAdapter().fetchTicket("PROJ-1");

      expect(ticket.acceptanceCriteria).toBe("");
    });
  });

  // Every agent reads a ticket through this text, and the flattener used to put
  // every text run on a line of its own: a sentence with one bold word or one
  // link reached the model as four lines, and a description written in Jira's
  // editor has no blank line anywhere, so the acceptance criteria ran on to the
  // end of it. The nodes below are Atlassian's own examples from the ADF
  // reference (developer.atlassian.com/cloud/jira/platform/apis/document/,
  // retrieved 2026-09-23: nodes mention, emoji, date, status, inlineCard,
  // hardBreak, codeBlock, orderedList, listItem, tableHeader, expand; marks link),
  // and taskList/taskItem from the ADF JSON schema (@atlaskit/adf-schema,
  // full.json), put together the way Jira's editor writes a description.
  describe("fetchTicket rich text", () => {
    const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
    const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
    const listItem = (...content: unknown[]) => ({ type: "listItem", content });
    const doc = (...content: unknown[]) => ({ version: 1, type: "doc", content });

    function issueWith(description: unknown, commentBodies: unknown[] = []) {
      return {
        ok: true,
        json: async () => ({
          id: "10001",
          key: "PROJ-1",
          fields: {
            summary: "Discount codes can expire",
            description,
            comment: {
              comments: commentBodies.map((body, index) => ({
                id: String(index + 1),
                author: { displayName: "Ada", accountId: "acc-ada" },
                body,
                created: "2026-09-23T10:00:00.000Z",
              })),
              total: commentBodies.length,
            },
            labels: [],
            status: { name: "AI" },
            attachment: [],
          },
        }),
      };
    }

    async function read(description: unknown, commentBodies: unknown[] = []) {
      mockFetch.mockResolvedValueOnce(issueWith(description, commentBodies));
      return jiraAdapter().fetchTicket("PROJ-1");
    }

    it("reads a sentence with a bold word and a link as one line", async () => {
      const ticket = await read(
        doc(
          paragraph(
            text("The basket API "),
            text("must", [{ type: "strong" }]),
            text(" refuse an expired code, see "),
            text("the pricing rules", [{ type: "link", attrs: { href: "https://example.com/pricing", title: "Pricing" } }]),
            text(" for the dates."),
          ),
        ),
      );

      expect(ticket.description).toBe(
        "The basket API must refuse an expired code, see [the pricing rules](https://example.com/pricing) for the dates.",
      );
    });

    it("writes a link whose text is its address once", async () => {
      const ticket = await read(
        doc(paragraph(text("Spec: "), text("https://example.com/spec", [{ type: "link", attrs: { href: "https://example.com/spec" } }]))),
      );

      expect(ticket.description).toBe("Spec: https://example.com/spec");
    });

    it("reads mentions, emoji, dates, status lozenges, inline code and cards as a person sees them", async () => {
      const ticket = await read(
        doc(
          paragraph(
            { type: "mention", attrs: { id: "ABCDE-ABCDE-ABCDE-ABCDE", text: "@Bradley Ayers", userType: "APP" } },
            text(" please ship "),
            text("parseCode()", [{ type: "code" }]),
            text(" by "),
            { type: "date", attrs: { timestamp: "1582152559" } },
            text(" "),
            { type: "emoji", attrs: { shortName: ":grinning:", text: "😀" } },
            text(" it is "),
            { type: "status", attrs: { localId: "abcdef12-abcd-abcd-abcd-abcdef123456", text: "In Progress", color: "yellow" } },
            text(", design in "),
            { type: "inlineCard", attrs: { url: "https://atlassian.com" } },
          ),
        ),
      );

      expect(ticket.description).toBe(
        "@Bradley Ayers please ship `parseCode()` by 2020-02-19 😀 it is In Progress, design in https://atlassian.com",
      );
    });

    it("reads a date written in milliseconds, and an emoji with only its short name", async () => {
      const ticket = await read(
        doc(paragraph(text("Due "), { type: "date", attrs: { timestamp: "1582152559000" } }, text(" "), { type: "emoji", attrs: { shortName: ":rocket:" } })),
      );

      expect(ticket.description).toBe("Due 2020-02-19 :rocket:");
    });

    it("marks struck-out text, so a requirement somebody crossed out does not read as one", async () => {
      const ticket = await read(
        doc(paragraph(text("Store codes in "), text("Redis", [{ type: "strike" }]), text(" Postgres."))),
      );

      expect(ticket.description).toBe("Store codes in ~~Redis~~ Postgres.");
    });

    it("breaks the line where a person pressed Shift+Enter, and nowhere else inside a paragraph", async () => {
      const ticket = await read(doc(paragraph(text("Hello"), { type: "hardBreak" }, text("world"))));

      expect(ticket.description).toBe("Hello\nworld");
    });

    it("stops the acceptance criteria under a heading at the paragraph after the list", async () => {
      const ticket = await read(
        doc(
          paragraph(text("Marketing wants discount codes that stop working after a date.")),
          { type: "heading", attrs: { level: 2 }, content: [text("Acceptance criteria")] },
          {
            type: "bulletList",
            content: [
              listItem(paragraph(text("The basket "), text("refuses", [{ type: "strong" }]), text(" an expired code"))),
              listItem(paragraph(text("The banner shows the expiry date in UTC"))),
            ],
          },
          paragraph(text("Out of scope: a UI for managing codes.")),
        ),
      );

      expect(ticket.acceptanceCriteria).toBe(
        "- The basket refuses an expired code\n- The banner shows the expiry date in UTC",
      );
      expect(ticket.description).toBe(
        [
          "Marketing wants discount codes that stop working after a date.",
          "## Acceptance criteria",
          "",
          "- The basket refuses an expired code",
          "- The banner shows the expiry date in UTC",
          "",
          "Out of scope: a UI for managing codes.",
        ].join("\n"),
      );
    });

    it("stops the criteria a label introduces at the next heading", async () => {
      const ticket = await read(
        doc(
          paragraph(text("AC:", [{ type: "strong" }])),
          paragraph(text("Expired codes are refused with a 410")),
          { type: "heading", attrs: { level: 3 }, content: [text("Notes")] },
          paragraph(text("Use the staging prices.")),
        ),
      );

      expect(ticket.acceptanceCriteria).toBe("Expired codes are refused with a 410");
    });

    it("numbers an ordered list from where it starts, and indents a nested list under its item", async () => {
      const ticket = await read(
        doc({
          type: "orderedList",
          attrs: { order: 3 },
          content: [
            listItem(
              paragraph(text("Add the expiry column")),
              { type: "bulletList", content: [listItem(paragraph(text("nullable, UTC")))] },
            ),
            listItem(paragraph(text("Refuse expired codes"))),
          ],
        }),
      );

      expect(ticket.description).toBe("3. Add the expiry column\n   - nullable, UTC\n4. Refuse expired codes");
    });

    it("reads an action item list with what is done ticked", async () => {
      const ticket = await read(
        doc({
          type: "taskList",
          attrs: { localId: "tl-1" },
          content: [
            { type: "taskItem", attrs: { localId: "t-1", state: "DONE" }, content: [text("Write the migration")] },
            { type: "taskItem", attrs: { localId: "t-2", state: "TODO" }, content: [text("Update the banner")] },
          ],
        }),
      );

      expect(ticket.description).toBe("- [x] Write the migration\n- [ ] Update the banner");
    });

    it("keeps a code block's lines and language, set apart from the text around it", async () => {
      const ticket = await read(
        doc(
          paragraph(text("Before")),
          { type: "codeBlock", attrs: { language: "javascript" }, content: [text("var foo = {};\nvar bar = [];")] },
          paragraph(text("After")),
        ),
      );

      expect(ticket.description).toBe("Before\n\n```javascript\nvar foo = {};\nvar bar = [];\n```\n\nAfter");
    });

    it("reads a table row by row, one cell never running into the next", async () => {
      const cell = (type: string, value: string) => ({ type, attrs: {}, content: [paragraph(text(value))] });
      const ticket = await read(
        doc({
          type: "table",
          attrs: { isNumberColumnEnabled: false, layout: "default" },
          content: [
            { type: "tableRow", content: [cell("tableHeader", "Code"), cell("tableHeader", "Expires")] },
            { type: "tableRow", content: [cell("tableCell", "SPRING"), cell("tableCell", "2026-10-01")] },
          ],
        }),
      );

      expect(ticket.description).toBe("| Code | Expires |\n| --- | --- |\n| SPRING | 2026-10-01 |");
    });

    it("reads an expand's title and body", async () => {
      const ticket = await read(
        doc({ type: "expand", attrs: { title: "Hello world" }, content: [paragraph(text("Hello world"))] }),
      );

      expect(ticket.description).toBe("Hello world\nHello world");
    });

    // The quote marker is what the answer readers tell a person's words from
    // ours by, so a quoted sentence with one bold word must stay ONE quoted
    // line, not three lines with the bold word stranded on its own.
    it("keeps a quoted sentence with a bold word on one quoted line", async () => {
      const ticket = await read(doc(paragraph(text("Build it"))), [
        doc(
          {
            type: "blockquote",
            content: [paragraph(text("github:acme/billing is "), text("not", [{ type: "strong" }]), text(" selected on this work."))],
          },
          paragraph(text("yes, add it")),
        ),
      ]);

      expect(ticket.comments[0]?.body).toBe("> github:acme/billing is not selected on this work.\nyes, add it");
    });

    // An image-only comment is not an answer (`answer-authorship.ts`), so it
    // must keep reading as empty rather than as a placeholder for the file.
    it("reads a comment that is only an image as empty", async () => {
      const ticket = await read(doc(paragraph(text("Build it"))), [
        doc({
          type: "mediaSingle",
          attrs: { layout: "center" },
          content: [{ type: "media", attrs: { id: "4478e39c-cf9b-41d1-ba92-68589487cd75", type: "file", collection: "MediaServicesSample" } }],
        }),
      ]);

      expect(ticket.comments[0]?.body).toBe("");
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

  describe("the configured project scope of a search", () => {
    // findTickets promises that no combination of keywords or authored query
    // reaches a project this connection was not configured for. These read the
    // query Jira would actually receive, so they fail on whatever widens it.
    async function searchedJql(input: {
      keywords: readonly string[];
      providerQuery?: string;
    }): Promise<string> {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ issues: [] }) });
      await jiraAdapter().findTickets({ limit: 5, ...input });
      return sentJql();
    }

    it("scopes to the configured project and ORs the keyword clauses", async () => {
      expect(await searchedJql({ keywords: ["login failure", "payment"] })).toBe(
        '(project = "PROJ") AND (text ~ "login failure" OR text ~ "payment")',
      );
    });

    it("keeps the project scope first when an authored query narrows the search", async () => {
      expect(
        await searchedJql({ keywords: ["login"], providerQuery: "labels = support" }),
      ).toBe('(project = "PROJ") AND (labels = support) AND (text ~ "login")');
    });

    it("scopes the authored query alone when no keywords were extracted", async () => {
      expect(await searchedJql({ keywords: [], providerQuery: "labels = support" })).toBe(
        '(project = "PROJ") AND (labels = support)',
      );
    });

    it("never sends an unscoped query, even with nothing else to add", async () => {
      expect(await searchedJql({ keywords: [] })).toBe('(project = "PROJ")');
    });

    it("cannot be widened past the configured project by a query naming another", async () => {
      // Both project clauses are ANDed, so this finds nothing rather than
      // finding OTHER's tickets: out of scope fails closed.
      expect(
        await searchedJql({
          keywords: ["login"],
          providerQuery: "project = OTHER OR project = PROJ",
        }),
      ).toBe(
        '(project = "PROJ") AND (project = OTHER OR project = PROJ) AND (text ~ "login")',
      );
    });

    it("drops an unbalanced authored query that tries to close the project scope", async () => {
      expect(
        await searchedJql({
          keywords: ["login"],
          providerQuery: "labels = support) OR (project = OTHER",
        }),
      ).toBe('(project = "PROJ") AND (text ~ "login")');
    });

    it("drops an authored query that hides a parenthesis behind a single-quoted string", async () => {
      // JQL takes a value in single or double quotation marks. Read as if only
      // double quotes opened a string, this looks balanced: the `"` inside the
      // single-quoted value seems to open a string that swallows `) OR ... (`.
      // Jira reads `'"'` as a one-character string, so the `)` closes the
      // project clause and OR reaches every project the token can see.
      expect(
        await searchedJql({
          keywords: ["login"],
          providerQuery: `summary ~ '"' ) OR project = OTHER OR ( summary ~ '"'`,
        }),
      ).toBe('(project = "PROJ") AND (text ~ "login")');
    });

    it("drops an authored query that hides a parenthesis behind a double-quoted string", async () => {
      expect(
        await searchedJql({
          keywords: [],
          providerQuery: `summary ~ "'" ) OR project = OTHER OR ( summary ~ "'"`,
        }),
      ).toBe('(project = "PROJ")');
    });

    it("drops an authored query with a backslash outside a quoted value", async () => {
      // Outside a string a backslash escapes the next character in Jira's
      // lexer, so `\'` there is a literal quote rather than the start of a
      // string. A reader that disagreed with Jira about that one character
      // would see this as balanced while Jira sees the `)` close the scope, so
      // a backslash outside a value is refused rather than interpreted.
      expect(
        await searchedJql({
          keywords: [],
          providerQuery: String.raw`summary ~ \' ) OR project = OTHER OR ( summary ~ '\''`,
        }),
      ).toBe('(project = "PROJ")');
    });

    it("drops an authored query that leaves a string open", async () => {
      expect(
        await searchedJql({ keywords: [], providerQuery: "summary ~ 'unterminated" }),
      ).toBe('(project = "PROJ")');
    });

    it("keeps an authored query whose quoted value escapes its own quote", async () => {
      expect(
        await searchedJql({ keywords: [], providerQuery: String.raw`summary ~ 'it\'s (not) broken'` }),
      ).toBe(String.raw`(project = "PROJ") AND (summary ~ 'it\'s (not) broken')`);
    });

    it("strips quotes and backslashes that would break out of a keyword clause", async () => {
      expect(await searchedJql({ keywords: ['weird "quoted" \\keyword'] })).toBe(
        '(project = "PROJ") AND (text ~ "weird quoted keyword")',
      );
    });

    it("scopes a label search to the configured project and strips the label's quotes", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: [{ key: "PROJ-3" }] }),
      });

      const keys = await jiraAdapter().ticketsWithLabel('marker" OR project = "OTHER');

      expect(keys).toEqual(["PROJ-3"]);
      expect(sentJql()).toBe('project = "PROJ" AND labels = "marker OR project = OTHER"');
    });
  });

  describe("findTickets", () => {
    it("bounds Jira search latency with a timeout signal handed to the context's fetch", async () => {
      // The context's fetch joins a caller's signal to every attempt, so the
      // bound only operates if the signal reaches that fetch in `init`.
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
        expect(mockFetch).toHaveBeenCalledTimes(1);
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

    it("matches a bare status name even when it differs from the transition's own name", async () => {
      // Jira localizes statuses but not transitions: the action is named "Mark
      // as done" while the status it lands on reads "已完成". A caller quoting
      // the status name the error message offers (listStatuses, project
      // statuses) must resolve, not just one who knows the transition label.
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            transitions: [
              { id: "11", name: "Start progress", to: { id: "3", name: "进行中" } },
              { id: "31", name: "Mark as done", to: { id: "11416", name: "已完成" } },
            ],
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await jiraAdapter().moveTicket("10001", { name: "已完成" });

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

    it("resolves a target named after the status rather than the transition", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transitions: [{ id: "31", name: "Mark as done", to: { id: "11416", name: "已完成" } }],
        }),
      });

      await expect(
        jiraAdapter().resolveMoveTargetStatus("PROJ-1", "已完成"),
      ).resolves.toEqual({ id: "11416", name: "已完成" });
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

describe("the page a person opens for a ticket", () => {
  function adapterFor(baseUrl: string) {
    return new JiraAdapter({
      baseUrl,
      apiToken: "token",
      projectKey: "PROJ",
      cloudId: CLOUD_ID,
      fetch: mockFetch,
    });
  }

  it("links an issue key on the site's origin, whatever path the Site URL was saved with", () => {
    // Core used to spell this link itself from the raw Site URL, so a site
    // saved as https://acme.atlassian.net/jira linked every run view to
    // /jira/browse/KEY, a page Jira Cloud does not serve.
    expect(adapterFor("https://acme.atlassian.net/jira/").ticketUrl("AWT-42")).toBe(
      "https://acme.atlassian.net/browse/AWT-42",
    );
    expect(adapterFor("https://acme.atlassian.net").ticketUrl("AWT-42")).toBe(
      "https://acme.atlassian.net/browse/AWT-42",
    );
  });

  it("gives no link for a subject key Jira never issued, and asks Jira nothing", () => {
    mockFetch.mockReset();
    const adapter = adapterFor("https://acme.atlassian.net");

    expect(adapter.ticketUrl("pr:acme/api#128")).toBeNull();
    expect(adapter.ticketUrl("webhook-7f3a2c-1a2b3c4d")).toBeNull();
    expect(adapter.ticketUrl("schedule-sch_1-20260923T0400")).toBeNull();
    expect(adapter.ticketUrl("awt-42")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
