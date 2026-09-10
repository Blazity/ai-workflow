import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({
    providers: z.array(z.enum(["github", "gitlab"])).min(1).default(["github"]),
    on: z
      .array(z.enum(["changes_requested", "commented"]))
      .min(1)
      .default(["changes_requested"]),
    scope: z.enum(["workflow_owned", "any"]).default("workflow_owned"),
    maxRunsPerPr: z.number().int().min(1).max(30).default(10),
    rateLimitMax: z.number().int().min(1).optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day", "month"]).optional(),
  })
  .strict();


export const manifest = {
  type: "trigger_pr_review",
  paramsSchema,
  contract: {
    category: "trigger",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "trigger",
    label: "PR review",
    description: "Starts from an allowed human pull or merge request review.",
    glyph: "✎",
    color: "#D14343",
    softColor: "#FBECEC",
  },
  defaults: {
    providers: ["github"],
    on: ["changes_requested"],
    scope: "workflow_owned",
    maxRunsPerPr: 10,
  },
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
