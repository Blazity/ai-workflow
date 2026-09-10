import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({
    rateLimitMax: z.number().int().min(1).optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day", "month"]).optional(),
  })
  .strict();


export const manifest = {
  type: "trigger_ticket_ai",
  paramsSchema,
  contract: {
    category: "trigger",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "trigger",
    label: "Ticket assigned to AI",
    description: "Starts when a configured ticket enters the AI workflow state.",
    glyph: "▶",
    color: "#D14343",
    softColor: "#FBECEC",
  },
  defaults: {},
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
