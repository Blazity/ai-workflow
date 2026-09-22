/**
 * The clarification rounds, through both surfaces.
 *
 * Two things are under test and neither is about a briefing. First, that
 * `work_scope.get` answers a caller that did not ask for rounds exactly the
 * object it always answered, key for key: other people parse it. Second, that
 * a round reaches a terminal and a screen as the same bytes, INCLUDING the
 * question, which is the field that never met the capture detector on the way
 * in and which MCP would otherwise rewrite on the way out.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApp, createRouter, toWebHandler } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));

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
vi.mock("../../services/auth/request-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/auth/request-context.js")>();
  return {
    ...actual,
    requireDashboardActor: async () => ({
      organizationId: "org-visibility",
      userId: "user_member",
      role: "member",
    }),
  };
});

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { recordAnswerDelivery } from "../../services/agent-visibility/deliveries.js";
import { actorFor, depsFor } from "../../test-support/mcp.js";
import {
  CAPTURED_AT,
  detector,
  seedClarification,
  seedRun,
  seedTrailEvent,
  seedVisibilityWorld,
  VISIBILITY_ORG,
  type SeededWorld,
} from "../../test-support/agent-visibility.js";
import { registerWorkScopeTools } from "./work-scope.js";

const workScopeGet = (await import("../../routes/api/v1/work-scope.get.js")).default;
const deliveriesGet = (
  await import("../../routes/api/v1/work-scope/rounds/[roundId]/deliveries.get.js")
).default;
const effectsGet = (
  await import("../../routes/api/v1/work-scope/rounds/[roundId]/effects.get.js")
).default;

const RUN = "wrun_ws_rounds";
const SUBJECT = "ticket:jira:AWP-235";
const ASK = "cl_round_one";
const NOW = new Date("2026-09-20T09:00:00.000Z");

let db: Db;
let world: SeededWorld;
const cleanups: (() => Promise<void>)[] = [];

function handler() {
  const app = createApp();
  const router = createRouter();
  router.get("/work-scope", workScopeGet);
  router.get("/work-scope/rounds/:roundId/deliveries", deliveriesGet);
  router.get("/work-scope/rounds/:roundId/effects", effectsGet);
  app.use(router);
  return toWebHandler(app);
}

async function route(path: string): Promise<unknown> {
  const response = await handler()(new Request(`http://worker.test${path}`));
  const body = await response.text();
  const failed = !response.ok;
  if (failed) throw new RangeError(`${response.status} ${body}`);
  return JSON.parse(body);
}

async function rawTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: "ws-rounds-test", version: "0.1.0" });
  registerWorkScopeTools(
    server,
    depsFor(db, () => NOW, {
      actor: actorFor({ organizationId: VISIBILITY_ORG, scopes: new Set(["mcp:read"]) }),
    }),
  );
  const connected = new Client({ name: "ws-rounds-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => connected.close(), () => server.close());
  await server.connect(serverTransport);
  await connected.connect(clientTransport);
  const result = await connected.callTool({ name: "work_scope.get", arguments: args });
  const failed = result.isError === true;
  if (failed) throw new RangeError((result.content as { text: string }[])[0]!.text);
  return result;
}

async function tool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await rawTool(args);
  return (result.structuredContent as { data: Record<string, unknown> }).data;
}

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  world = await seedVisibilityWorld(db);
  await seedRun(db, { runId: RUN, world });
  await seedClarification(db, {
    id: ASK,
    runId: RUN,
    subjectKey: SUBJECT,
    // The colour code is the point: it never met the capture detector, and
    // MCP strips it on the way out unless we normalize it first.
    questions: ["Which repository? The build printed \u001B[31mFAILED\u001B[0m."],
    askedAt: CAPTURED_AT,
    offered: [{ repositoryKey: "github:acme/api", askedBecause: "selection", named: true }],
  });
  await seedTrailEvent(db, {
    subjectKey: SUBJECT,
    runId: RUN,
    kind: "question_asked",
    event: { kind: "question_asked", clarificationId: ASK, purpose: "which_repository" },
    at: CAPTURED_AT,
  });
  await seedTrailEvent(db, {
    subjectKey: SUBJECT,
    runId: RUN,
    kind: "entry_written",
    event: { kind: "entry_written", clarificationId: ASK, repositoryKey: "github:acme/api" },
    at: new Date(CAPTURED_AT.getTime() + 60_000),
  });
  for (let arrival = 0; arrival < 5; arrival += 1) {
    await recordAnswerDelivery(
      {
        clarificationId: ASK,
        runId: RUN,
        words: "the api one",
        author: { kind: "person", display: "Ada Lovelace" },
        surface: "jira",
        reading: null,
        note: null,
        at: new Date(CAPTURED_AT.getTime() + arrival * 1_000),
      },
      { db, sanitize: detector },
    );
  }
}, 120_000);

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("work_scope.get and its rounds", () => {
  // Red when: rounds change the answer of a caller that never asked for them,
  // which is every caller written before this stage.
  it("answers a caller that did not ask exactly the object it always answered", async () => {
    const viaRoute = (await route(`/work-scope?subjectKey=${encodeURIComponent(SUBJECT)}`)) as object;
    const viaTool = await tool({ subjectKey: SUBJECT });

    expect("rounds" in viaRoute).toBe(false);
    expect("rounds" in viaTool).toBe(false);
    expect("round" in viaTool).toBe(false);
    expect(Object.keys(viaRoute).sort()).toEqual([
      "carriesRecord",
      "entries",
      "nextTrailBeforeId",
      "subjectKey",
      "trail",
      "version",
    ]);
  }, 120_000);

  // Red when: a round reaches a terminal and a screen as different bytes. The
  // question is the field that would drift, because MCP rewrites every string
  // it serves and nothing rewrote this one on the way in.
  it("serves the same round header to both surfaces, question included", async () => {
    const viaRoute = (await route(
      `/work-scope?subjectKey=${encodeURIComponent(SUBJECT)}&rounds=true`,
    )) as { rounds: { items: { id: string; question: { questions: string[] } }[] } };
    const viaTool = await tool({ subjectKey: SUBJECT, rounds: true });

    expect(JSON.stringify(viaTool.rounds)).toBe(JSON.stringify(viaRoute.rounds));
    const question = viaRoute.rounds.items[0]!.question.questions[0]!;
    expect(question).not.toContain("\u001B");
    expect(question).toContain("Which repository?");
    expect(viaRoute.rounds.items[0]!.id).toBe(ASK);
  }, 120_000);

  // Red when: a round's children are readable on one surface and not the
  // other, which is the failure this stage exists to prevent.
  it("serves the same deliveries and the same effects to both surfaces", async () => {
    const path = `/work-scope/rounds/${ASK}`;
    const query = `?subjectKey=${encodeURIComponent(SUBJECT)}`;

    const deliveriesRoute = (await route(`${path}/deliveries${query}`)) as {
      total: number;
      items: { count: number; firstAt: string; lastAt: string }[];
    };
    const deliveriesTool = await tool({ subjectKey: SUBJECT, roundId: ASK, roundView: "deliveries" });
    const effectsRoute = await route(`${path}/effects${query}`);
    const effectsTool = await tool({ subjectKey: SUBJECT, roundId: ASK, roundView: "effects" });

    expect(JSON.stringify((deliveriesTool.round as { page: unknown }).page)).toBe(
      JSON.stringify(deliveriesRoute),
    );
    expect(JSON.stringify((effectsTool.round as { page: unknown }).page)).toBe(
      JSON.stringify(effectsRoute),
    );
    // One delivery, five arrivals, and the times a person can act on.
    expect(deliveriesRoute.total).toBe(1);
    expect(deliveriesRoute.items[0]!.count).toBe(5);
    expect(deliveriesRoute.items[0]!.firstAt).toBe(CAPTURED_AT.toISOString());
    expect(deliveriesRoute.items[0]!.lastAt).toBe(
      new Date(CAPTURED_AT.getTime() + 4_000).toISOString(),
    );
  }, 120_000);

  // Red when: the rounds page fits on its own and the RESULT does not. What a
  // client is handed is the envelope serialized twice around the record, the
  // trail and the rounds together, and a Claude Code client writes anything
  // much over 48 KB to a file instead of showing it. Measured here on the
  // weekend a ticket really produces: three answers, a hundred poll ticks each.
  it("keeps the whole result inline sized, on a round answered three hundred times", async () => {
    for (const [round, said] of ["the api one", "no, the web one", "the api one"].entries()) {
      for (let arrival = 0; arrival < 100; arrival += 1) {
        await recordAnswerDelivery(
          {
            clarificationId: ASK,
            runId: RUN,
            words: said,
            author: { kind: "person", display: "Ada Lovelace" },
            surface: "jira",
            reading: null,
            note: null,
            at: new Date(CAPTURED_AT.getTime() + 10_000 + round * 100_000 + arrival * 1_000),
          },
          { db, sanitize: detector },
        );
      }
    }

    const result = await rawTool({ subjectKey: SUBJECT, rounds: true });
    const wire = Buffer.byteLength(JSON.stringify(result), "utf8");
    const envelope = result.structuredContent as {
      meta: { redactions: number; truncated: boolean };
      data: { rounds: { total: number; items: { arrivalCount: number }[] } };
    };

    expect(envelope.meta.truncated).toBe(false);
    // Nothing in this result needed rewriting on the way out, which is what
    // makes the two surfaces byte for byte the same.
    expect(envelope.meta.redactions).toBe(0);
    expect(envelope.data.rounds.total).toBe(1);
    expect(envelope.data.rounds.items[0]!.arrivalCount).toBe(305);
    expect(wire).toBeLessThan(49_152);
  }, 300_000);

  // Red when: a round id that is not this subject's answers with an internal
  // error, so a stale link reads as a broken deployment.
  it("names what a round id is when the subject has no such round", async () => {
    const error = await route(
      `/work-scope/rounds/cl_nope/deliveries?subjectKey=${encodeURIComponent(SUBJECT)}`,
    ).catch((e: Error) => e.message);

    expect(String(error)).toContain("404");
    expect(String(error)).toContain("FIRST ask");
  }, 120_000);
});
