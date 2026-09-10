import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const vcsProviderSelection = z.array(z.enum(["github", "gitlab"])).min(1);
const paramsSchema = z
  .object({
    providers: vcsProviderSelection.default(["github", "gitlab"]),
    scope: z.enum(["workflow_owned", "any"]).default("workflow_owned"),
    rateLimitMax: z.number().int().min(1).optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day", "month"]).optional(),
  })
  .strict();


export const manifest = {
  type: "trigger_pr_created",
  paramsSchema,
  contract: {
    category: "trigger",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "trigger",
    label: "PR created",
    description: "Starts from an allowed pull or merge request creation event.",
    glyph: "⎇",
    color: "#D14343",
    softColor: "#FBECEC",
  },
  defaults: { providers: ["github", "gitlab"], scope: "workflow_owned" },
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
