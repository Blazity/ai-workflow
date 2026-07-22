import { describe, expect, it } from "vitest";
import type { StepsRecord } from "../../workflow-definition/interpreter.js";
import { execute, paramsSchema } from "./human-question.js";
import { makeCtx, makeNode } from "./test-support.js";

describe("human_question paramsSchema", () => {
  it("accepts empty params, a questions array, and rejects unknown keys", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ questions: ["Q1"] }).success).toBe(true);
    expect(paramsSchema.safeParse({ questions: [""] }).success).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("accepts an optional suggestedAnswers array of non-empty strings", () => {
    expect(paramsSchema.safeParse({ suggestedAnswers: ["Yes", "No"] }).success).toBe(true);
    expect(paramsSchema.safeParse({ suggestedAnswers: [""] }).success).toBe(false);
  });
});

describe("human_question execute", () => {
  it("maps configured questions to needs_human_input without side effects", async () => {
    const result = await execute(
      makeNode("human_question", { questions: ["What DB?", " "] }),
      {},
      makeCtx(),
    );
    expect(result).toEqual({
      kind: "needs_human_input",
      output: { status: "needs_human_input", questions: ["What DB?"] },
      questions: ["What DB?"],
    });
  });

  it("prefers resolved questions and suggestions over static params", async () => {
    const result = await execute(
      makeNode("human_question", {
        questions: ["Static?"],
        suggestedAnswers: ["Static"],
      }),
      {},
      makeCtx(),
      { questions: ["Bound?"], suggestedAnswers: ["Bound"] },
    );

    expect(result).toMatchObject({
      questions: ["Bound?"],
      suggestedAnswers: ["Bound"],
    });
  });

  it("derives questions from the most recent upstream output", async () => {
    const steps: StepsRecord = {
      older: { output: { status: "needs_human_input", questions: ["Old?"] } },
      newer: { output: { status: "needs_human_input", questions: ["New?"] } },
    };
    const result = await execute(makeNode("human_question"), steps, makeCtx());
    expect(result.kind).toBe("needs_human_input");
    if (result.kind === "needs_human_input") {
      expect(result.questions).toEqual(["New?"]);
    }
  });

  it("fails with a clear reason when nothing is derivable", async () => {
    const steps: StepsRecord = { a: { output: { status: "ok" } } };
    const result = await execute(makeNode("human_question"), steps, makeCtx());
    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toContain("human_question has no questions");
    }
  });

  it("threads params-provided suggestedAnswers", async () => {
    const result = await execute(
      makeNode("human_question", { questions: ["Ship it?"], suggestedAnswers: ["Yes", "No", " "] }),
      {},
      makeCtx(),
    );
    expect(result).toEqual({
      kind: "needs_human_input",
      output: {
        status: "needs_human_input",
        questions: ["Ship it?"],
        suggestedAnswers: ["Yes", "No"],
      },
      questions: ["Ship it?"],
      suggestedAnswers: ["Yes", "No"],
    });
  });

  it("picks up upstream suggestedAnswers when questions fall back and params provide none", async () => {
    const steps: StepsRecord = {
      upstream: {
        output: {
          status: "needs_human_input",
          questions: ["Which region?"],
          suggestedAnswers: ["us-east-1", "eu-west-1"],
        },
      },
    };
    const result = await execute(makeNode("human_question"), steps, makeCtx());
    expect(result.kind).toBe("needs_human_input");
    if (result.kind === "needs_human_input") {
      expect(result.questions).toEqual(["Which region?"]);
      expect(result.suggestedAnswers).toEqual(["us-east-1", "eu-west-1"]);
    }
  });

  it("lets params suggestedAnswers win over upstream ones", async () => {
    const steps: StepsRecord = {
      upstream: {
        output: {
          status: "needs_human_input",
          questions: ["Which region?"],
          suggestedAnswers: ["us-east-1"],
        },
      },
    };
    const result = await execute(
      makeNode("human_question", { suggestedAnswers: ["custom"] }),
      steps,
      makeCtx(),
    );
    expect(result.kind).toBe("needs_human_input");
    if (result.kind === "needs_human_input") {
      // Questions still fall back to upstream, but the params suggestions win.
      expect(result.questions).toEqual(["Which region?"]);
      expect(result.suggestedAnswers).toEqual(["custom"]);
    }
  });
});
