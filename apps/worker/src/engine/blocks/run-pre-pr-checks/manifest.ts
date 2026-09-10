import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({ maxFixCycles: z.number().int().min(0).max(5).optional() })
  .strict();


export const manifest = {
  type: "run_pre_pr_checks",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "utility",
    label: "Run scripts (publication gate)",
    description: "Runs the repository's gate groups (gateGroups when set, otherwise every group) on the repositories the run changed; they must pass before publication.",
    glyph: "◈",
    color: "#64748B",
    softColor: "#EEF1F5",
  },
  defaults: {},
  inputs: {},
  execution: "inline",
} satisfies BlockManifest;
