import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../env.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
  },
}));

import type {
  IssueTrackerAdapter,
  TicketContent,
} from "../../adapters/issue-tracker/types.js";
import { IssueTrackerNotFoundError } from "../../adapters/issue-tracker/types.js";
import type { Db } from "../../db/client.js";
import { organization } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import type { Adapters } from "../../lib/adapters.js";
import type { ActiveRunEntry } from "../../adapters/run-registry/types.js";
import type { McpActorContext, McpScope } from "../contracts.js";
import { policyFor } from "../policy.js";
import { actorFor, depsFor } from "../test-support.js";
import { registerTicketWriteTools } from "./ticket-write.js";

const TICKET = "PROJ-1";
const KEY_ONE = "11111111-1111-4111-8111-111111111111";
const KEY_TWO = "22222222-2222-4222-8222-222222222222";

// These tools ride tickets:write and nothing else, so running the happy paths with only
// that scope is what proves they are not quietly leaning on mcp:read or runs:dispatch.
const WRITE_ONLY: ReadonlySet<McpScope> = new Set(["tickets:write"]);
const READ_ONLY: ReadonlySet<McpScope> = new Set(["mcp:read"]);

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(organization).values({
    id: "org-execute",
    name: "Execute",
    slug: "execute",
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

function ticketContent(overrides: Partial<TicketContent> = {}): TicketContent {
  return {
    id: "10001",
    identifier: TICKET,
    projectKey: "PROJ",
    title: "Add login page",
    description: "Build a login page",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
    trackerStatus: "Do zrobienia",
    trackerStatusId: "10000",
    attachments: [],
    ...overrides,
  };
}

function fakeIssueTracker(
  overrides: Partial<IssueTrackerAdapter> = {},
): IssueTrackerAdapter {
  return {
    fetchTicket: vi.fn().mockResolvedValue(ticketContent()),
    moveTicket: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue("https://jira.example/browse/PROJ-1?c=1"),
    searchTickets: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** The registry read the transition consults. `undefined` from `get` is how a failed
 *  read is expressed, which the tool must not confuse with "nobody owns it". */
function fakeRunRegistry(entry: ActiveRunEntry | null | "fails" = null) {
  return {
    get:
      entry === "fails"
        ? vi.fn().mockRejectedValue(new Error("registry unreachable"))
        : vi.fn().mockResolvedValue(entry),
  };
}

function ownedBy(runId: string | null): ActiveRunEntry {
  return {
    subjectKey: `ticket:jira:${TICKET}`,
    ticketKey: TICKET,
    ownerToken: "owner-1",
    runId,
    state: "bound",
    kind: "ticket",
    createdAt: 0,
    updatedAt: 0,
  };
}

async function connectedClient(
  issueTracker: IssueTrackerAdapter,
  over: {
    runRegistry?: ReturnType<typeof fakeRunRegistry>;
    actor?: Partial<McpActorContext>;
  } = {},
) {
  const server = new McpServer({ name: "ticket-write-test", version: "0.1.0" });
  registerTicketWriteTools(
    server,
    depsFor(db, () => new Date("2026-08-13T12:00:00.000Z"), {
      actor: actorFor({ scopes: WRITE_ONLY, ...over.actor }),
      adapters: {
        issueTracker,
        runRegistry: over.runRegistry ?? fakeRunRegistry(null),
      } as unknown as Adapters,
    }),
  );
  const client = new Client({ name: "ticket-write-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => client.close(), () => server.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function errorPayload(result: ToolResult): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return (
    JSON.parse(text) as { error: { code: string; message: string; retryable: boolean } }
  ).error;
}

function dataOf(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent as { data: Record<string, unknown> }).data;
}

describe("tickets.comment", () => {
  it("posts the comment and returns the tracker's deep link", async () => {
    const issueTracker = fakeIssueTracker();
    const client = await connectedClient(issueTracker);

    const result = await client.callTool({
      name: "tickets.comment",
      arguments: { ticketKey: "proj-1", body: "Deployed to preview.", idempotencyKey: KEY_ONE },
    });

    expect(dataOf(result)).toEqual({
      // Reported as the tracker spells it, and the key is upper-cased on the way in the
      // way every other ticket-addressed tool does it.
      ticketKey: TICKET,
      commentUrl: "https://jira.example/browse/PROJ-1?c=1",
      alreadyPosted: false,
      scrubbed: false,
    });
    expect(issueTracker.postComment).toHaveBeenCalledWith(TICKET, "Deployed to preview.");
  });

  it("scrubs a body that claims the platform published nothing", async () => {
    const issueTracker = fakeIssueTracker();
    const client = await connectedClient(issueTracker);

    const result = await client.callTool({
      name: "tickets.comment",
      arguments: {
        ticketKey: TICKET,
        body: "The fix is ready. Per the do not publish rule, nothing was pushed.",
        idempotencyKey: KEY_ONE,
      },
    });

    // The same output-side control every other customer-visible artifact goes through:
    // a sentence denying publication is false by construction in a published artifact.
    expect(dataOf(result)).toMatchObject({ scrubbed: true });
    const posted = (issueTracker.postComment as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as string;
    expect(posted).not.toContain("do not publish");
  });

  it("does not post a second copy of a comment the bot already left", async () => {
    const issueTracker = fakeIssueTracker({
      fetchTicket: vi.fn().mockResolvedValue(
        ticketContent({
          comments: [
            {
              author: "AI Workflow",
              accountId: "bot-1",
              body: "Deployed to preview.",
              createdAt: "2026-08-13T11:00:00.000Z",
            },
          ],
        }),
      ),
      getCurrentUserAccountId: vi.fn().mockResolvedValue("bot-1"),
    });
    const client = await connectedClient(issueTracker);

    // A fresh key, so the idempotency store lets it through: the tracker itself is what
    // refuses the duplicate, which is the only thing that survives a lost reply.
    const result = await client.callTool({
      name: "tickets.comment",
      arguments: { ticketKey: TICKET, body: "Deployed to preview.", idempotencyKey: KEY_TWO },
    });

    expect(dataOf(result)).toMatchObject({ alreadyPosted: true, commentUrl: null });
    expect(issueTracker.postComment).not.toHaveBeenCalled();
  });

  it("still posts when the identical comment came from somebody else", async () => {
    const issueTracker = fakeIssueTracker({
      fetchTicket: vi.fn().mockResolvedValue(
        ticketContent({
          comments: [
            {
              author: "Filip",
              accountId: "human-1",
              body: "Deployed to preview.",
              createdAt: "2026-08-13T11:00:00.000Z",
            },
          ],
        }),
      ),
      getCurrentUserAccountId: vi.fn().mockResolvedValue("bot-1"),
    });
    const client = await connectedClient(issueTracker);

    const result = await client.callTool({
      name: "tickets.comment",
      arguments: { ticketKey: TICKET, body: "Deployed to preview.", idempotencyKey: KEY_ONE },
    });

    // The check exists to stop the bot duplicating ITSELF. A human saying the same thing
    // is not a duplicate the tool may swallow, or the caller would be told its comment
    // is on the ticket when its own words never appeared.
    expect(dataOf(result)).toMatchObject({ alreadyPosted: false });
    expect(issueTracker.postComment).toHaveBeenCalled();
  });

  it("reports an unknown ticket as NOT_FOUND and writes nothing", async () => {
    const issueTracker = fakeIssueTracker({
      fetchTicket: vi.fn().mockRejectedValue(new IssueTrackerNotFoundError("Issue", TICKET)),
    });
    const client = await connectedClient(issueTracker);

    const result = await client.callTool({
      name: "tickets.comment",
      arguments: { ticketKey: TICKET, body: "Anything", idempotencyKey: KEY_ONE },
    });

    expect(errorPayload(result).code).toBe("NOT_FOUND");
    expect(issueTracker.postComment).not.toHaveBeenCalled();
  });

  it("refuses a token without the ticket scope", async () => {
    const issueTracker = fakeIssueTracker();
    const client = await connectedClient(issueTracker, {
      actor: { scopes: READ_ONLY },
    });

    const result = await client.callTool({
      name: "tickets.comment",
      arguments: { ticketKey: TICKET, body: "Anything", idempotencyKey: KEY_ONE },
    });

    // The whole point of the new scope: a token minted to read tickets and fire runs has
    // not thereby been granted the right to write into a customer's tracker.
    expect(errorPayload(result).code).toBe("INSUFFICIENT_SCOPE");
    expect(issueTracker.postComment).not.toHaveBeenCalled();
    expect(policyFor("tickets.comment").scope).toBe("tickets:write");
  });
});

describe("tickets.transition", () => {
  async function transition(
    client: Client,
    over: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    return client.callTool({
      name: "tickets.transition",
      arguments: { ticketKey: TICKET, target: "Ai", idempotencyKey: KEY_ONE, ...over },
    });
  }

  it("moves a ticket nobody is working on", async () => {
    const issueTracker = fakeIssueTracker({
      fetchTicket: vi
        .fn()
        .mockResolvedValueOnce(ticketContent({ trackerStatus: "Do zrobienia" }))
        .mockResolvedValue(ticketContent({ trackerStatus: "Ai" })),
    });
    const client = await connectedClient(issueTracker);

    const result = await transition(client);

    expect(dataOf(result)).toEqual({
      ticketKey: TICKET,
      statusBefore: "Do zrobienia",
      // Read back rather than assumed from the target, because a board may land a
      // transition in a status whose name differs from the transition's.
      statusAfter: "Ai",
      alreadyAtTarget: false,
    });
    expect(issueTracker.moveTicket).toHaveBeenCalledWith(TICKET, "Ai");
  });

  it("refuses while a run owns the ticket and names it", async () => {
    const issueTracker = fakeIssueTracker();
    const client = await connectedClient(issueTracker, {
      runRegistry: fakeRunRegistry(ownedBy("wrun_live")),
    });

    const result = await transition(client);

    const error = errorPayload(result);
    expect(error.code).toBe("CONFLICT");
    expect(error.retryable).toBe(false);
    // Names the run and the way out, because moving the ticket now would cancel it: the
    // webhook reads a move out of the AI column as a human abort.
    expect(error.message).toContain("wrun_live");
    expect(error.message).toContain("runs.cancel");
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
  });

  it("refuses when it cannot tell whether a run owns the ticket", async () => {
    const issueTracker = fakeIssueTracker();
    const client = await connectedClient(issueTracker, {
      runRegistry: fakeRunRegistry("fails"),
    });

    const result = await transition(client);

    // An unknown answer must stop the write. Reading a failed lookup as "nobody owns it"
    // is exactly how an agent would cancel somebody's run by accident.
    expect(errorPayload(result)).toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: true,
    });
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
  });

  it("writes nothing when the ticket is already at the target", async () => {
    const issueTracker = fakeIssueTracker({
      fetchTicket: vi.fn().mockResolvedValue(ticketContent({ trackerStatus: "Ai" })),
    });
    const client = await connectedClient(issueTracker);

    const result = await transition(client);

    expect(dataOf(result)).toMatchObject({
      alreadyAtTarget: true,
      statusBefore: "Ai",
      statusAfter: "Ai",
    });
    expect(issueTracker.moveTicket).not.toHaveBeenCalled();
  });

  it("names the statuses that do resolve when the target does not", async () => {
    const issueTracker = fakeIssueTracker({
      moveTicket: vi.fn().mockRejectedValue(new Error("No transition to \"AI Backlog\"")),
      resolveMoveTargetStatus: vi.fn().mockResolvedValue(null),
      listStatuses: vi
        .fn()
        .mockResolvedValue([
          { id: "1", name: "Do zrobienia" },
          { id: "2", name: "Ai" },
          { id: "3", name: "Weryfikacja" },
        ]),
    });
    const client = await connectedClient(issueTracker);

    const result = await transition(client, { target: "AI Backlog" });

    const error = errorPayload(result);
    expect(error.code).toBe("VALIDATION_FAILED");
    // Status names are per project and not guessable, so the refusal carries the ones
    // that exist instead of leaving the agent to try spellings.
    expect(error.message).toContain("Weryfikacja");
    expect(error.message).toContain("Ai");
  });

  it("replays an identical retry instead of moving twice", async () => {
    const issueTracker = fakeIssueTracker({
      fetchTicket: vi
        .fn()
        .mockResolvedValueOnce(ticketContent({ trackerStatus: "Do zrobienia" }))
        .mockResolvedValue(ticketContent({ trackerStatus: "Ai" })),
    });
    const client = await connectedClient(issueTracker);
    const first = await transition(client);

    const second = await transition(client);

    expect(dataOf(second)).toEqual(dataOf(first));
    expect(issueTracker.moveTicket).toHaveBeenCalledTimes(1);
  });

  it("is marked destructive, unlike the other two ticket writes", async () => {
    // It is the one ticket write that can take a running job away, and a client choosing
    // what it may probe with reads exactly this hint.
    expect(policyFor("tickets.transition").annotations.destructiveHint).toBe(true);
    expect(policyFor("tickets.comment").annotations.destructiveHint).toBe(false);
    expect(policyFor("tickets.create").annotations.destructiveHint).toBe(false);
  });
});

describe("tickets.create", () => {
  async function create(
    client: Client,
    over: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    return client.callTool({
      name: "tickets.create",
      arguments: { summary: "Fix the login redirect", idempotencyKey: KEY_ONE, ...over },
    });
  }

  it("creates the ticket carrying its own idempotency marker", async () => {
    const createTicket = vi
      .fn()
      .mockResolvedValue({ identifier: "PROJ-9", url: "https://jira.example/browse/PROJ-9" });
    const issueTracker = fakeIssueTracker({
      createTicket,
      fetchTicket: vi
        .fn()
        .mockResolvedValue(ticketContent({ identifier: "PROJ-9", trackerStatus: "Do zrobienia" })),
    });
    const client = await connectedClient(issueTracker);

    const result = await create(client, { labels: ["mcp-demo"] });

    expect(dataOf(result)).toEqual({
      ticketKey: "PROJ-9",
      url: "https://jira.example/browse/PROJ-9",
      // Reported so the caller knows where the project's workflow put it, and therefore
      // what to pass to tickets.transition to start a run.
      status: "Do zrobienia",
      alreadyCreated: false,
    });
    const passed = createTicket.mock.calls[0]?.[0] as { labels: string[] };
    // The marker is written WITH the ticket: added afterwards, a crash in between would
    // leave an unmarked duplicate that the next attempt cannot recognise.
    expect(passed.labels).toContain("mcp-demo");
    expect(passed.labels.some((label) => label.startsWith("mcp-"))).toBe(true);
    expect(passed.labels).toHaveLength(2);
  });

  it("returns the ticket a previous attempt already created", async () => {
    const createTicket = vi.fn();
    const issueTracker = fakeIssueTracker({
      createTicket,
      searchTickets: vi.fn().mockResolvedValue(["PROJ-7"]),
      fetchTicket: vi
        .fn()
        .mockResolvedValue(ticketContent({ identifier: "PROJ-7", trackerStatus: "Ai" })),
    });
    const client = await connectedClient(issueTracker);

    // A different key would be a different ticket by definition, so this asserts the
    // marker path: the same key finds its own earlier ticket in the tracker.
    const result = await create(client, { idempotencyKey: KEY_TWO });

    expect(dataOf(result)).toMatchObject({ ticketKey: "PROJ-7", alreadyCreated: true });
    expect(createTicket).not.toHaveBeenCalled();
    const jql = (issueTracker.searchTickets as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(jql).toContain("labels = ");
  });

  it("creates nothing when the marker search fails", async () => {
    const createTicket = vi.fn();
    const issueTracker = fakeIssueTracker({
      createTicket,
      searchTickets: vi.fn().mockRejectedValue(new Error("search unavailable")),
    });
    const client = await connectedClient(issueTracker);

    const result = await create(client);

    // Creating blind would risk a duplicate ticket, and a duplicate ticket moved into
    // the AI column later starts a second run on the same work.
    expect(errorPayload(result)).toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: true,
    });
    expect(createTicket).not.toHaveBeenCalled();
  });

  it("says so plainly when the configured tracker cannot create tickets", async () => {
    // createTicket is optional on the adapter, because the platform's own work never
    // creates tickets: it reacts to ones people file.
    const client = await connectedClient(fakeIssueTracker());

    const result = await create(client);

    expect(errorPayload(result).code).toBe("VALIDATION_FAILED");
    expect(errorPayload(result).message).toContain("cannot create tickets");
  });

  it("admits an unattended automation", async () => {
    const issueTracker = fakeIssueTracker({
      createTicket: vi.fn().mockResolvedValue({ identifier: "PROJ-9", url: null }),
    });
    const client = await connectedClient(issueTracker, {
      actor: { role: "service", kind: "service", userId: null, scopes: WRITE_ONLY },
    });

    // Unlike answering a clarification, a ticket write addresses nobody: the platform
    // does this on every run with no human behind it, which is why the service role
    // stays on the list and the scope is not stripped from a service token.
    expect(dataOf(await create(client))).toMatchObject({ ticketKey: "PROJ-9" });
    expect(policyFor("tickets.create").roles).toContain("service");
  });
});
