import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({
    prompt: z.string().optional(),
    system: z.string().optional(),
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:/-]+$/u).optional(),
    provider: z.enum(["claude", "codex"]).optional(),
    outputSchema: z.string().optional(),
  })
  .strict();


export const manifest = {
  type: "call_llm",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "utility",
    label: "Call LLM",
    description: "Runs a focused non-agent LLM transform with an optional output schema.",
    glyph: "λ",
    color: "#64748B",
    softColor: "#EEF1F5",
  },
  defaults: { prompt: "" },
  inputs: {
    prompt: { required: false, schema: { type: "string" } },
    system: { required: false, schema: { type: "string" } },
  },
  execution: "map",
} satisfies BlockManifest;
