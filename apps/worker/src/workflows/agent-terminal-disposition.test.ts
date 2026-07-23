import { describe, expect, it } from "vitest";
import {
  terminalStatusDisposition,
  v2TerminalBlockResult,
} from "./agent.js";

describe("terminalStatusDisposition", () => {
  it("parks waiting runs without using the failure exit", () => {
    expect(terminalStatusDisposition("waiting_for_human")).toEqual({
      runOutcome: "awaiting",
      shouldRunFailureSideEffects: false,
    });
  });

  it.each(["done", "skipped"] as const)(
    "completes %s runs without using the failure exit",
    (terminalStatus) => {
      expect(terminalStatusDisposition(terminalStatus)).toEqual({
        runOutcome: "success",
        shouldRunFailureSideEffects: false,
      });
    },
  );

  it("keeps failed runs on the failure exit", () => {
    expect(terminalStatusDisposition("failed")).toEqual({
      runOutcome: "failed",
      shouldRunFailureSideEffects: true,
    });
  });
});

describe("v2TerminalBlockResult", () => {
  it("promotes failed termination to an execution error", () => {
    expect(v2TerminalBlockResult({
      terminalStatus: "failed",
      postComment: "The acceptance gate failed.",
    })).toMatchObject({
      kind: "execution_error",
      error: {
        category: "engine",
        detail: "The acceptance gate failed.",
        phase: "terminate",
      },
    });
  });

  it("pauses for a human and completes that path after the answer", () => {
    expect(v2TerminalBlockResult({
      terminalStatus: "waiting_for_human",
      postComment: "Choose the release window.",
    })).toEqual({
      kind: "needs_human_input",
      output: { status: "waiting_for_human" },
      questions: ["Choose the release window."],
    });
    expect(v2TerminalBlockResult({
      terminalStatus: "waiting_for_human",
      clarificationAnswer: "Tomorrow",
    })).toEqual({
      kind: "next",
      output: { status: "done" },
    });
  });

  it.each(["done", "skipped"] as const)(
    "returns a path-local next result for %s",
    (terminalStatus) => {
      expect(v2TerminalBlockResult({ terminalStatus })).toEqual({
        kind: "next",
        output: { status: terminalStatus },
      });
    },
  );
});
