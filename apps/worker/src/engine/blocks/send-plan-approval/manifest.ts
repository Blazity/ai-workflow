import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({ mirrorComment: z.boolean().default(true) })
  .strict();


export const manifest = {
  type: "send_plan_approval",
  paramsSchema,
  contract: {
    category: "action",
    ports: [],
    allowsFailurePort: false,
  },
  ui: {
    group: "human",
    label: "Send plan for approval",
    description: "Creates a durable approval item and ends this path.",
    glyph: "☑",
    color: "#b06a14",
    softColor: "#F7F0E7",
  },
  defaults: { mirrorComment: true },
  inputs: {
    plan: { required: true, schema: { type: "string" } },
    assumptions: {
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
  },
  execution: "map",
} satisfies BlockManifest;
