import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  validatePrompt: vi.fn(),
}));

vi.mock("../../../env.js", () => ({ env: mocks.env }));

vi.mock("../../sandbox/arthur-client.js", () => ({
  ArthurClient: {
    fromTraceEndpoint: vi.fn(() => ({ validatePrompt: mocks.validatePrompt })),
  },
}));

import { execute, paramsSchema } from "./arthur-injection-check.js";
import { makeCtx, makeNode, runControlErrorCases } from "./test-support.js";

function configureArthur() {
  mocks.env.GENAI_ENGINE_API_KEY = "key";
  mocks.env.GENAI_ENGINE_TRACE_ENDPOINT = "https://arthur.example/api/v1/traces";
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

  it("skips when the run has no Arthur task", async () => {
    configureArthur();
    const result = await execute(makeNode("arthur_injection_check"), {}, makeCtx());
    expect(result).toEqual({
      kind: "next",
      output: { status: "skipped", reason: "arthur_task_missing" },
    });
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
