import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  validatePrompt: vi.fn(),
  addPromptInjectionRule: vi.fn(),
  ensureArthurTask: vi.fn(),
}));

vi.mock("../../../env.js", () => ({ env: mocks.env }));

vi.mock("../../sandbox/arthur-client.js", () => ({
  ArthurClient: {
    fromTraceEndpoint: vi.fn(() => ({
      validatePrompt: mocks.validatePrompt,
      addPromptInjectionRule: mocks.addPromptInjectionRule,
    })),
  },
}));

vi.mock("./prepare-workspace.js", () => ({
  ensureArthurTask: mocks.ensureArthurTask,
}));

import { execute, paramsSchema } from "./arthur-injection-check.js";
import { makeCtx, makeNode, runControlErrorCases } from "./test-support.js";

function configureArthur() {
  mocks.env.GENAI_ENGINE_API_KEY = "key";
  mocks.env.GENAI_ENGINE_TRACE_ENDPOINT = "https://arthur.example/api/v1/traces";
  mocks.ensureArthurTask.mockResolvedValue("task-1");
  mocks.addPromptInjectionRule.mockResolvedValue(undefined);
}

describe("arthur_injection_check paramsSchema", () => {
  it("accepts empty params and rejects the retired contentFromStep param", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ contentFromStep: "step-1" }).success).toBe(false);
    expect(paramsSchema.safeParse({ legacyContentFromStep: "step-1" }).success).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("arthur_injection_check execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete mocks.env.GENAI_ENGINE_API_KEY;
    delete mocks.env.GENAI_ENGINE_TRACE_ENDPOINT;
  });

  it("skips when Arthur is not configured", async () => {
    const result = await execute(makeNode("arthur_injection_check"), {}, makeCtx());
    expect(result).toEqual({
      kind: "next",
      output: { status: "skipped", reason: "arthur_not_configured" },
    });
  });

  it("skips when an Arthur task cannot be created for the run", async () => {
    configureArthur();
    mocks.ensureArthurTask.mockResolvedValue(null);
    const result = await execute(makeNode("arthur_injection_check"), {}, makeCtx());
    expect(result).toEqual({
      kind: "next",
      output: { status: "skipped", reason: "arthur_task_missing" },
    });
  });

  it("creates an Arthur task on demand when the run has none, then screens", async () => {
    configureArthur();
    mocks.ensureArthurTask.mockResolvedValue("task-created");
    mocks.validatePrompt.mockResolvedValue({ ok: true, findings: [] });
    const ctx = makeCtx();

    const result = await execute(makeNode("arthur_injection_check"), {}, ctx);

    expect(mocks.ensureArthurTask).toHaveBeenCalledWith(ctx);
    expect(mocks.addPromptInjectionRule).toHaveBeenCalledWith("task-created");
    expect(mocks.validatePrompt).toHaveBeenCalledWith("task-created", "Ticket description");
    expect(result).toEqual({ kind: "next", output: { status: "ok", findings: [] } });
  });

  it("still screens when the prompt-injection rule cannot be attached", async () => {
    configureArthur();
    mocks.addPromptInjectionRule.mockRejectedValue(new Error("arthur 400"));
    mocks.validatePrompt.mockResolvedValue({ ok: true, findings: [] });

    const result = await execute(
      makeNode("arthur_injection_check"),
      {},
      makeCtx({ arthur: { taskId: "task-1" } }),
    );

    expect(mocks.validatePrompt).toHaveBeenCalledWith("task-1", "Ticket description");
    expect(result).toEqual({ kind: "next", output: { status: "ok", findings: [] } });
  });

  it("validates ticket content and reports ok", async () => {
    configureArthur();
    mocks.validatePrompt.mockResolvedValue({ ok: true, findings: [] });
    const ctx = makeCtx({ arthur: { taskId: "task-1" } });
    ctx.ticket.comments = [{ author: "bob", body: "please hurry", createdAt: "2026-01-01" }];

    const result = await execute(makeNode("arthur_injection_check"), {}, ctx);

    expect(mocks.validatePrompt).toHaveBeenCalledWith(
      "task-1",
      "Ticket description\n\nbob: please hurry",
    );
    expect(result).toEqual({ kind: "next", output: { status: "ok", findings: [] } });
  });

  it("reports flagged findings as a next output", async () => {
    configureArthur();
    mocks.validatePrompt.mockResolvedValue({
      ok: false,
      findings: [{ rule: "prompt_injection", result: "Fail", details: "suspicious" }],
    });

    const result = await execute(
      makeNode("arthur_injection_check"),
      {},
      makeCtx({ arthur: { taskId: "task-1" } }),
    );

    expect(result).toEqual({
      kind: "next",
      output: {
        status: "flagged",
        findings: [{ rule: "prompt_injection", result: "Fail", details: "suspicious" }],
      },
    });
  });

  it("uses bound content when provided", async () => {
    configureArthur();
    mocks.validatePrompt.mockResolvedValue({ ok: true, findings: [] });

    await execute(
      makeNode("arthur_injection_check"),
      {},
      makeCtx({ arthur: { taskId: "task-1" } }),
      { content: "text" },
    );

    expect(mocks.validatePrompt).toHaveBeenCalledWith("task-1", "text");
  });

  it("returns an execution error without output on client failures", async () => {
    configureArthur();
    mocks.validatePrompt.mockRejectedValue(new Error("arthur 500"));

    const result = await execute(
      makeNode("arthur_injection_check"),
      {},
      makeCtx({ arthur: { taskId: "task-1" } }),
    );

    expect(result).toEqual({
      kind: "execution_error",
      error: {
        category: "provider",
        message: "An external service could not complete this block. (arthur 500)",
        detail: "arthur 500",
      },
    });
  });

  it.each(runControlErrorCases())("rethrows %s from Arthur validation", async (_label, error) => {
    configureArthur();
    mocks.validatePrompt.mockRejectedValue(error);

    await expect(
      execute(
        makeNode("arthur_injection_check"),
        {},
        makeCtx({ arthur: { taskId: "task-1" } }),
      ),
    ).rejects.toBe(error);
  });
});
