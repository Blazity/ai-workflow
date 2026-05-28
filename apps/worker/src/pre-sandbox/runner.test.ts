import { describe, expect, it, vi } from "vitest";
import { executePreSandboxPhase } from "./runner.js";
import type {
  PreSandboxConfig,
  PreSandboxPromptTarget,
  PreSandboxStepHandler,
  PreSandboxStepContext,
  PreSandboxStepRegistry,
  RunPreSandboxPhaseInput,
} from "./types.js";

const input: RunPreSandboxPhaseInput = {
  ticket: {
    identifier: "AWT-42",
    title: "Add pre-sandbox phase",
    description: "Implement the core runner.",
    acceptanceCriteria: "Runs before sandbox provisioning.",
    comments: [{ author: "Kacper", body: "Keep it small.", createdAt: "2026-05-21T09:00:00Z" }],
    labels: ["backend"],
  },
  run: {
    branchName: "feature/AWT-42",
    isNewTicket: true,
    hasExistingPr: false,
    hasMergeConflict: false,
  },
};

function config(steps: PreSandboxConfig["preSandbox"]["steps"]): PreSandboxConfig {
  return {
    preSandbox: {
      runOn: {
        newTicket: true,
        existingPr: true,
        mergeConflict: true,
      },
      steps,
    },
  };
}

describe("executePreSandboxPhase", () => {
  it("skips configured steps when runOn does not match", async () => {
    const step: PreSandboxStepHandler = vi.fn(async () => ({ status: "continue" as const }));
    const result = await executePreSandboxPhase(
      input,
      {
        preSandbox: {
          runOn: {
            newTicket: false,
            existingPr: true,
            mergeConflict: true,
          },
          steps: [{ uses: "step", onFailure: "fail" }],
        },
      },
      { step },
    );

    expect(step).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "continue",
      promptAdditions: {
        research: [],
        implementation: [],
        review: [],
      },
    });
  });

  it("runs steps sequentially and groups prompt additions by target", async () => {
    const order: string[] = [];
    const seenContexts: PreSandboxStepContext[] = [];
    const first: PreSandboxStepHandler = vi.fn(async ({ context }) => {
      order.push("first");
      seenContexts.push(context);
      return {
        status: "continue" as const,
        promptAdditions: [
          {
            target: ["research", "implementation"] as PreSandboxPromptTarget[],
            title: "First",
            content: "Use this before implementation.",
          },
        ],
      };
    });
    const second: PreSandboxStepHandler = vi.fn(async () => {
      order.push("second");
      return {
        status: "continue" as const,
        promptAdditions: [
          {
            target: ["review"] as PreSandboxPromptTarget[],
            title: "Second",
            content: "Review this.",
          },
        ],
      };
    });
    const registry: PreSandboxStepRegistry = {
      first,
      second,
    };

    const result = await executePreSandboxPhase(
      input,
      config([
        {
          uses: "first",
          onFailure: "fail",
          with: { input: { ticket: ["identifier", "title"] } },
        },
        { uses: "second", onFailure: "fail" },
      ]),
      registry,
    );

    expect(order).toEqual(["first", "second"]);
    expect(seenContexts[0]?.ticket).toEqual({
      identifier: "AWT-42",
      title: "Add pre-sandbox phase",
    });
    expect(result.status).toBe("continue");
    expect(result.promptAdditions.research).toHaveLength(1);
    expect(result.promptAdditions.implementation).toHaveLength(1);
    expect(result.promptAdditions.review).toHaveLength(1);
  });

  it("returns halt output and does not run later steps", async () => {
    const later: PreSandboxStepHandler = vi.fn(async () => ({ status: "continue" as const }));
    const halt: PreSandboxStepHandler = vi.fn(async () => ({
      status: "halt" as const,
      outcome: "needs_clarification" as const,
      message: "Ticket is too broad.",
      questions: ["Which flow is in scope?"],
    }));
    const result = await executePreSandboxPhase(
      input,
      config([
        {
          uses: "halt",
          onFailure: "fail",
        },
        {
          uses: "later",
          onFailure: "fail",
        },
      ]),
      {
        halt,
        later,
      },
    );

    expect(later).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "halt",
      outcome: "needs_clarification",
      message: "Ticket is too broad.",
      questions: ["Which flow is in scope?"],
      promptAdditions: {
        research: [],
        implementation: [],
        review: [],
      },
    });
  });

  it("continues after a failed step when onFailure is continue", async () => {
    const result = await executePreSandboxPhase(
      input,
      config([
        {
          uses: "fails",
          onFailure: "continue",
        },
        {
          uses: "next",
          onFailure: "fail",
        },
      ]),
      {
        fails: vi.fn(async () => {
          throw new Error("boom");
        }),
        next: vi.fn(async () => ({
          status: "continue" as const,
          promptAdditions: [
            {
              target: ["research"] as PreSandboxPromptTarget[],
              title: "Next",
              content: "Recovered.",
            },
          ],
        })),
      },
    );

    expect(result.status).toBe("continue");
    expect(result.promptAdditions.research).toHaveLength(1);
  });

  it("halts failed when a step throws and onFailure is fail", async () => {
    const result = await executePreSandboxPhase(
      input,
      config([{ uses: "fails", name: "Failure Step", onFailure: "fail" }]),
      {
        fails: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    );

    expect(result).toMatchObject({
      status: "halt",
      outcome: "failed",
      message: 'Pre-sandbox step "Failure Step" failed: boom',
    });
  });

  it("halts failed with a backlog-oriented message for move_to_backlog failures", async () => {
    const result = await executePreSandboxPhase(
      input,
      config([{ uses: "fails", name: "Rejection Step", onFailure: "move_to_backlog" }]),
      {
        fails: vi.fn(async () => {
          throw new Error("not ready");
        }),
      },
    );

    expect(result).toMatchObject({
      status: "halt",
      outcome: "failed",
      message: 'Pre-sandbox rejected the ticket in "Rejection Step": not ready',
    });
  });

  it("enforces a per-step timeout", async () => {
    const result = await executePreSandboxPhase(
      input,
      config([{ uses: "slow", name: "Slow Step", timeoutMs: 1, onFailure: "fail" }]),
      {
        slow: vi.fn(
          () =>
            new Promise((resolve: (value: { status: "continue" }) => void) => {
              setTimeout(() => resolve({ status: "continue" }), 25);
            }),
        ),
      },
    );

    expect(result).toMatchObject({
      status: "halt",
      outcome: "failed",
    });
    if (result.status !== "halt") throw new Error("expected pre-sandbox halt result");
    expect(result.message).toContain('Pre-sandbox step "Slow Step" timed out after 1ms.');
  });
});
