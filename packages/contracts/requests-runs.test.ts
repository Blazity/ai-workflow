import { describe, it } from "node:test";
import { expect } from "./test-expect.js";
import {
  MAX_CLARIFICATION_ANSWER_LENGTH,
  clarificationAnswerRequestSchema,
  clarificationAnswerText,
  parseRequestBody,
} from "@shared/contracts";

const parse = (body: unknown) => {
  const result = parseRequestBody(clarificationAnswerRequestSchema, body);
  return result.ok ? { ok: true, value: clarificationAnswerText(result.value) } : result;
};

describe("clarificationAnswerRequestSchema", () => {
  it("accepts an answer and keeps it untrimmed", () => {
    expect(parse({ answer: "  use the staging bucket  " })).toEqual({
      ok: true,
      value: "  use the staging bucket  ",
    });
  });

  it("accepts an answer at the length limit and refuses one past it", () => {
    expect(parse({ answer: "x".repeat(MAX_CLARIFICATION_ANSWER_LENGTH) }).ok).toBe(true);
    expect(parse({ answer: "x".repeat(MAX_CLARIFICATION_ANSWER_LENGTH + 1) })).toEqual({
      ok: false,
      message: "invalid_answer",
    });
  });

  it("refuses a missing answer, a blank one and a non-string one alike", () => {
    for (const body of [{}, { answer: "   " }, { answer: 42 }, { answer: null }]) {
      expect(parse(body)).toEqual({ ok: false, message: "invalid_answer" });
    }
  });

  it("ignores unknown fields, as the handler did", () => {
    expect(parse({ answer: "ship it", note: "extra" })).toEqual({ ok: true, value: "ship it" });
  });
});
