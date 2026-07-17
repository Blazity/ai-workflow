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
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.reason).toContain("human_question has no questions");
    }
  });
});
