/**
 * The one-off rewrite, against a database with real rows in it.
 *
 * What it has to get right is what makes it safe to run on production while
 * runs are in flight: it changes the renamed type and nothing else, it touches
 * no row that did not name one, it leaves history intact version by version,
 * and running it twice is the same as running it once (whoever runs it will not
 * be sure the first one finished).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { workflowDefinitions, workflowDefinitionVersions } from "../../db/schema.js";
import {
  formatRewriteResult,
  parseRewriteArguments,
  assertProductionAcknowledged,
  renamedTypesIn,
  runRewrite,
} from "../../../scripts/rewrite-renamed-block-types.js";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

/**
 * A redacted copy of the stored definition shape the rewrite is for.
 *
 * The production identifiers and authored text were replaced with fixture
 * values. Empty configuration and the `skipped` edge are deliberately kept:
 * both occur in the rows this one-off has to rewrite, including definitions
 * saved before the current graph validator vocabulary.
 */
const STORED_DEFINITION_FIXTURE = {
  schemaVersion: 2,
  nodes: [
    {
      id: "ticket",
      type: "trigger_ticket_ai",
      name: "Ticket enters AI",
      x: 40,
      y: 120,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
    {
      id: "notify",
      type: "send_slack_message",
      name: "Tell the team",
      x: 300,
      y: 120,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
    {
      id: "not-sent",
      type: "terminate",
      name: "Continue without chat",
      x: 560,
      y: 280,
      configuration: { terminalStatus: "done" },
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [
    { id: "ticket-notify", from: "ticket", to: "notify", fromPort: "out" },
    { id: "notify-skipped", from: "notify", to: "not-sent", fromPort: "skipped" },
  ],
  budgets: { maxDurationMs: 7200000 },
  repositoryScope: [{ provider: "github", repoPath: "acme/api" }],
};

function graph(type: string, name = "Tell the team") {
  const fixture = structuredClone(STORED_DEFINITION_FIXTURE);
  fixture.nodes[1]!.type = type;
  fixture.nodes[1]!.name = name;
  return fixture;
}

/** Ids of our own, clear of the "Ticket workflow" row the migrations seed. */
const ONE = 101;
const TWO = 102;
const THREE = 103;

async function seed(rows: { definitionId: number; version: number; definition: unknown }[]) {
  for (const id of new Set(rows.map((row) => row.definitionId))) {
    await db.insert(workflowDefinitions).values({
      id,
      name: `definition ${id}`,
      createdById: "test",
      createdByLabel: "Test",
    });
  }
  for (const row of rows) {
    await db.insert(workflowDefinitionVersions).values({
      definitionId: row.definitionId,
      version: row.version,
      definition: row.definition,
      createdById: "test",
      createdByLabel: "Test",
    });
  }
}

async function stored(definitionId: number, version: number): Promise<unknown> {
  const rows = await db.select().from(workflowDefinitionVersions);
  return rows.find((row) => row.definitionId === definitionId && row.version === version)
    ?.definition;
}

const DRY_RUN = { apply: false, confirmProduction: false };
const APPLY = { apply: true, confirmProduction: false };

describe("the renamed block type rewrite", () => {
  beforeEach(async () => {
    await seed([
      // Two versions of one workflow: the published one still names the old
      // type, the draft above it was already saved as the new one.
      { definitionId: ONE, version: 1, definition: graph("send_slack_message") },
      { definitionId: ONE, version: 2, definition: graph("send_message", "Second draft") },
      // A second workflow that never had the block at all.
      { definitionId: TWO, version: 1, definition: graph("post_comment") },
    ]);
  });

  it("names every version that carries the old type and writes nothing on a dry run", async () => {
    const before = await stored(ONE, 1);

    const result = await runRewrite(db, DRY_RUN);

    expect(result.mode).toBe("dry-run");
    expect(result.candidates).toEqual([
      { definitionId: ONE, version: 1, types: ["send_slack_message"] },
    ]);
    expect(result.rewritten).toBe(0);
    expect(await stored(ONE, 1)).toEqual(before);
  });

  it("changes the type and leaves the rest of the graph exactly as it was", async () => {
    // History is read: opening version 1, comparing it with 2 and rolling back
    // to it all have to keep working, so the row may not lose its parameters,
    // its bindings, its edges or its ids.
    const before = await stored(ONE, 1);
    const expected = structuredClone(before) as typeof STORED_DEFINITION_FIXTURE;
    expected.nodes[1]!.type = "send_message";

    const result = await runRewrite(db, APPLY);

    expect(result.rewritten).toBe(1);
    expect(result.remaining).toBe(0);
    expect(await stored(ONE, 1)).toEqual(expected);
  });

  it("does not touch a version that never named the old type", async () => {
    const untouched = await stored(TWO, 1);
    const alreadyNew = await stored(ONE, 2);

    await runRewrite(db, APPLY);

    expect(await stored(TWO, 1)).toEqual(untouched);
    expect(await stored(ONE, 2)).toEqual(graph("send_message", "Second draft"));
    expect(await stored(ONE, 2)).toEqual(alreadyNew);
  });

  it("is idempotent over a table that already holds rows", async () => {
    // Whoever runs this on production will not be certain the first run
    // finished, and running it again has to be the safe thing to do.
    await runRewrite(db, APPLY);

    const second = await runRewrite(db, APPLY);

    expect(second.candidates).toEqual([]);
    expect(second.rewritten).toBe(0);
    expect(second.remaining).toBe(0);
    expect(await stored(ONE, 1)).toEqual(graph("send_message"));
  });

  it("rewrites every affected version of every definition in one pass", async () => {
    await seed([
      { definitionId: THREE, version: 1, definition: graph("send_slack_message", "First") },
      { definitionId: THREE, version: 2, definition: graph("send_slack_message", "Second") },
    ]);

    const result = await runRewrite(db, APPLY);

    expect(result.rewritten).toBe(3);
    expect(result.remaining).toBe(0);
    // Each version keeps its own content: a rewrite keyed on the definition
    // alone would give every version the same graph.
    expect(await stored(THREE, 1)).toEqual(graph("send_message", "First"));
    expect(await stored(THREE, 2)).toEqual(graph("send_message", "Second"));
  });
});

describe("the rewrite's own reading of a row", () => {
  it("reports the renamed types a graph carries, and nothing for graphs it does not", () => {
    expect(renamedTypesIn(graph("send_slack_message"))).toEqual(["send_slack_message"]);
    expect(renamedTypesIn(graph("send_message"))).toEqual([]);
    // Shapes a stored column can genuinely hold. None of them is a crash.
    expect(renamedTypesIn(null)).toEqual([]);
    expect(renamedTypesIn("{}")).toEqual([]);
    expect(renamedTypesIn({ nodes: "not an array" })).toEqual([]);
    expect(renamedTypesIn({ nodes: [null, { type: 7 }, {}] })).toEqual([]);
  });
});

describe("the rewrite's command line", () => {
  it("is a dry run unless somebody asked for the write", () => {
    expect(parseRewriteArguments([])).toEqual({ apply: false, confirmProduction: false });
    expect(parseRewriteArguments(["--apply"])).toEqual({ apply: true, confirmProduction: false });
    expect(() => parseRewriteArguments(["--force"])).toThrow(/Unknown flag/);
  });

  it("refuses to write to production until that is said out loud", () => {
    expect(() => assertProductionAcknowledged(APPLY, { NODE_ENV: "production" })).toThrow(
      /--confirm-production/,
    );
    expect(() =>
      assertProductionAcknowledged(
        { apply: true, confirmProduction: true },
        { VERCEL_ENV: "production" },
      ),
    ).not.toThrow();
    // A dry run against production is always allowed: it is how you find out.
    expect(() => assertProductionAcknowledged(DRY_RUN, { NODE_ENV: "production" })).not.toThrow();
  });

  it("prints what it found and, after a write, what is left", async () => {
    await seed([{ definitionId: ONE, version: 1, definition: graph("send_slack_message") }]);

    expect(formatRewriteResult(await runRewrite(db, DRY_RUN))).toBe(
      `dry-run candidates: 1\ndefinition ${ONE} version 1\tsend_slack_message\n`,
    );
    expect(formatRewriteResult(await runRewrite(db, APPLY))).toBe(
      `apply candidates: 1\ndefinition ${ONE} version 1\tsend_slack_message\n` +
        "rewritten: 1\nstill naming a renamed type: 0\n",
    );
  });
});
