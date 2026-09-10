import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({
    provider: z.enum(["claude", "codex"]).optional(),
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:/-]+$/u).optional(),
    prompt: z.string().optional(),
    outputSchema: z.string().optional(),
    workspaceMode: z.enum(["none", "read_write"]).default("none"),
  })
  .strict();


export const manifest = {
  type: "generic_agent",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "agents",
    label: "Generic agent",
    description: "Runs a configurable agent prompt with an optional declared output schema.",
    glyph: "❖",
    color: "#7C3AED",
    softColor: "#F2EBFD",
  },
  defaults: { prompt: "", workspaceMode: "none" },
  inputs: {
    prompt: { required: false, schema: { type: "string" } },
  },
  execution: "map",
} satisfies BlockManifest;
