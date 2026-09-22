/**
 * The two readers this stage exists for, against the same rows.
 *
 * A dashboard that can read something MCP cannot is a failed stage, so the
 * tests here call the ROUTE and the TOOL for the same page and compare the
 * bytes, including on a briefing larger than the MCP result cap. The second
 * half is the other identity: a page of stored text has to pass MCP's
 * serve-time sanitizer unchanged, including when a page boundary falls inside
 * a pattern that sanitizer rewrites.
 *
 * Stage 3b is not in this worktree, so every row was seeded through
 * `recordAgentBriefing`, which is the function the send steps will call.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown, sessionUserId: "user_member" as string | null }));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_MAX_REQUEST_BYTES: 1_048_576,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
    DASHBOARD_ORG_SLUG: "visibility",
    DASHBOARD_ORG_NAME: "Visibility",
  },
}));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../services/auth/auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () =>
        state.sessionUserId ? { user: { id: state.sessionUserId }, session: { id: "s" } } : null,
      ),
    },
  },
}));
vi.mock("../../services/auth/request-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/auth/request-context.js")>();
  return {
    ...actual,
    // The dashboard actor resolution is a whole auth stack of its own and is
    // not what these tests are about: what they are about is that the route
    // and the tool, given the SAME audience, answer the same bytes.
    requireDashboardActor: async () => ({
      organizationId: "org-visibility",
      userId: "user_member",
      role: "member",
    }),
  };
});

import {
  agentBriefingOverviewSchema,
  pageSectionText,
  readVisibilityRecord,
} from "@shared/agent-visibility";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import {
  captureBriefing,
  seedAttempt,
  seedDefinitionNodes,
  seedRun,
  seedVisibilityWorld,
  VISIBILITY_ORG,
  type SeededWorld,
} from "../../test-support/agent-visibility.js";
import { sanitizeMcpData } from "../sanitize-result.js";
import { registerBriefingTools } from "./briefings.js";
import { mcpPageBounds } from "./page-budget.js";

const briefingsGet = (await import("../../routes/api/v1/runs/[runId]/briefings.get.js")).default;
const sectionsGet = (
  await import("../../routes/api/v1/runs/[runId]/briefings/[briefingId]/sections.get.js")
).default;
const sectionGet = (
  await import("../../routes/api/v1/runs/[runId]/briefings/[briefingId]/sections/[sectionIndex].get.js")
).default;
const partsGet = (
  await import(
    "../../routes/api/v1/runs/[runId]/briefings/[briefingId]/sections/[sectionIndex]/parts.get.js"
  )
).default;
const unresolvedGet = (
  await import("../../routes/api/v1/runs/[runId]/briefings/[briefingId]/unresolved-sources.get.js")
).default;
const spansGet = (
  await import(
    "../../routes/api/v1/runs/[runId]/briefings/[briefingId]/sections/[sectionIndex]/spans.get.js"
  )
).default;
const contextGet = (
  await import("../../routes/api/v1/runs/[runId]/briefings/[briefingId]/repository-context.get.js")
).default;
const nodeLastGet = (
  await import(
    "../../routes/api/v1/workflow-definitions/[id]/nodes/[nodeId]/last-briefing.get.js"
  )
).default;

const RUN = "wrun_parity";
const NOW = new Date("2026-09-19T12:00:00.000Z");

let db: Db;
let world: SeededWorld;
const cleanups: (() => Promise<void>)[] = [];

/**
 * Stored text carrying every shape MCP's serve-time sanitizer rewrites, plus
 * the two it rewrites only when it sees the whole of them.
 *
 * Capture is supposed to leave text this function cannot change. The point of
 * putting the hostile shapes in is that a page CUT OUT of the stored text must
 * be a fixed point too: a GitHub token past 255 characters matches nothing
 * whole and would match a page that ends inside it, and a private key header
 * with no END line runs to the end of whatever string is served.
 */
const HOSTILE = [
  "A support ticket pasted a key: -----BEGIN RSA PRIVATE KEY-----MIIBOgIBAAJBAK-----END RSA PRIVATE KEY----- and carried on.",
  "and then the header Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 on its own line",
  `a long github token ghp_${"A".repeat(300)} in the middle of a sentence`,
  "an ANSI colour \u001B[31mred\u001B[0m and a bell \u0007 and a NUL \u0000 here",
  "a lone surrogate \uD800 and a tab\tand a newline are all different cases",
  "a DEL \u007F and an astral pair \u{1F680}\u{1F680}\u{1F680} whose four bytes a page must never split",
  "somebody typed the marker [REDACTED] themselves, in a Jira comment, and it must survive",
  "a github token too short to be one, ghp_abcdef, stays exactly as the agent read it",
  "the Authorization header is discussed at length here without a value after it",
  ...Array.from(
    { length: 40 },
    (_unused, line) => `${line}: ordinary prose the agent was really given, about the empty cart.`,
  ),
].join("\n");

function handler() {
  const app = createApp();
  const router = createRouter();
  router.get("/runs/:runId/briefings", briefingsGet);
  router.get("/runs/:runId/briefings/:briefingId/sections", sectionsGet);
  router.get("/runs/:runId/briefings/:briefingId/sections/:sectionIndex", sectionGet);
  router.get("/runs/:runId/briefings/:briefingId/sections/:sectionIndex/parts", partsGet);
  router.get("/runs/:runId/briefings/:briefingId/unresolved-sources", unresolvedGet);
  router.get("/runs/:runId/briefings/:briefingId/sections/:sectionIndex/spans", spansGet);
  router.get("/runs/:runId/briefings/:briefingId/repository-context", contextGet);
  router.get("/workflow-definitions/:id/nodes/:nodeId/last-briefing", nodeLastGet);
  app.use(router);
  return toWebHandler(app);
}

async function route(path: string): Promise<unknown> {
  const response = await handler()(new Request(`http://worker.test${path}`));
  const body = await response.text();
  if (!response.ok) throw new RangeError(`${response.status} ${body}`);
  return JSON.parse(body);
}

async function client(): Promise<Client> {
  const server = new McpServer({ name: "briefings-test", version: "0.1.0" });
  registerBriefingTools(
    server,
    depsFor(db, () => NOW, {
      actor: actorFor({ organizationId: VISIBILITY_ORG, scopes: new Set(["mcp:read"]) }),
    }),
  );
  const connected = new Client({ name: "briefings-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => connected.close(), () => server.close());
  await server.connect(serverTransport);
  await connected.connect(clientTransport);
  return connected;
}

async function tool(connected: Client, args: Record<string, unknown>): Promise<unknown> {
  return named(connected, "runs.briefing", args);
}

async function named(
  connected: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await connected.callTool({ name, arguments: args });
  const failed = result.isError === true;
  if (failed) throw new RangeError((result.content as { text: string }[])[0]!.text);
  return (result.structuredContent as { data: unknown }).data;
}

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  world = await seedVisibilityWorld(db);
  await seedRun(db, {
    runId: RUN,
    world,
    // TWO nodes, so the attempts list has a second entry and `nextCursor` is
    // not null: the cursor is a string MCP rewrites on its way out, and a
    // one-node fixture never compares one.
    nodes: { planning: "planning_agent", review: "review_agent" },
    status: "failed",
    // The failure a missing reason quotes. It never met the capture detector,
    // so an un-normalized copy would reach MCP and be rewritten there.
    statusReason:
      "the sandbox died: \u001B[31mFATAL\u001B[0m while cloning with ghp_" + "C".repeat(300),
  });
  await seedAttempt(db, {
    runId: RUN,
    nodeId: "review",
    state: "failed",
    outcome: { kind: "failed", status: "sandbox_unavailable" },
    startedAt: new Date("2026-09-19T10:30:00.000Z"),
  });
}, 120_000);

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** A section text comfortably past the MCP result cap once its index is beside
 *  it, built from varied lines so nothing compresses it away. */
function hugeText(): string {
  const lines: string[] = [];
  for (let line = 0; lines.join("\n").length < 520_000; line += 1) {
    lines.push(`${line}: the checkout button does nothing when the cart is empty and the user is new.`);
  }
  return lines.join("\n");
}

async function seedBriefing(text: string): Promise<number> {
  const recorded = await captureBriefing(db, {
    runId: RUN,
    sections: [
      { kind: "runtime", title: "Runtime data", text },
      { kind: "block", title: "Block role", text: "Plan the change." },
    ],
    unresolvedSources: [
      { kind: "repository_instructions", reference: "acme/api:AGENTS.md", message: "not found" },
    ],
    repositoryContext: {
      repositories: [
        {
          key: "github:acme/api",
          description: { source: "operator", text: "The checkout API." },
          rules: "Never touch the ledger tables.",
          relationships: [{ kind: "backend_for", target: "github:acme/web" }],
          state: "selected",
          inclusion: { cause: "named_in_ticket" },
          rendering: "full",
          workScopeEntry: null,
        },
        {
          key: "github:acme/web",
          description: { source: "provider", text: "The storefront." },
          rules: null,
          relationships: [],
          state: "excluded",
          reason: "a person kept it out",
          inclusion: { cause: "related", via: { key: "github:acme/api", relationship: "backend_for" } },
          rendering: "summary",
          workScopeEntry: null,
        },
      ],
      unlistedCount: 40,
      workScope: { version: 3, leftOutKeys: ["github:acme/legacy"] },
    },
  });
  if (recorded.outcome !== "recorded") throw new Error(`fixture: ${JSON.stringify(recorded)}`);
  return recorded.briefingId;
}

describe("one briefing, two readers", () => {
  // Red when: a route and a tool drift apart for the same question, which is
  // the whole failure mode this stage exists to prevent. Compared as JSON
  // text, so a field present on one side and `null` on the other fails here.
  it("returns the same bytes from the route and the tool, over the MCP cap", async () => {
    const text = hugeText();
    const briefingId = await seedBriefing(text);
    const connected = await client();
    const base = `/runs/${RUN}/briefings/${briefingId}`;

    const listRoute = (await route(`/runs/${RUN}/briefings`)) as {
      items: { nodeId: string; missing: { failure?: { message: string } } | null }[];
    };
    const listTool = await tool(connected, { runId: RUN });
    expect(JSON.stringify(listTool)).toBe(JSON.stringify(listRoute));
    // The missing reason quotes the run's recorded failure. Compared byte for
    // byte above; asserted here so a reason that stopped being produced at all
    // cannot keep this test green.
    const failed = listRoute.items.find((item) => item.nodeId === "review")!;
    expect(failed.missing).not.toBeNull();
    expect(failed.missing!.failure!.message).toContain("the sandbox died");
    expect(failed.missing!.failure!.message).not.toContain("\u001B");
    expect(failed.missing!.failure!.message).not.toContain("ghp_CCCC");

    const sectionsRoute = await route(`${base}/sections`);
    const sectionsTool = await tool(connected, { runId: RUN, view: "sections", briefingId });
    expect(JSON.stringify(sectionsTool)).toBe(JSON.stringify(sectionsRoute));

    const partsRoute = await route(`${base}/sections/0/parts`);
    const partsTool = await tool(connected, { runId: RUN, view: "parts", briefingId, sectionIndex: 0 });
    expect(JSON.stringify(partsTool)).toBe(JSON.stringify(partsRoute));

    const spansRoute = await route(`${base}/sections/0/spans`);
    const spansTool = await tool(connected, { runId: RUN, view: "spans", briefingId, sectionIndex: 0 });
    expect(JSON.stringify(spansTool)).toBe(JSON.stringify(spansRoute));

    // The one view parsed out of a SEPARATELY stored document, so the likeliest
    // of all of them to diverge between the two readers.
    const contextRoute = (await route(`${base}/repository-context`)) as {
      unlistedCount: number;
      workScope: { version: number; leftOutKeys: string[] } | null;
      repositories: { total: number; items: { key: string; state: string }[] };
    };
    const contextTool = await tool(connected, {
      runId: RUN,
      view: "repository_context",
      briefingId,
    });
    expect(JSON.stringify(contextTool)).toBe(JSON.stringify(contextRoute));
    expect(contextRoute.unlistedCount).toBe(40);
    expect(contextRoute.workScope).toEqual({ version: 3, leftOutKeys: ["github:acme/legacy"] });
    expect(contextRoute.repositories.total).toBe(2);
    expect(contextRoute.repositories.items.map((entry) => entry.key)).toEqual([
      "github:acme/api",
      "github:acme/web",
    ]);

    const unresolvedRoute = await route(`${base}/unresolved-sources`);
    const unresolvedTool = await tool(connected, {
      runId: RUN,
      view: "unresolved_sources",
      briefingId,
    });
    expect(JSON.stringify(unresolvedTool)).toBe(JSON.stringify(unresolvedRoute));

    // The whole section, page by page, on both surfaces at once.
    let offset: number | null = 0;
    let fromRoute = "";
    let fromTool = "";
    let pages = 0;
    while (offset !== null) {
      const page = (await route(`${base}/sections/0?offset=${offset}&limit=65536`)) as {
        text: string;
        nextOffset: number | null;
      };
      const viaTool = await tool(connected, {
        runId: RUN,
        view: "section",
        briefingId,
        sectionIndex: 0,
        offset,
        limit: 65_536,
      });
      expect(JSON.stringify(viaTool)).toBe(JSON.stringify(page));
      fromRoute += page.text;
      fromTool += (viaTool as { text: string }).text;
      offset = page.nextOffset;
      pages += 1;
    }

    expect(pages).toBeGreaterThan(7);
    expect(fromRoute).toBe(text.slice(0, fromRoute.length));
    expect(fromTool).toBe(fromRoute);
    expect(Buffer.byteLength(fromRoute, "utf8")).toBeGreaterThan(500_000);
  }, 300_000);

  // Red when: the cursor a list hands out does not survive the transport that
  // hands it out. MCP rewrites every string it serves, so a key joined on a
  // character the sanitizer deletes reaches an agent altered, and feeding it
  // back answers "the cursor names an entry this list no longer has": every run
  // whose attempts do not fit one page is unpageable, forever, and the message
  // blames the caller. Both pages are taken from the TOOL, never the route.
  it("pages the attempts list over MCP, on a cursor the transport does not touch", async () => {
    await seedBriefing("short");
    const connected = await client();

    const first = (await tool(connected, { runId: RUN, limit: 1_400 })) as {
      items: { nodeId: string }[];
      nextCursor: string | null;
      total: number;
    };
    expect(first.nextCursor).not.toBeNull();
    const second = (await tool(connected, {
      runId: RUN,
      limit: 1_400,
      cursor: first.nextCursor,
    })) as { items: { nodeId: string }[]; nextCursor: string | null };

    const served = [...first.items, ...second.items].map((item) => item.nodeId);
    expect(new Set(served).size).toBe(served.length);
    expect(served.length).toBe(first.total);
    // And the cursor really did cross the sanitizer untouched.
    const envelope = sanitizeMcpData(first, {
      requestId: "r",
      traceId: "t",
      trust: "external_untrusted",
      maxBytes: 524_288,
      secrets: [],
    });
    expect(envelope.meta.redactions).toBe(0);
    expect((envelope.data as { nextCursor: string }).nextCursor).toBe(first.nextCursor);
  }, 300_000);

  // Red when: a page of stored text is rewritten on its way out over MCP, so
  // the terminal and the screen show different prompts. The boundary walk is
  // the part a whole-text test cannot catch.
  it("passes the serve-time sanitizer unchanged, on every page boundary", async () => {
    const briefingId = await seedBriefing(HOSTILE);
    const sanitize = (value: unknown) =>
      sanitizeMcpData(value, {
        requestId: "r",
        traceId: "t",
        trust: "external_untrusted",
        maxBytes: 524_288,
        secrets: [],
      }).data;

    const stored = (await route(
      `/runs/${RUN}/briefings/${briefingId}/sections/0?limit=524288`,
    )) as { text: string; totalBytes: number; nextOffset: number | null };
    expect(stored.nextOffset).toBeNull();
    expect(JSON.stringify(sanitize(stored))).toBe(JSON.stringify(stored));
    // The detector left the things a person typed and took the credentials.
    expect(stored.text).toContain("ghp_abcdef,");
    expect(stored.text).toContain("somebody typed the marker [REDACTED] themselves");
    expect(stored.text).not.toContain("PRIVATE KEY");
    expect(stored.text).not.toContain("ghp_AAAA");

    // EVERY page boundary, one byte at a time. The route is `pageSectionText`
    // over exactly this stored text, so the walk runs the package function on
    // the bytes the route just proved it serves: a route call per offset would
    // be several thousand reads of the same row for the same answer. Two of
    // the offsets are then taken back through the route and the tool, so the
    // claim that they are the same bytes is not left to the argument.
    let cuts = 0;
    for (let offset = 0; offset <= stored.totalBytes; offset += 1) {
      let page: unknown;
      try {
        page = pageSectionText({ sectionIndex: 0, text: stored.text, offset, maxBytes: 1_024 });
      } catch (error) {
        // An offset inside a character is refused, never snapped.
        expect((error as Error).message).toContain("inside a character");
        continue;
      }
      expect(JSON.stringify(sanitize(page))).toBe(JSON.stringify(page));
      cuts += 1;
    }
    // Every offset but the ones inside a character, and there ARE such offsets:
    // the corpus carries astral pairs precisely so the walk tries to cut one.
    expect(cuts).toBeGreaterThan(stored.totalBytes - 40);
    expect(cuts).toBeLessThan(stored.totalBytes + 1);
    expect(stored.totalBytes).toBeGreaterThan(2_000);

    const connected = await client();
    for (const offset of [0, Math.floor(stored.totalBytes / 2)]) {
      const viaRoute = await route(
        `/runs/${RUN}/briefings/${briefingId}/sections/0?offset=${offset}&limit=1024`,
      );
      const viaTool = await tool(connected, {
        runId: RUN,
        view: "section",
        briefingId,
        sectionIndex: 0,
        offset,
        limit: 1_024,
      });
      expect(JSON.stringify(viaTool)).toBe(JSON.stringify(viaRoute));
      expect(JSON.stringify(sanitize(viaRoute))).toBe(JSON.stringify(viaRoute));
      expect(JSON.stringify(viaRoute)).toBe(
        JSON.stringify(pageSectionText({ sectionIndex: 0, text: stored.text, offset, maxBytes: 1_024 })),
      );
    }
  }, 300_000);

  // Red when: our own shapes trip the digest, which replaces a briefing with
  // `sha256:...` and makes this feature useless exactly when it is needed.
  it("never lets a page become a digest, at the largest page it will serve", async () => {
    const briefingId = await seedBriefing(hugeText());
    const bounds = mcpPageBounds(
      depsFor(db, () => NOW).settings,
    );
    const connected = await client();

    const page = await tool(connected, {
      runId: RUN,
      view: "section",
      briefingId,
      sectionIndex: 0,
      limit: bounds.maximum,
    });
    const envelope = sanitizeMcpData(page, {
      requestId: "r",
      traceId: "t",
      trust: "external_untrusted",
      maxBytes: 524_288,
      secrets: [],
    });

    expect(envelope.meta.truncated).toBe(false);
    expect((envelope.data as { digest?: string }).digest).toBeUndefined();
  }, 300_000);

  // Red when: the tool clamps a caller's request instead of refusing it, so an
  // agent believes it read a whole page and read part of one.
  it("refuses a page larger than the transport can carry, by name", async () => {
    const briefingId = await seedBriefing("short");
    const connected = await client();

    const error = await tool(connected, {
      runId: RUN,
      view: "section",
      briefingId,
      sectionIndex: 0,
      limit: 524_288,
    }).catch((e: Error) => e.message);

    expect(String(error)).toContain("VALIDATION_FAILED");
    expect(String(error)).toContain("at most");
  }, 120_000);

  // Red when: a view that needs a briefingId is called without one and answers
  // an internal error instead of naming what it wanted.
  it("names the field a view needs when a call omits it", async () => {
    const connected = await client();

    const error = await tool(connected, { runId: RUN, view: "sections" }).catch((e: Error) => e.message);

    expect(String(error)).toContain("needs a briefingId");
  }, 120_000);

  // Red when: an optional field absent from a record reaches an agent as
  // `null`, which every frozen schema refuses, so the dashboard's per-record
  // parse drops the entry with an error nobody can act on.
  it("emits no null where the record simply has no such field", async () => {
    const briefingId = await seedBriefing("short");
    const connected = await client();

    const overview = (
      (await tool(connected, { runId: RUN })) as {
        items: { briefings: { overview: Record<string, unknown> }[] }[];
      }
    ).items[0]!.briefings[0]!.overview;
    const identity = overview.identity as Record<string, unknown>;

    // An optional field the send never carried is ABSENT. Were it present as
    // `undefined`, MCP's sanitizer would serve it as `null` here, and the
    // frozen schema below would refuse the record: the dashboard's per-record
    // parse is exactly this call, and a refusal there is an entry that
    // disappears from the screen with an error nobody can act on.
    expect("passLabel" in identity).toBe(false);
    const read = readVisibilityRecord(agentBriefingOverviewSchema, overview);
    expect(read.ok).toBe(true);
    expect(briefingId).toBeGreaterThan(0);
  }, 120_000);

  // Red when: the operator's view of a block and an agent's view of the same
  // block differ. This read is addressed from the definition rather than from
  // a run, so it is a second door onto the same rows, and a second door is
  // where parity quietly stops holding.
  it("serves one block's last briefing identically to both surfaces", async () => {
    await seedDefinitionNodes(db, world, [
      { id: "planning", type: "planning_agent" },
      { id: "review", type: "review_agent" },
    ]);
    await seedBriefing("A short runtime section.");
    const connected = await client();

    const viaRoute = (await route(
      `/workflow-definitions/${world.definitionId}/nodes/planning/last-briefing`,
    )) as { ranIn: { runId: string } | null; attempt: { briefings: unknown[] } | null };
    const viaTool = await named(connected, "workflows.node_briefing", {
      definitionId: world.definitionId,
      nodeId: "planning",
    });

    expect(JSON.stringify(viaTool)).toBe(JSON.stringify(viaRoute));
    expect(viaRoute.ranIn?.runId).toBe(RUN);
    expect(viaRoute.attempt?.briefings).toHaveLength(1);

    // The block that never sent one, through the same two doors.
    const emptyRoute = (await route(
      `/workflow-definitions/${world.definitionId}/nodes/review/last-briefing`,
    )) as { attempt: { missing: { kind: string } | null } | null };
    const emptyTool = await named(connected, "workflows.node_briefing", {
      definitionId: world.definitionId,
      nodeId: "review",
    });

    expect(JSON.stringify(emptyTool)).toBe(JSON.stringify(emptyRoute));
    expect(emptyRoute.attempt?.missing?.kind).toBe("never_sent");
  }, 300_000);
});
