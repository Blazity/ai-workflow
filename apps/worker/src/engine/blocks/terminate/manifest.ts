import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "terminate",
  paramsSchema,
  contract: {
    category: "control",
    ports: [],
    allowsFailurePort: false,
  },
  ui: {
    group: "control",
    label: "Terminate",
    description: "Stops the current path with an explicit terminal outcome.",
    glyph: "■",
    color: "#35823f",
    softColor: "#E9F3EA",
  },
  defaults: { terminalStatus: "done" },
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
