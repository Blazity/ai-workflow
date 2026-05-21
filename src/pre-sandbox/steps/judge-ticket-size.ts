import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import type { PreSandboxStepHandler } from "../types.js";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const judgmentSchema = z.object({
  tooBig: z.boolean(),
  reasoning: z.string(),
});

const stepConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
  })
  .optional();

export const judgeTicketSizeStep: PreSandboxStepHandler = async ({ context, config }) => {
  const { env } = await import("../../../env.js");

  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("judge-ticket-size requires ANTHROPIC_API_KEY in the environment.");
  }

  const parsedConfig = stepConfigSchema.parse(config);
  const modelId = parsedConfig?.model ?? DEFAULT_MODEL;

  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const { object } = await generateObject({
    model: anthropic(modelId),
    schema: judgmentSchema,
    system:
      "You judge whether a software engineering ticket is too large to be completed by an autonomous coding agent in a single run. " +
      "A single run can typically handle a focused change touching a few related files. " +
      "Treat tickets that mix unrelated concerns, span many subsystems, or list many independent deliverables as too big.",
    prompt: buildPrompt(context.ticket),
  });

  if (object.tooBig) {
    return {
      status: "halt",
      outcome: "needs_clarification",
      message: object.reasoning,
      questions: ["Can you split this ticket into smaller, independently shippable tickets?"],
    };
  }

  return {
    status: "continue",
    promptAdditions: [
      {
        target: ["research", "implementation"],
        title: "Ticket Size Assessment",
        content: object.reasoning,
      },
    ],
  };
};

function buildPrompt(ticket: { title?: string; description?: string; acceptanceCriteria?: string; labels?: string[] }): string {
  const parts = [
    `Title: ${ticket.title?.trim() || "(none)"}`,
    `Description:\n${ticket.description?.trim() || "(none)"}`,
    `Acceptance Criteria:\n${ticket.acceptanceCriteria?.trim() || "(none)"}`,
  ];

  if (ticket.labels && ticket.labels.length > 0) {
    parts.push(`Labels: ${ticket.labels.join(", ")}`);
  }

  return parts.join("\n\n");
}
