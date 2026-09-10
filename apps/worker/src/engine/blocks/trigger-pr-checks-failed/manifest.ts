import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const vcsProviderSelection = z.array(z.enum(["github", "gitlab"])).min(1);
const paramsSchema = z
  .object({
    providers: vcsProviderSelection.default(["github", "gitlab"]),
    scope: z.enum(["workflow_owned", "any"]).default("workflow_owned"),
    checkNames: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    ignoreCheckNames: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    githubAppSlugs: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20)
      .default(["github-actions"]),
    gitlabPipelineSources: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20)
      .default(["merge_request_event"]),
    maxFixAttemptsPerPr: z.number().int().min(1).max(10).default(2),
    rateLimitMax: z.number().int().min(1).optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day", "month"]).optional(),
  })
  .strict();


export const manifest = {
  type: "trigger_pr_checks_failed",
  paramsSchema,
  contract: {
    category: "trigger",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "trigger",
    label: "PR checks failed",
    description: "Starts when external CI reports one or more failed checks.",
    glyph: "✗",
    color: "#D14343",
    softColor: "#FBECEC",
  },
  defaults: {
    providers: ["github", "gitlab"],
    scope: "workflow_owned",
    checkNames: [],
    ignoreCheckNames: [],
    githubAppSlugs: ["github-actions"],
    gitlabPipelineSources: ["merge_request_event"],
    maxFixAttemptsPerPr: 2,
  },
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
