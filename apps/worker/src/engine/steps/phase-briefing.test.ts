/**
 * The send step's side of the record: WHEN it is written, and what happens to
 * the agent when writing it goes wrong.
 *
 * Driven through the real `writeAndStartPhase`, with the sandbox mocked and
 * the database real, because the two things this has to get right are both
 * about ordering against the launch: a briefing written after the detached
 * command starts leaves a window in which an agent is burning credits while
 * the person reading the run is told the prompt was never sent, and a capture
 * that throws kills that agent outright from a step that cannot retry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { logger } from "../../infra/logger.js";
import type { AgentBriefingCapture } from "../agent-visibility/plan.js";

const state = vi.hoisted(() => ({
  db: null as unknown,
  /** Rows the connected writer produced, in the order the step made them. */
  calls: [] as string[],
  /** Set to make the briefing insert fail the way a database outage does. */
  insertFails: false,
  /** What the sandbox says each command did. */
  chmodExit: 0,
  launchExit: null as number | null,
  /** Whether a briefing row existed at the moment the agent was launched. */
  briefingAtLaunch: null as boolean | null,
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(async () => ({
      writeFiles: vi.fn(async () => {
        state.calls.push("writeFiles");
      }),
      runCommand: vi.fn(async (command: unknown, args?: unknown) => {
        if (command === "chmod") {
          state.calls.push("chmod");
          return { exitCode: state.chmodExit, cmdId: "chmod-1", logs: async () => [] };
        }
        void args;
        state.calls.push("launch");
        const rows = await listRows();
        state.briefingAtLaunch = rows.length > 0;
        return { exitCode: state.launchExit, cmdId: "cmd-1", logs: async () => [] };
      }),
    })),
  },
}));

vi.mock("../../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({ token: "t", teamId: "team", projectId: "project" }),
}));

vi.mock("../../db/repositories/agent-visibility.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/repositories/agent-visibility.js")>();
  return {
    ...actual,
    recordConnectedAgentBriefingRow: async (row: never) => {
      state.calls.push("briefing");
      if (state.insertFails) throw new Error("neon is down");
      return actual.recordAgentBriefingRow(state.db as Db, row);
    },
    recordConnectedAgentBriefingRunFact: async (runId: string, fact: never) => {
      state.calls.push(`fact:${fact}`);
      return actual.recordAgentBriefingRunFact(state.db as Db, runId, fact);
    },
  };
});

const { writeAndStartPhase } = await import("./phase.js");
const { listAgentBriefingRowsOfRun, readAgentBriefingRecord, readAgentBriefingRunSummary } = await import(
  "../../db/repositories/agent-visibility.js"
);

const RUN = "wrun_step";
const PROMPT = "Plan the change. Zażółć gęślą jaźń 🚀";

// Booting the test database applies every migration, which outlasts the
// default hook bound on a loaded machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

async function listRows() {
  return listAgentBriefingRowsOfRun(state.db as Db, RUN);
}

function briefing(overrides: Partial<AgentBriefingCapture> = {}): AgentBriefingCapture {
  return {
    enabled: true,
    identity: {
      runId: RUN,
      nodeId: "planning",
      attempt: 1,
      activationScopeId: "root",
      sequence: 1,
      kind: "agent",
      blockType: "planning_agent",
    },
    harness: { provider: "claude", model: "claude-sonnet-4-5-20250929", profile: null },
    sections: [
      { kind: "block", title: "Prompt as sent", text: { source: "prompt", start: 0, end: PROMPT.length } },
    ],
    ...overrides,
  };
}

function send(capture: AgentBriefingCapture | null) {
  return writeAndStartPhase(
    "sandbox-1",
    "claude",
    "research",
    "/tmp/research-requirements.md",
    PROMPT,
    "/tmp/research.sh",
    "#!/bin/bash\nclaude --print\n",
    undefined,
    undefined,
    capture,
  );
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(logger, "warn").mockReturnValue(undefined);
  state.db = await createTestDb();
  state.calls = [];
  state.insertFails = false;
  state.chmodExit = 0;
  state.launchExit = null;
  state.briefingAtLaunch = null;
});

describe("writeAndStartPhase records the send", () => {
  // Red when: the record is written after the detached command starts. The
  // invocation can be killed in between, and the reader is then told the
  // prompt was never sent about an agent that is already working.
  it("writes the briefing before the agent is launched", async () => {
    const result = await send(briefing());

    expect(result).toEqual({ ok: true, commandId: "cmd-1" });
    expect(state.calls).toEqual(["writeFiles", "chmod", "briefing", "fact:captured", "launch"]);
    expect(state.briefingAtLaunch).toBe(true);
    const rows = await listRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 1, kind: "agent", capture: "captured" });
  });

  // Red when: a failed record takes the run down with it, or quietly lets the
  // agent start with no trace of the loss. The agent must start exactly as it
  // does today, and the run must still say its code could capture.
  it("starts the agent anyway when the record cannot be written", async () => {
    state.insertFails = true;

    const result = await send(briefing());

    expect(result).toEqual({ ok: true, commandId: "cmd-1" });
    expect(state.calls).toContain("launch");
    expect(await listRows()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN, nodeId: "planning", attempt: 1, sequence: 1 }),
      "agent_briefing_write_failed",
    );
    // The run is reported as one that tried and lost the send, never as one
    // from before capture existed.
    expect(await readAgentBriefingRunSummary(state.db as Db, RUN)).toMatchObject({ failedCount: 1 });
  });

  // Red when: a send that never went out leaves a hole in the numbering. The
  // sequence is taken in the workflow body before the step runs, so a reader
  // would meet 1 and 3 with a silent 2 and have to guess. No prompt is stored,
  // because none was read; the place in the order is, with its reason.
  it("marks the place in the order when the wrapper could not be made executable", async () => {
    state.chmodExit = 1;

    const result = await send(briefing());

    expect(result).toMatchObject({ ok: false });
    expect(state.calls).toEqual(["writeFiles", "chmod", "briefing", "fact:skipped"]);
    const rows = await listRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 1, capture: "capture_skipped" });
    // Nothing the model would have read is on the record, because nothing was.
    expect(
      await readAgentBriefingRecord(state.db as Db, {
        runId: RUN,
        nodeId: "planning",
        attempt: 1,
        activationScopeId: "root",
        sequence: 1,
      }),
    ).toMatchObject({ texts: [] });
  });

  // Red when: a launch that fails immediately loses its briefing, which is
  // exactly the case a person is trying to understand: this is what it was
  // given, and it did not start.
  it("keeps the briefing when the agent fails to launch", async () => {
    state.launchExit = 127;

    const result = await send(briefing());

    expect(result).toMatchObject({ ok: false });
    expect(await listRows()).toHaveLength(1);
  });

  // Red when: a journal written before this argument existed makes the step
  // throw or record an empty send. A run suspended across the deploy replays
  // with the arguments it was created with.
  it("starts the agent with no briefing at all, the way an old journal replays", async () => {
    // A replayed journal hands the step back the argument list it was created
    // with, which is SHORTER: the value is missing, not null. Calling with six
    // arguments is what that really looks like.
    // Seven is what discovery's own call site passed before this argument
    // existed, so it is the shortest list a real journal can replay with.
    const replayed = writeAndStartPhase as unknown as (...args: unknown[]) => ReturnType<typeof writeAndStartPhase>;
    const result = await replayed(
      "sandbox-1",
      "claude",
      "research",
      "/tmp/research-requirements.md",
      PROMPT,
      "/tmp/research.sh",
      "#!/bin/bash\nclaude --print\n",
    );

    expect(result).toEqual({ ok: true, commandId: "cmd-1" });
    expect(state.calls).toEqual(["writeFiles", "chmod", "launch"]);
    expect(await listRows()).toHaveLength(0);
  });

  // Red when: a run that started with capture off records nothing, so a person
  // is told "not recorded" where the truth is "switched off", and the count of
  // sends is lost with it.
  it("marks the send when the run started with capture off", async () => {
    const result = await send(briefing({ enabled: false }));

    expect(result).toEqual({ ok: true, commandId: "cmd-1" });
    const rows = await listRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ capture: "capture_disabled" });
    expect(await readAgentBriefingRunSummary(state.db as Db, RUN)).toMatchObject({ disabledCount: 1 });
  });
});
