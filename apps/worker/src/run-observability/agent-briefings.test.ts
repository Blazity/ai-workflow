import {
  explainMissingBriefing,
  type AgentBriefingBuildInput,
  type MissingBriefingFacts,
} from "@shared/agent-visibility";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import {
  listAgentBriefingRowsOfRun,
  readAgentBriefingRecord,
  readAgentBriefingRunSummary,
  type AgentBriefingRunSummary,
} from "../db/repositories/agent-visibility.js";
import { createTestDb } from "../db/test-db.js";
import { logger } from "../infra/logger.js";
import { recordAgentBriefing } from "./agent-briefings.js";
import { createVisibilityDetector, VisibilityCaptureRefusal } from "./visibility-detector.js";

const SECRET = "cfg-secret-7Qx9";
const detect = createVisibilityDetector({ secrets: [SECRET] });
const IDENTITY = {
  runId: "wrun_capture",
  nodeId: "planning",
  attempt: 1,
  activationScopeId: "root",
  sequence: 1,
};

let db: Db;

/**
 * A client whose first statement fails and whose later ones do not: the
 * briefing insert is lost, everything after it is not. Written this way
 * because the point is the run's facts SURVIVING a failed briefing write.
 */
function failsOnce(real: Db): Db {
  let failed = false;
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property !== "execute") return Reflect.get(target, property, receiver);
      return (query: unknown) => {
        if (failed) return (target as Db).execute(query as never);
        failed = true;
        return Promise.reject(new Error("neon is down"));
      };
    },
  }) as Db;
}

/** The facts a reader has about an attempt, with the run's capture row read
 *  the way stage 4 reads it: the row's existence is the capability. */
function factsFrom(summary: AgentBriefingRunSummary | null): MissingBriefingFacts {
  return {
    attemptState: "completed",
    runStatus: "success",
    failure: null,
    promptSent: true,
    captureCapable: summary === null ? null : true,
    captureDisabled: (summary?.disabledCount ?? 0) > 0,
    capturedKinds: [],
    replayExpired: false,
    // A planning block, which sends on every attempt of it.
    sendsEveryAttempt: true,
    runLostASend: (summary?.failedCount ?? 0) > 0,
  };
}

function sendInput(text: string, overrides: Partial<AgentBriefingBuildInput> = {}): AgentBriefingBuildInput {
  return {
    identity: {
      ...IDENTITY,
      kind: "agent",
      blockType: "planning_agent",
      capturedAt: "2026-09-19T10:15:00.000Z",
    },
    harness: { provider: "claude", model: "claude-sonnet-4-5-20250929" },
    sections: [{ kind: "runtime", title: "Runtime data", text }],
    repositoryContext: null,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  db = await createTestDb();
});

describe("recordAgentBriefing", () => {
  // Red when: a configured secret reaches a stored byte, which is the one
  // thing an operator has to be able to trust about a briefing.
  it("stores the send without the configured secret in it", async () => {
    const result = await recordAgentBriefing(sendInput(`deploy with ${SECRET} now`), { db, sanitize: detect });

    expect(result).toEqual({ outcome: "recorded", briefingId: expect.any(Number) });
    const record = await readAgentBriefingRecord(db, IDENTITY);
    expect(record?.texts.map((entry) => entry.text)).toEqual(["deploy with [REDACTED] now"]);
    expect(JSON.stringify(record)).not.toContain(SECRET);
    expect(record?.briefing.bytes).toBeGreaterThan(0);
    expect(await readAgentBriefingRunSummary(db, IDENTITY.runId)).toMatchObject({
      capturedCount: 1,
      disabledCount: 0,
      skippedCount: 0,
    });
  });

  // Red when: the same send written again by a replay is reported as a fresh
  // briefing, which would make a reader believe an agent was sent twice.
  it("reports the same send written again as already recorded", async () => {
    const input = sendInput("plan the change");
    await recordAgentBriefing(input, { db, sanitize: detect });

    expect(await recordAgentBriefing(input, { db, sanitize: detect })).toEqual({ outcome: "already_recorded" });
    expect(await listAgentBriefingRowsOfRun(db, IDENTITY.runId)).toHaveLength(1);
    // A replay is the same send arriving again: nothing about the run changed.
    expect(await readAgentBriefingRunSummary(db, IDENTITY.runId)).toMatchObject({
      capturedCount: 1,
      failedCount: 0,
      conflictCount: 0,
    });
  });

  // Red when: the moment of the send is part of what decides a conflict, so a
  // step that runs again stamps a new time, reads as a different briefing and
  // logs an identity conflict nobody caused.
  it("reports a send re-executed with a new capture time as already recorded", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    await recordAgentBriefing(sendInput("plan the change"), { db, sanitize: detect });

    const again = sendInput("plan the change");
    again.identity.capturedAt = "2026-09-19T11:45:00.000Z";
    expect(await recordAgentBriefing(again, { db, sanitize: detect })).toEqual({
      outcome: "already_recorded",
    });
    expect(await listAgentBriefingRowsOfRun(db, IDENTITY.runId)).toHaveLength(1);
    expect(await readAgentBriefingRunSummary(db, IDENTITY.runId)).toMatchObject({
      capturedCount: 1,
      conflictCount: 0,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // Red when: a send made while capture was off leaves no trace, so a reader
  // is told this code predates capture instead of "somebody switched it off".
  it("records a send made with capture off, with no texts", async () => {
    const result = await recordAgentBriefing(sendInput("plan the change"), {
      db,
      sanitize: detect,
      capture: false,
    });

    expect(result).toEqual({ outcome: "capture_disabled" });
    const [row] = await listAgentBriefingRowsOfRun(db, IDENTITY.runId);
    expect(row).toMatchObject({ capture: "capture_disabled", index: null });
    const disabled = await readAgentBriefingRunSummary(db, IDENTITY.runId);
    expect(disabled).toMatchObject({ capturedCount: 0, disabledCount: 1 });
    expect(explainMissingBriefing(factsFrom(disabled))).toMatchObject({
      kind: "not_recorded",
      cause: "capture_disabled",
    });
  });

  // Red when: a refused record throws into the step that is starting an agent,
  // or leaves nothing saying the send happened.
  it("records a refused briefing as a skipped send and never throws", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const broken = sendInput("abcdef", {});
    broken.sections[0]!.parts = [
      { id: "ticket", title: "Ticket", origin: { kind: "ticket" }, content: "ab" },
    ];

    const result = await recordAgentBriefing(broken, { db, sanitize: detect });

    expect(result.outcome).toBe("refused");
    const [row] = await listAgentBriefingRowsOfRun(db, IDENTITY.runId);
    expect(row).toMatchObject({ capture: "capture_skipped", index: null });
    expect(row?.detail).toBeTruthy();
    expect(await readAgentBriefingRunSummary(db, IDENTITY.runId)).toMatchObject({ skippedCount: 1 });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: IDENTITY.runId, attempt: 1, sequence: 1 }),
      "agent_briefing_refused",
    );
  });

  // Red when: a database that is down takes the agent with it.
  it("logs and returns when nothing can be written", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const broken = { execute: () => Promise.reject(new Error("neon is down")) } as unknown as Db;

    const result = await recordAgentBriefing(sendInput("plan the change"), { db: broken, sanitize: detect });

    expect(result).toEqual({ outcome: "failed", reason: "neon is down" });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: IDENTITY.runId, err: "neon is down" }),
      "agent_briefing_write_failed",
    );
  });

  // Red when: the run's facts are written only where a briefing was, so a run
  // whose write was lost has no row at all and a person is told this run
  // predates capture. That is a lie about a run that tried, and they meet it
  // exactly when something else has already gone wrong.
  it("leaves the run saying capture failed when the briefing write is lost", async () => {
    vi.spyOn(logger, "warn").mockReturnValue(undefined);

    const result = await recordAgentBriefing(sendInput("plan the change"), {
      db: failsOnce(db),
      sanitize: detect,
    });

    expect(result).toEqual({ outcome: "failed", reason: "neon is down" });
    expect(await listAgentBriefingRowsOfRun(db, IDENTITY.runId)).toEqual([]);
    const summary = await readAgentBriefingRunSummary(db, IDENTITY.runId);
    expect(summary).toMatchObject({ failedCount: 1, capturedCount: 0 });
    expect(explainMissingBriefing(factsFrom(summary))).toMatchObject({
      kind: "not_recorded",
      cause: "capture_skipped",
    });
    // And without that row, the same attempt reads as one from before capture.
    expect(explainMissingBriefing(factsFrom(null))).toMatchObject({
      kind: "not_recorded",
      cause: "predates_capture",
    });
  });

  // Red when: a detector that cannot prove a text clean answers with one span
  // over the whole text, so the row reads `captured` and a person is shown a
  // prompt that is nothing but `[REDACTED]`.
  it("records a detector that refuses as a skipped send, with no text", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    const refusing = () => {
      throw new VisibilityCaptureRefusal("nothing here could be proven clean");
    };

    const result = await recordAgentBriefing(sendInput("plan the change"), { db, sanitize: refusing });

    expect(result).toMatchObject({ outcome: "refused" });
    const [row] = await listAgentBriefingRowsOfRun(db, IDENTITY.runId);
    expect(row).toMatchObject({ capture: "capture_skipped", index: null, textSha256s: [] });
    const record = await readAgentBriefingRecord(db, IDENTITY);
    expect(record?.texts).toEqual([]);
    const summary = await readAgentBriefingRunSummary(db, IDENTITY.runId);
    expect(summary).toMatchObject({ skippedCount: 1, capturedCount: 0 });
    expect(explainMissingBriefing(factsFrom(summary))).toMatchObject({
      kind: "not_recorded",
      cause: "capture_skipped",
    });
    expect(warn).toHaveBeenCalledWith(expect.anything(), "agent_briefing_refused");
  });

  // Red when: two different sends numbered the same overwrite one another, or
  // the loss goes unlogged.
  it("keeps the stored send when a different one arrives under its identity, and says so", async () => {
    const warn = vi.spyOn(logger, "warn").mockReturnValue(undefined);
    await recordAgentBriefing(sendInput("the first send"), { db, sanitize: detect });

    const result = await recordAgentBriefing(sendInput("a different send"), { db, sanitize: detect });

    expect(result).toEqual({ outcome: "conflict" });
    const record = await readAgentBriefingRecord(db, IDENTITY);
    expect(record?.texts.map((entry) => entry.text)).toEqual(["the first send"]);
    expect(await readAgentBriefingRunSummary(db, IDENTITY.runId)).toMatchObject({
      capturedCount: 1,
      conflictCount: 1,
    });
    expect(warn).toHaveBeenCalledWith(expect.anything(), "agent_briefing_identity_conflict");
  });
});
