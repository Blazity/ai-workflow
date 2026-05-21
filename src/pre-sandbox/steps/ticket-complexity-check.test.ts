import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { generateObjectMock, anthropicMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  anthropicMock: vi.fn((name: string) => ({ __model: name })),
}));
vi.mock("ai", () => ({ generateObject: generateObjectMock }));
vi.mock("@ai-sdk/anthropic", () => ({ anthropic: anthropicMock }));

import { ticketComplexityCheckStep } from "./ticket-complexity-check.js";
import type {
  PreSandboxConfig,
  PreSandboxConfigStep,
  PreSandboxStepContext,
  PreSandboxStepExecutionInput,
} from "../types.js";

const context: PreSandboxStepContext = {
  ticket: {
    identifier: "AWT-42",
    title: "Add pre-sandbox phase",
    description: "Implement the core runner.",
    acceptanceCriteria: "Runs before sandbox provisioning.",
    comments: [],
    labels: [],
  },
  run: {
    branchName: "feature/AWT-42",
    isNewTicket: true,
    hasExistingPr: false,
    hasMergeConflict: false,
  },
};

const config: PreSandboxConfig = {
  preSandbox: {
    runOn: { newTicket: true, existingPr: true, mergeConflict: true },
    steps: [{ uses: "ticket-complexity-check", onFailure: "fail" }],
  },
};

const step: PreSandboxConfigStep = { uses: "ticket-complexity-check", onFailure: "fail" };

const input: PreSandboxStepExecutionInput = { context, config, step };

let originalApiKey: string | undefined;
let originalModel: string | undefined;

describe("ticketComplexityCheckStep", () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
    anthropicMock.mockClear();
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    originalModel = process.env.CLAUDE_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_MODEL;
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.CLAUDE_MODEL;
    else process.env.CLAUDE_MODEL = originalModel;
  });

  it("halts with failed outcome when ANTHROPIC_API_KEY is missing", async () => {
    const result = await ticketComplexityCheckStep(input);
    expect(result).toEqual({
      status: "halt",
      outcome: "failed",
      message: "Ticket Complexity Check requires ANTHROPIC_API_KEY.",
    });
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("continues with prompt additions when the model returns status=continue", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    generateObjectMock.mockResolvedValueOnce({
      object: { status: "continue", message: "Looks implementable." },
    });

    const result = await ticketComplexityCheckStep(input);

    expect(result).toEqual({
      status: "continue",
      promptAdditions: [
        {
          target: ["research", "implementation"],
          title: "Ticket Complexity Check",
          content: "Looks implementable.",
        },
      ],
    });
  });

  it("halts with needs_clarification when the model returns status=needs_clarification", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    generateObjectMock.mockResolvedValueOnce({
      object: {
        status: "needs_clarification",
        message: "Too vague.",
        questions: ["Q1", "Q2"],
      },
    });

    const result = await ticketComplexityCheckStep(input);

    expect(result).toEqual({
      status: "halt",
      outcome: "needs_clarification",
      message: "Too vague.",
      questions: ["Q1", "Q2"],
    });
  });

  it("uses CLAUDE_MODEL env when set, otherwise defaults to claude-opus-4-6", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.CLAUDE_MODEL = "claude-custom-model";
    generateObjectMock.mockResolvedValueOnce({
      object: { status: "continue", message: "ok" },
    });

    await ticketComplexityCheckStep(input);
    expect(anthropicMock).toHaveBeenCalledWith("claude-custom-model");

    delete process.env.CLAUDE_MODEL;
    anthropicMock.mockClear();
    generateObjectMock.mockResolvedValueOnce({
      object: { status: "continue", message: "ok" },
    });

    await ticketComplexityCheckStep(input);
    expect(anthropicMock).toHaveBeenCalledWith("claude-opus-4-6");
  });
});
