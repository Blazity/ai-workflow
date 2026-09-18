import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const vcsProviderSelection = z.array(z.enum(["github", "gitlab"])).min(1);
// The trigger's optional repository policy. Kept in step by hand with
// `triggerRepositoryPolicySchema` in @shared/contracts, which a manifest may
// import only as a type. Deliberately no default.
const repositoryKey = z
  .string()
  .trim()
  .toLowerCase()
  .max(207)
  .regex(/^(?:github|gitlab):[^/\s]+(?:\/[^/\s]+)+$/u);
const repositoryPolicy = z
  .object({
    candidates: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("enabled_catalog") }).strict(),
      z.object({ kind: z.literal("event_repository_and_related") }).strict(),
      z
        .object({
          kind: z.literal("listed"),
          repositoryKeys: z
            .array(repositoryKey)
            .min(1)
            .max(50)
            .refine((keys) => new Set(keys).size === keys.length),
        })
        .strict(),
    ]),
    expansion: z.enum(["attach", "ask_once", "never"]),
  })
  .strict();
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
    repositoryPolicy: repositoryPolicy.optional(),
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
