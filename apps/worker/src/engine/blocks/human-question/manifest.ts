import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({
    questions: z.array(z.string().trim().min(1)).optional(),
    suggestedAnswers: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();


export const manifest = {
  type: "human_question",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "human",
    label: "Human question",
    description: "Parks execution until the ticket owner answers scoped questions.",
    glyph: "?",
    color: "#b06a14",
    softColor: "#F7F0E7",
  },
  defaults: { questions: [] },
  inputs: {
    questions: { required: false, schema: { type: "array", items: { type: "string" } } },
    suggestedAnswers: {
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    context: { required: false, schema: { type: "string" } },
  },
  execution: "map",
} satisfies BlockManifest;
