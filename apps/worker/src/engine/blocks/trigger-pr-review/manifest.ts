import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

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
    providers: z.array(z.enum(["github", "gitlab"])).min(1).default(["github"]),
    on: z
      .array(z.enum(["changes_requested", "commented"]))
      .min(1)
      .default(["changes_requested"]),
    scope: z.enum(["workflow_owned", "any"]).default("workflow_owned"),
    maxRunsPerPr: z.number().int().min(1).max(30).default(10),
    rateLimitMax: z.number().int().min(1).optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day", "month"]).optional(),
    repositoryPolicy: repositoryPolicy.optional(),
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
