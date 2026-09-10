import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "branch",
  paramsSchema,
  contract: {
    category: "control",
    ports: ["true","false"],
    allowsFailurePort: false,
  },
  ui: {
    group: "control",
    label: "Branch",
    description: "Chooses one of two paths using the restricted condition language.",
    glyph: "⋔",
    color: "#35823f",
    softColor: "#E9F3EA",
  },
  defaults: { condition: "" },
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
