import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "trigger_plan_approved",
  paramsSchema,
  contract: {
    category: "trigger",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "trigger",
    label: "Plan approved",
    description: "Starts the pinned implementation path after plan approval.",
    glyph: "✔",
    color: "#D14343",
    softColor: "#FBECEC",
  },
  defaults: {},
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
