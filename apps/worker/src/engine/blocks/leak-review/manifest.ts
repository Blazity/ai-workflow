import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:/-]+$/u).optional(),
    llmScan: z.boolean().optional(),
    maxDiffBytes: z.number().int().positive().max(262_144).optional(),
  })
  .strict();


export const manifest = {
  type: "leak_review",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "utility",
    label: "Leak review",
    description: "Screens the unpushed diff for secrets and sensitive data before publication.",
    glyph: "⊘",
    color: "#64748B",
    softColor: "#EEF1F5",
  },
  defaults: { llmScan: true },
  inputs: {},
  execution: "map",
} satisfies BlockManifest;
