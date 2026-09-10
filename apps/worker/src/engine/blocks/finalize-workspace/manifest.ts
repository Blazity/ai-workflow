import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "finalize_workspace",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "workspace",
    label: "Finalize workspace",
    description: "Preflights and publishes committed workspace changes.",
    glyph: "⇉",
    color: "#0f7f8b",
    softColor: "#E7F2F3",
  },
  defaults: {},
  inputs: {},
  additionalInputs: [
    {
      keyPattern: "^checks\\.[A-Za-z0-9_-]+$",
      schema: { type: "string" },
    },
  ],
  execution: "map",
} satisfies BlockManifest;
