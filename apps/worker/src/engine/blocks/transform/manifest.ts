import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "transform",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "utility",
    label: "Transform",
    description: "Formats, cleans, converts, parses, replaces, or consolidates workflow values.",
    glyph: "↦",
    color: "#64748B",
    softColor: "#EEF1F5",
  },
  defaults: {},
  inputs: {},
  additionalInputs: [
    {
      keyPattern: "^[A-Za-z_][A-Za-z0-9_-]*$",
      schema: { type: "unknown" },
    },
  ],
  execution: "graph",
} satisfies BlockManifest;
