import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "arthur_injection_check",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "arthur",
    label: "Prompt injection check",
    description: "Scans untrusted content with the optional Arthur Engine integration.",
    glyph: "◬",
    color: "#8b6f8f",
    softColor: "#F3F0F4",
  },
  defaults: {},
  inputs: {
    content: { required: false, schema: { type: "string" } },
  },
  execution: "map",
} satisfies BlockManifest;
