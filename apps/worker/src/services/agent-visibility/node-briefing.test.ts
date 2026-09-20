/**
 * The operator's question: what does THIS block actually send.
 *
 * They are looking at a canvas, not at a run, so every case here starts from a
 * node id and asks what the answer tells them to do next: read the prompt, wait
 * for a run, stop waiting, or nothing at all because the block has no prompt.
 *
 * Stage 3b is not in this worktree: every row was seeded through the real write
 * path, and the ids are spelled the way capture spells them.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import {
  captureBriefing,
  OTHER_ORG,
  seedAttempt,
  seedDefinitionNodes,
  seedRun,
  seedVisibilityWorld,
  VISIBILITY_ORG,
  type SeededWorld,
} from "../../test-support/agent-visibility.js";
import { briefingReadsOf, readBriefingAttempts, type PageBounds } from "./briefing-read.js";
import { nodeBriefingReadsOf, readNodeLastBriefing } from "./node-briefing.js";
import { AgentVisibilityReadError } from "./pages.js";

let db: Db;
let world: SeededWorld;

function lastBriefingOf(nodeId: string, organizationId = VISIBILITY_ORG, bounds?: PageBounds) {
  return readNodeLastBriefing(nodeBriefingReadsOf(db, briefingReadsOf(db)), {
    definitionId: world.definitionId,
    nodeId,
    organizationId,
    ...(bounds === undefined ? {} : { bounds }),
  });
}

beforeEach(async () => {
  db = await createTestDb();
  world = await seedVisibilityWorld(db);
  await seedDefinitionNodes(db, world, [
    { id: "planning", type: "planning_agent" },
    { id: "comment", type: "post_ticket_comment" },
  ]);
}, 120_000);

describe("the last briefing of one block", () => {
  // Red when: the read answers from the oldest run, or from whichever row the
  // database happened to return first. An operator asking what a block sends
  // means the last time it ran, and a stale prompt is worse than none: they
  // would edit against text the block no longer produces.
  it("answers from the newest run that ran the node, and says which run", async () => {
    // Named so that alphabetical order is the OPPOSITE of time order: a tie
    // break that happened to agree with the clock would prove nothing.
    await seedRun(db, { runId: "wrun_zebra", world, nodes: { planning: "planning_agent" } });
    await seedAttempt(db, {
      runId: "wrun_zebra",
      nodeId: "planning",
      state: "completed",
      startedAt: new Date("2026-09-18T09:00:00.000Z"),
    });
    await captureBriefing(db, {
      runId: "wrun_zebra",
      capturedAt: new Date("2026-09-18T09:05:00.000Z"),
      sections: [{ kind: "runtime", title: "Runtime data", text: "the older prompt" }],
    });
    // A later run, of a later version of the same definition.
    await seedRun(db, {
      runId: "wrun_alpha",
      world,
      definitionVersion: 4,
      nodes: { planning: "planning_agent" },
    });
    await seedAttempt(db, {
      runId: "wrun_alpha",
      nodeId: "planning",
      state: "completed",
      startedAt: new Date("2026-09-19T11:00:00.000Z"),
    });
    await captureBriefing(db, {
      runId: "wrun_alpha",
      capturedAt: new Date("2026-09-19T11:05:00.000Z"),
      sections: [{ kind: "runtime", title: "Runtime data", text: "the newer prompt" }],
    });

    const answer = await lastBriefingOf("planning");

    expect(answer.ranIn?.runId).toBe("wrun_alpha");
    // Across versions, and the version that ran said out loud: the briefing
    // below came from a definition that is not the one on the canvas.
    expect(answer.ranIn?.definitionVersion).toBe(4);
    expect(answer.blockType).toBe("planning_agent");
    expect(answer.sendsPrompts).toBe(true);
    expect(answer.attempt?.briefings).toHaveLength(1);
    expect(answer.attempt?.missing).toBeNull();
    expect(answer.absent).toBeNull();
    // The counts an alert reads without opening anything.
    expect(answer.ranIn?.capture).toMatchObject({ captured: 1, sends: 1 });
  }, 120_000);

  // Red when: a block that was never going to send anything is reported as one
  // that has not run yet, which sends an operator to dispatch a workflow to
  // find out that a comment block has no prompt.
  it("says a block with no prompt has none, rather than that it never ran", async () => {
    const answer = await lastBriefingOf("comment");

    expect(answer.absent).toEqual({ kind: "sends_no_prompt" });
    expect(answer.sendsPrompts).toBe(false);
    expect(answer.ranIn).toBeNull();
  });

  // Red when: a block that has simply not run yet is described as one with no
  // prompt, which is the same mistake in the other direction.
  it("says a prompt-sending block that has not run has not run", async () => {
    const answer = await lastBriefingOf("planning");

    expect(answer.absent).toEqual({ kind: "never_ran" });
    expect(answer.sendsPrompts).toBe(true);
    expect(answer.attempt).toBeNull();
  });

  // Red when: an edit hides history. A node renamed or deleted on the canvas
  // still sent what it sent, and the operator looking at a run's trace of it
  // needs the text, not a 404 about their own edit.
  it("still answers for a node the definition no longer has", async () => {
    await seedRun(db, { runId: "wrun_gone", world, nodes: { retired: "planning_agent" } });
    await seedAttempt(db, { runId: "wrun_gone", nodeId: "retired", state: "completed" });
    await captureBriefing(db, { runId: "wrun_gone", nodeId: "retired" });

    const answer = await lastBriefingOf("retired");

    expect(answer.blockType).toBeNull();
    expect(answer.ranIn?.runId).toBe("wrun_gone");
    expect(answer.attempt?.briefings).toHaveLength(1);
  }, 120_000);

  // Red when: a node id nobody has is an error rather than an answer, so a
  // stale link or a typo reads as a broken deployment.
  it("answers a node id nothing has ever heard of", async () => {
    const answer = await lastBriefingOf("no-such-node");

    expect(answer.absent).toEqual({ kind: "never_ran" });
    expect(answer.blockType).toBeNull();
    expect(answer.sendsPrompts).toBeNull();
  });

  // Red when: a definition id nobody has answers "this node never ran", which
  // sends a caller looking through run history for a typo in its own argument.
  it("says plainly when the definition itself does not exist", async () => {
    const error = await readNodeLastBriefing(
      nodeBriefingReadsOf(db, briefingReadsOf(db)),
      { definitionId: 987_654, nodeId: "planning", organizationId: VISIBILITY_ORG },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentVisibilityReadError);
    expect((error as AgentVisibilityReadError).statusCode).toBe(404);
    expect((error as AgentVisibilityReadError).message).toContain("workflow definition 987654");
  });

  // Red when: the run that ran the node belongs to another organization and
  // its prompt is served through the definition end, which is a door the run
  // end already closes.
  it("does not reach a run of another organization", async () => {
    await seedRun(db, {
      runId: "wrun_elsewhere",
      world,
      organizationId: OTHER_ORG,
      nodes: { planning: "planning_agent" },
    });
    await captureBriefing(db, { runId: "wrun_elsewhere" });

    const answer = await lastBriefingOf("planning");

    expect(answer.ranIn).toBeNull();
    expect(answer.absent).toEqual({ kind: "never_ran" });
  }, 120_000);

  // Red when: a run whose trace recorded no organization is quietly reported
  // as a node that never ran. It DID run; what cannot be confirmed is who may
  // read it, and that is a refusal, not an absence.
  it("refuses out loud when the run that ran it recorded no organization", async () => {
    await seedRun(db, { runId: "wrun_orphan", world, observed: false });
    await captureBriefing(db, { runId: "wrun_orphan" });

    const error = await lastBriefingOf("planning").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AgentVisibilityReadError);
    expect((error as AgentVisibilityReadError).statusCode).toBe(403);
    expect((error as AgentVisibilityReadError).message).toContain("cannot confirm");
  }, 120_000);

  // Red when: retention takes the briefing and the panel says the block sends
  // nothing, instead of the one answer that tells an operator to run it again.
  it("passes the run's own reason through when the briefing is gone", async () => {
    await seedRun(db, {
      runId: "wrun_swept",
      world,
      nodes: { planning: "planning_agent" },
      status: "success",
    });
    await seedAttempt(db, { runId: "wrun_swept", nodeId: "planning", state: "completed" });

    const answer = await lastBriefingOf("planning");

    expect(answer.ranIn?.runId).toBe("wrun_swept");
    expect(answer.attempt?.briefings).toEqual([]);
    expect(answer.attempt?.missing).toMatchObject({ kind: "not_recorded" });
    expect(answer.absent).toBeNull();
  }, 120_000);

  // Red when: the first attempt of the run is served. A block that failed and
  // was retried sends a NEW prompt each try, and the last one is the one an
  // operator is looking at the consequences of.
  it("serves the newest attempt of that run, not the first", async () => {
    await seedRun(db, { runId: "wrun_retry", world, nodes: { planning: "planning_agent" } });
    await seedAttempt(db, {
      runId: "wrun_retry",
      nodeId: "planning",
      attempt: 1,
      state: "completed",
      startedAt: new Date("2026-09-19T10:00:00.000Z"),
    });
    await captureBriefing(db, {
      runId: "wrun_retry",
      attempt: 1,
      sections: [{ kind: "runtime", title: "Runtime data", text: "first try" }],
    });
    await seedAttempt(db, {
      runId: "wrun_retry",
      nodeId: "planning",
      attempt: 2,
      state: "completed",
      startedAt: new Date("2026-09-19T10:20:00.000Z"),
    });
    await captureBriefing(db, {
      runId: "wrun_retry",
      attempt: 2,
      sections: [{ kind: "runtime", title: "Runtime data", text: "second try" }],
    });

    const answer = await lastBriefingOf("planning");

    expect(answer.attempt?.attempt).toBe(2);
    expect(answer.attempt?.briefings).toHaveLength(1);
  }, 120_000);

  // Red when: the answer is the last attempt that FITTED a page rather than the
  // last one that ran. Attempts are served oldest first, so a block retried
  // more times than one page holds answers with a prompt from the middle of the
  // afternoon while calling it the last one sent, and an operator edits against
  // text the block no longer produces. A page is bounded in BYTES, so nothing
  // about the number of attempts warns them.
  it("answers with the newest attempt even when the attempts outgrow one page", async () => {
    await seedRun(db, { runId: "wrun_many", world, nodes: { planning: "planning_agent" } });
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await seedAttempt(db, {
        runId: "wrun_many",
        nodeId: "planning",
        attempt,
        state: "completed",
        startedAt: new Date(Date.UTC(2026, 8, 19, 10, attempt)),
      });
      await captureBriefing(db, {
        runId: "wrun_many",
        attempt,
        capturedAt: new Date(Date.UTC(2026, 8, 19, 10, attempt, 30)),
        sections: [{ kind: "runtime", title: "Runtime data", text: `try ${attempt}` }],
      });
    }
    // Smaller than the default page and larger than the floor: what MCP serves
    // is smaller than HTTP for measured reasons, so this is a page a real
    // caller gets, not one invented for the test.
    const bounds: PageBounds = { default: 2_048, maximum: 2_048 };

    // The control this test needs: the boundary falls INSIDE the ten attempts.
    // Without it a page that happened to hold them all would prove nothing.
    const page = await readBriefingAttempts(briefingReadsOf(db), {
      runId: "wrun_many",
      organizationId: VISIBILITY_ORG,
      nodeId: "planning",
      bounds,
    });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(10);
    expect(page.items.at(-1)?.attempt).toBeLessThan(10);

    const answer = await lastBriefingOf("planning", VISIBILITY_ORG, bounds);

    expect(answer.attempt?.attempt).toBe(10);
    expect(answer.attempt?.briefings).toHaveLength(1);
  }, 120_000);
});
