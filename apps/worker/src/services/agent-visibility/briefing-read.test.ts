/**
 * The read model both surfaces sit on: what a person or an agent is told about
 * one run's sends, and what they are told when there is nothing to tell.
 *
 * Every row here was seeded through the real write path (`recordAgentBriefing`,
 * the replay store), because stage 3b is not in this worktree and a hand-built
 * index would only prove that the reader agrees with the fixture author.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { agentBriefingOverviewSchema, readVisibilityRecord } from "@shared/agent-visibility";
import type { Db } from "../../db/client.js";
import { eq } from "drizzle-orm";
import { agentBriefingTexts, agentBriefings, workflowRuns } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import {
  briefingReadsOf,
  readBriefingAttempts,
  readBriefingRepositoryContext,
  readBriefingSectionPage,
  readBriefingSectionParts,
  readBriefingSections,
  readBriefingSectionSpans,
  readBriefingUnresolvedSources,
} from "./briefing-read.js";
import { AgentVisibilityReadError } from "./pages.js";
import {
  captureBriefing,
  OTHER_ORG,
  seedAttempt,
  seedRun,
  seedVisibilityWorld,
  VISIBILITY_ORG,
  type SeededWorld,
} from "../../test-support/agent-visibility.js";

let db: Db;
let world: SeededWorld;
const RUN = "wrun_read";

function reads() {
  return briefingReadsOf(db);
}

function attemptsOf(input: Parameters<typeof readBriefingAttempts>[1]) {
  return readBriefingAttempts(reads(), input);
}

const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

// The first database of the run replays every migration from disk, which on a
// cold cache passes the default hook timeout.
beforeEach(async () => {
  db = await createTestDb();
  world = await seedVisibilityWorld(db);
}, 120_000);

describe("who may read a briefing", () => {
  // Red when: the audience is taken from the dashboard session instead of the
  // run, which would hand every member of every organization another tenant's
  // ticket bodies, AGENTS.md files and memory.
  it("answers a member of another organization exactly as it answers a wrong run id", async () => {
    await seedRun(db, { runId: RUN, world });
    await captureBriefing(db, { runId: RUN });

    const foreign = await attemptsOf({ runId: RUN, organizationId: OTHER_ORG }).catch((error) => error);
    const missing = await attemptsOf({ runId: "wrun_nope", organizationId: VISIBILITY_ORG }).catch(
      (error) => error,
    );

    expect(foreign).toBeInstanceOf(AgentVisibilityReadError);
    expect((foreign as AgentVisibilityReadError).statusCode).toBe(404);
    expect((missing as AgentVisibilityReadError).statusCode).toBe(404);
  });

  // Red when: a run whose replay capture never claimed an organization is
  // served to whoever asks, or hidden behind a 404 that reads as "this run
  // recorded nothing" when the truth is "we cannot work out who may see it".
  it("refuses out loud when the run recorded no organization", async () => {
    await seedRun(db, { runId: RUN, world, observed: false });
    await captureBriefing(db, { runId: RUN });

    const error = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG }).catch((e) => e);

    expect(error).toBeInstanceOf(AgentVisibilityReadError);
    expect((error as AgentVisibilityReadError).statusCode).toBe(403);
    expect((error as AgentVisibilityReadError).message).toContain("cannot confirm who may read");
  });
});

describe("the attempts of a run", () => {
  // Red when: a block that never sends a prompt is described as a send that
  // was not recorded, which sends a person hunting a capture bug.
  it("says a script block sends no prompts and gives it no reason", async () => {
    await seedRun(db, { runId: RUN, world, nodes: { checks: "run_scripts" } });
    await seedAttempt(db, { runId: RUN, nodeId: "checks" });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ nodeId: "checks", sendsPrompts: false, missing: null });
  });

  // Red when: an attempt that has its discovery briefing is treated as fully
  // recorded, so a planning pass that never went out is invisible.
  it("says a planning attempt captured discovery and never sent its pass", async () => {
    await seedRun(db, { runId: RUN, world, nodes: { planning: "planning_agent" } });
    await seedAttempt(db, {
      runId: RUN,
      nodeId: "planning",
      state: "failed",
      outcome: { kind: "failed", status: "sandbox_unavailable" },
    });
    await captureBriefing(db, { runId: RUN, kind: "discovery", blockType: "planning_agent" });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items[0]!.briefings).toHaveLength(1);
    expect(page.items[0]!.missing).toMatchObject({
      kind: "never_sent",
      attemptState: "failed",
      failure: { category: "sandbox_unavailable" },
    });
  });

  // Red when: an attempt row that still says running on a cancelled run is
  // read as "not sent yet", so a person waits for a send that can never come.
  it("never says not sent yet about a live attempt row on a failed run", async () => {
    await seedRun(db, { runId: RUN, world, status: "failed", statusReason: "the run was cancelled" });
    await seedAttempt(db, { runId: RUN, nodeId: "planning", state: "running" });
    await captureBriefing(db, { runId: RUN, kind: "discovery", blockType: "planning_agent" });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items[0]!.missing).toMatchObject({
      kind: "never_sent",
      runStatus: "failed",
      failure: { message: "the run was cancelled" },
    });
  });

  // Red when: an attempt still preparing is reported as a lost record.
  it("says not sent yet while the attempt is still running on a live run", async () => {
    await seedRun(db, { runId: RUN, world, status: "running" });
    await seedAttempt(db, { runId: RUN, nodeId: "planning", state: "running" });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items[0]!.missing).toEqual({ schemaVersion: 1, kind: "not_sent_yet" });
  });

  // Red when: capture switched off reads as capture lost. The marker row is
  // the only thing that tells them apart and it is written at the send.
  it("says capture was switched off when the marker row says so", async () => {
    await seedRun(db, { runId: RUN, world });
    await seedAttempt(db, { runId: RUN, nodeId: "planning" });
    await captureBriefing(db, { runId: RUN }, { capture: false });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items[0]!.missing).toEqual({
      schemaVersion: 1,
      kind: "not_recorded",
      cause: "capture_disabled",
    });
    expect(page.items[0]!.briefings).toEqual([]);
  });

  // Red when: a run whose code could never capture is told the write was
  // refused or lost, which is an incident report about a run that is fine.
  // The run-level state stays `available` on purpose: the attempts ARE listed
  // and each one says why it has no briefing.
  it("says an attempt of a run from before capture predates it", async () => {
    await seedRun(db, { runId: RUN, world });
    await seedAttempt(db, { runId: RUN, nodeId: "planning", state: "completed" });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items[0]!.missing).toEqual({
      schemaVersion: 1,
      kind: "not_recorded",
      cause: "predates_capture",
    });
    expect(page.state).toBe("available");
  });

  // Red when: retention takes an attempt's briefing while the run still holds
  // another, and the swept one reads as the write having been refused or lost.
  // A run whose sends are days apart is half swept for weeks BY DESIGN, because
  // a briefing expires per send and the sweep runs under a limit.
  it("says a half swept attempt expired rather than blaming capture", async () => {
    await seedRun(db, { runId: RUN, world, nodes: { planning: "planning_agent" } });
    await seedAttempt(db, { runId: RUN, nodeId: "planning", attempt: 1, state: "completed" });
    await seedAttempt(db, { runId: RUN, nodeId: "planning", attempt: 2, state: "completed" });
    await captureBriefing(db, { runId: RUN, attempt: 1 });
    const second = await captureBriefing(db, { runId: RUN, attempt: 2 });
    // The sweep took the older send and left the newer one.
    await db
      .delete(agentBriefings)
      .where(eq(agentBriefings.id, second.outcome === "recorded" ? second.briefingId : -1));

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });
    const swept = page.items.find((item) => item.attempt === 2)!;

    expect(swept.briefings).toEqual([]);
    expect(swept.missing).toEqual({ schemaVersion: 1, kind: "expired" });
  });

  // Red when: the replay of a run that DID capture has passed, and the reader
  // reports a lost write instead of retention. Every other fixture expires in
  // 2099, so hard-coding this fact to false would keep them all green.
  it("says expired once the replay that reached the briefings has passed", async () => {
    await seedRun(db, {
      runId: RUN,
      world,
      nodes: { planning: "planning_agent" },
      replayExpiresAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    await captureBriefing(db, { runId: RUN, kind: "discovery", blockType: "planning_agent" });

    const page = await attemptsOf({
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      now: new Date("2026-10-01T00:00:00.000Z"),
    });

    expect(page.items[0]!.missing).toEqual({ schemaVersion: 1, kind: "expired" });
  });

  // Red when: a send whose record capture REFUSED reads as capture having been
  // switched off, or as a run that predates capture. The marker's own sentence
  // is the only thing that says what capture actually found.
  it("says the record was refused, and serves what capture said about it", async () => {
    await seedRun(db, { runId: RUN, world, nodes: { planning: "planning_agent" } });
    await seedAttempt(db, { runId: RUN, nodeId: "planning", state: "completed" });
    await captureBriefing(db, { runId: RUN }, { refuse: true });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items[0]!.missing).toEqual({
      schemaVersion: 1,
      kind: "not_recorded",
      cause: "capture_skipped",
    });
    expect(page.items[0]!.captureDetail).toContain("capture detector");
  });

  // Red when: a planning attempt that captured its first pass and died before
  // the second says nothing is missing, while the briefing the person opened
  // the tab for is the absent one. That is what per-send sequences are for.
  it("still reports a missing second pass when the first one was captured", async () => {
    await seedRun(db, { runId: RUN, world, nodes: { planning: "planning_agent" } });
    await seedAttempt(db, {
      runId: RUN,
      nodeId: "planning",
      state: "failed",
      outcome: { kind: "failed", status: "sandbox_lost" },
    });
    await captureBriefing(db, { runId: RUN, sequence: 1 });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items[0]!.briefings).toHaveLength(1);
    expect(page.items[0]!.missing).toMatchObject({ kind: "never_sent", attemptState: "failed" });
  });

  // Red when: a marker row left by a planning block, on a run whose graph is
  // gone, is described as a block with no prompt to be missing.
  it("takes the kind from a marker row when the graph can no longer say", async () => {
    await seedRun(db, { runId: RUN, world, observed: false });
    await db.update(workflowRuns).set({ replayOrganizationId: VISIBILITY_ORG });
    await captureBriefing(db, { runId: RUN }, { capture: false });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items[0]!.sendsPrompts).toBe(true);
    expect(page.items[0]!.missing).toMatchObject({ kind: "not_recorded", cause: "capture_disabled" });
  });

  // Red when: an attempt nothing can identify is called a block that sends no
  // prompts, which tells a person a planning block had nothing to be missing.
  it("says it cannot tell, rather than false, when nothing identifies the block", async () => {
    await seedRun(db, { runId: RUN, world, nodes: {} });
    await seedAttempt(db, { runId: RUN, nodeId: "vanished", state: "completed" });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items[0]!.sendsPrompts).toBeNull();
    expect(page.items[0]!.missing).toBeNull();
  });

  // Red when: a schema version this build does not know makes every briefing
  // unreadable and the list then reserves so much of a page that no item fits,
  // so the read refuses instead of showing what it still has.
  it("still serves a page when everything on the run is unreadable", async () => {
    await seedRun(db, { runId: RUN, world, nodes: { planning: "planning_agent" } });
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      await seedAttempt(db, { runId: RUN, nodeId: "planning", attempt, state: "completed" });
      await captureBriefing(db, { runId: RUN, attempt });
    }
    await db.update(agentBriefings).set({ briefingIndex: { schemaVersion: 99 } });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG, limit: 4_096 });

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.unreadableTotal).toBe(40);
    expect(page.unreadable.length).toBeLessThanOrEqual(5);
    // Only the entries of the attempts this page is showing: the first page
    // starts at position 0, so every entry it names is inside its own window.
    expect(page.unreadable.every((entry) => entry.rows === "briefings")).toBe(true);
    expect(page.unreadable.every((entry) => entry.position < page.items.length)).toBe(true);
  }, 300_000);

  // Red when: a run with nothing left at all answers an empty list with no
  // word about why, which reads as "this run sent nothing" rather than "this
  // deployment has no record of it either way".
  it("says the run predates capture when nothing capture-capable left a trace", async () => {
    await seedRun(db, { runId: RUN, world, status: "success" });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.state).toBe("predates_capture");
  });

  // Red when: a run dispatched a moment ago, whose first block has not started,
  // is told it predates the feature. Nothing distinguishes it from an old run by
  // its rows alone: both have no sends and no attempts. The run still being
  // alive is the whole difference, and a person watching it wait would be told
  // to stop waiting.
  it("says nothing about capture while a run that recorded nothing yet is alive", async () => {
    await seedRun(db, { runId: RUN, world, status: "running" });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items).toEqual([]);
    expect(page.state).toBe("available");
  });

  // Red when: retention sweeping a run's briefings leaves a person reading
  // "the write was refused or lost" about writes that succeeded months ago.
  it("says the run's briefings expired once capture's own facts outlive them", async () => {
    await seedRun(db, { runId: RUN, world });
    await captureBriefing(db, { runId: RUN });
    await db.delete(agentBriefings);

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.state).toBe("expired");
  });

  // Red when: a run whose replay was swept is reported as a run that never
  // reached a block, so the attempts that never sent are silently absent.
  it("says the replay is gone when only briefings are left to name attempts", async () => {
    await seedRun(db, { runId: RUN, world });
    await captureBriefing(db, { runId: RUN });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.state).toBe("replay_gone");
    expect(page.items[0]).toMatchObject({ nodeId: "planning", startedAt: null });
  });

  // Red when: a loop body's iterations are merged, or a filter on one scope
  // leaks another iteration's sends into the answer.
  it("returns only the named iteration of a loop body, and labels it", async () => {
    await seedRun(db, { runId: RUN, world, nodes: { review: "review_agent" } });
    for (const index of [1, 2, 3]) {
      await captureBriefing(db, {
        runId: RUN,
        nodeId: "review",
        blockType: "review_agent",
        activationScopeId: `root/loop:reviews:${index}`,
        sections: [{ kind: "block", title: "Block role", text: `Review round ${index}.` }],
      });
    }

    const all = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });
    const one = await attemptsOf({
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      activationScopeId: "root/loop:reviews:2",
    });

    expect(all.items).toHaveLength(3);
    expect(one.items).toHaveLength(1);
    expect(one.items[0]!.iteration).toEqual({ loopNodeId: "reviews", index: 2 });
    expect(one.total).toBe(1);
  });

  // Red when: the overview a list serves is not the overview the package
  // derives from the stored index, so the dashboard's per-record parse fails
  // and the entry disappears from the screen with a named error.
  it("serves an overview the frozen schema accepts, one record at a time", async () => {
    await seedRun(db, { runId: RUN, world });
    await captureBriefing(db, { runId: RUN });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    for (const entry of page.items.flatMap((item) => item.briefings)) {
      expect(readVisibilityRecord(agentBriefingOverviewSchema, entry.overview).ok).toBe(true);
    }
  });

  // Red when: an index a newer version wrote takes the whole list down, or
  // vanishes from it without a word.
  it("names a briefing it cannot read instead of dropping it", async () => {
    await seedRun(db, { runId: RUN, world });
    await captureBriefing(db, { runId: RUN });
    await db.update(agentBriefings).set({ briefingIndex: { schemaVersion: 99 } });

    const page = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG });

    expect(page.items[0]!.briefings).toEqual([]);
    expect(page.unreadable).toHaveLength(1);
    expect(page.unreadable[0]!.problem).toContain("newer version");
  });

  // Red when: a cursor is a position into a list a live run is appending to,
  // so an attempt inserted between two pages is served twice or skipped.
  it("pages on the entry itself, and refuses a cursor the list no longer has", async () => {
    await seedRun(db, { runId: RUN, world, nodes: { planning: "planning_agent" } });
    for (const index of [1, 2, 3]) {
      // Four sends each, so one attempt does not fit a page beside another and
      // the cursor has to be used rather than merely returned.
      for (const sequence of [1, 2, 3, 4]) {
        await captureBriefing(db, {
          runId: RUN,
          activationScopeId: `root/loop:passes:${index}`,
          sequence,
          sections: [{ kind: "block", title: "Block role", text: `Pass ${sequence}.` }],
        });
      }
    }

    const first = await attemptsOf({ runId: RUN, organizationId: VISIBILITY_ORG, limit: 4_096 });
    const second = await attemptsOf({
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      limit: 4_096,
      cursor: first.nextCursor,
    });
    const bad = await attemptsOf({
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      cursor: "planning\u000099\u0000root",
    }).catch((error) => error);

    expect(first.nextCursor).not.toBeNull();
    expect(first.total).toBe(3);
    const served = [...first.items, ...second.items].map((item) => item.activationScopeId);
    expect(new Set(served).size).toBe(served.length);
    expect(bad).toBeInstanceOf(AgentVisibilityReadError);
    expect((bad as AgentVisibilityReadError).statusCode).toBe(400);
  });
});

describe("one briefing", () => {
  const LONG = "The checkout button does nothing.\n".repeat(400);

  async function captured() {
    await seedRun(db, { runId: RUN, world });
    const recorded = await captureBriefing(db, {
      runId: RUN,
      sections: [
        { kind: "runtime", title: "Runtime data", text: LONG },
        { kind: "block", title: "Block role", text: "Plan the change." },
      ],
      unresolvedSources: [
        { kind: "repository_instructions", reference: "acme/api:AGENTS.md", message: "not found" },
      ],
    });
    if (recorded.outcome !== "recorded") throw new Error(`fixture: ${recorded.outcome}`);
    return recorded.briefingId;
  }

  // Red when: a page repeats or skips bytes, so what a person reads is not
  // what the agent was sent. The digest is computed independently of the code
  // under test, from the section's own stored hash.
  it("pages a section back to exactly the stored text and its digest", async () => {
    const briefingId = await captured();
    const base = { runId: RUN, organizationId: VISIBILITY_ORG, briefingId, sectionIndex: 0 };

    const headers = await readBriefingSections(reads(), {
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      briefingId,
    });
    let offset: number | null = 0;
    let text = "";
    let pages = 0;
    while (offset !== null) {
      const page = await readBriefingSectionPage(reads(), { ...base, offset, limit: 1_024 });
      text += page.text;
      offset = page.nextOffset;
      pages += 1;
    }

    expect(pages).toBeGreaterThan(1);
    expect(text).toBe(LONG);
    expect(sha(text)).toBe(headers.items[0]!.storedSha256);
    expect(Buffer.byteLength(text, "utf8")).toBe(headers.items[0]!.storedBytes);
  });

  // Red when: an offset past the end, or one inside a character, is snapped to
  // something servable instead of refused, which repeats or skips bytes.
  it("refuses an offset past the end readably", async () => {
    const briefingId = await captured();

    const error = await readBriefingSectionPage(reads(), {
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      briefingId,
      sectionIndex: 0,
      offset: 10_000_000,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AgentVisibilityReadError);
    expect((error as AgentVisibilityReadError).statusCode).toBe(400);
    expect((error as AgentVisibilityReadError).message).toContain("past the end");
  });

  // Red when: a briefing whose stored text was swept serves an empty string,
  // which reads as "the agent was given nothing": the worst wrong answer here.
  it("says a lost stored text is a storage fault, not an empty prompt", async () => {
    const briefingId = await captured();
    await db.delete(agentBriefingTexts);

    const error = await readBriefingSectionPage(reads(), {
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      briefingId,
      sectionIndex: 0,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AgentVisibilityReadError);
    expect((error as AgentVisibilityReadError).statusCode).toBe(500);
    expect((error as AgentVisibilityReadError).message).toContain("storage fault");
  });

  // Red when: a section index nobody has answers the same way as a briefing
  // nobody has, so a caller cannot tell a typo from an expired record.
  it("names how many sections there are when asked for one there is not", async () => {
    const briefingId = await captured();

    const error = await readBriefingSectionParts(reads(), {
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      briefingId,
      sectionIndex: 9,
    }).catch((e) => e);

    expect((error as AgentVisibilityReadError).statusCode).toBe(404);
    expect((error as AgentVisibilityReadError).message).toContain("has 2 sections");
  });

  // Red when: the parts of a section stop covering its stored text, so a page
  // of text cannot be attributed to what put it there.
  it("serves parts that cover the whole stored text, and its spans", async () => {
    const briefingId = await captured();
    const base = { runId: RUN, organizationId: VISIBILITY_ORG, briefingId, sectionIndex: 0 };

    const parts = await readBriefingSectionParts(reads(), base);
    const spans = await readBriefingSectionSpans(reads(), base);
    const headers = await readBriefingSections(reads(), {
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      briefingId,
    });

    expect(parts.items[0]!.range.start).toBe(0);
    expect(parts.items.at(-1)!.range.end).toBe(headers.items[0]!.storedBytes);
    expect(spans.total).toBe(headers.items[0]!.spanCount);
  });

  // Red when: the unresolved sources have a route and no reader, so "which
  // AGENTS.md did the compiler fail to find" cannot be asked at all.
  it("serves the sources the compiler could not resolve", async () => {
    const briefingId = await captured();

    const page = await readBriefingUnresolvedSources(reads(), {
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      briefingId,
    });

    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ reference: "acme/api:AGENTS.md" });
  });

  // Red when: a briefing with no repository context answers an empty document
  // instead of saying the send rendered none.
  it("says a send rendered no repository context rather than inventing one", async () => {
    const briefingId = await captured();

    const error = await readBriefingRepositoryContext(reads(), {
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      briefingId,
    }).catch((e) => e);

    expect((error as AgentVisibilityReadError).statusCode).toBe(404);
    expect((error as AgentVisibilityReadError).message).toContain("rendered no repository context");
  });

  // Red when: a marker row is served as a briefing with no sections, which
  // reads as a send whose prompt was empty.
  it("refuses a marker row as a briefing and points at the list", async () => {
    await seedRun(db, { runId: RUN, world });
    await captureBriefing(db, { runId: RUN }, { capture: false });
    const [row] = await db.select().from(agentBriefings);

    const error = await readBriefingSections(reads(), {
      runId: RUN,
      organizationId: VISIBILITY_ORG,
      briefingId: row!.id,
    }).catch((e) => e);

    expect((error as AgentVisibilityReadError).statusCode).toBe(404);
    expect((error as AgentVisibilityReadError).message).toContain("capture_disabled");
  });
});
