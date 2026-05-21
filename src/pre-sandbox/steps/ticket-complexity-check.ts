import { anthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { PreSandboxStepHandler, PreSandboxStepResult } from "../types.js";

const complexityCheckSchema = z.object({
  status: z.enum(["continue", "needs_clarification"]),
  message: z.string().min(1),
  questions: z.array(z.string().min(1)).optional(),
});

export const ticketComplexityCheckStep: PreSandboxStepHandler = async ({
  context,
}): Promise<PreSandboxStepResult> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      status: "halt",
      outcome: "failed",
      message: "Ticket Complexity Check requires ANTHROPIC_API_KEY.",
    };
  }

  const modelName = process.env.CLAUDE_MODEL ?? "claude-opus-4-6";
  const { object } = await generateObject({
    model: anthropic(modelName),
    maxRetries: 0,
    schema: complexityCheckSchema,
    system:
      "You review issue tracker tickets before implementation. " +
      "Use only the ticket fields provided. Do not assume repository knowledge, internal docs, or code access.",
    prompt:
      "Decide whether this ticket is clear and small enough for sandbox execution.\n\n" +
      JSON.stringify(context.ticket, null, 2) +
      "\n\nReturn status=continue when it is implementable. Return status=needs_clarification when it is too broad, vague, or missing essential acceptance criteria. " +
      "For needs_clarification, include concrete questions for the ticket author.",
  });

  if (object.status === "needs_clarification") {
    return {
      status: "halt",
      outcome: "needs_clarification",
      message: object.message,
      questions: object.questions,
    };
  }

  return {
    status: "continue",
    promptAdditions: [
      {
        target: ["research", "implementation"],
        title: "Ticket Complexity Check",
        content: object.message,
      },
    ],
  };
};
