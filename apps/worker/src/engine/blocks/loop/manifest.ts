import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "loop",
  paramsSchema,
  contract: {
    category: "control",
    ports: ["continue","exhausted"],
    allowsFailurePort: false,
  },
  ui: {
    group: "control",
    label: "Loop",
    description: "Repeats one cycle up to a bounded maximum attempt count.",
    glyph: "↻",
    color: "#35823f",
    softColor: "#E9F3EA",
  },
  defaults: { maxAttempts: 3, onExhaust: "fail" },
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
