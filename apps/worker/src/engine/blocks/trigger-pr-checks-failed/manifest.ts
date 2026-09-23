import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

// `INTEGRATION_ID` from @shared/contracts, copied because a manifest may import
// it only as a type; `trigger-provider-rule-sync.test.ts` holds the copies equal.
const vcsProviderSelection = z.array(z.string().trim().regex(/^[a-z][a-z0-9]{2,31}$/u));
// The trigger's optional repository policy. Kept in step by hand with
// `triggerRepositoryPolicySchema` in @shared/contracts, which a manifest may
// import only as a type. Deliberately no default.
const repositoryKey = z
  .string()
  .trim()
  .toLowerCase()
  .max(207)
  .regex(/^[a-z][a-z0-9]{2,31}:[^/\s]+(?:\/[^/\s]+)+$/u);
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
/**
 * The most producers one node may trust. It is the sum of the two lists it
 * replaced (`githubAppSlugs` and `gitlabPipelineSources`, 20 each): a graph
 * saved with both full is upgraded into this one list and must still validate.
 */
export const MAX_TRUSTED_PRODUCERS = 40;

const paramsSchema = z
  .object({
    providers: vcsProviderSelection.default([]),
    scope: z.enum(["workflow_owned", "any"]).default("workflow_owned"),
    checkNames: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    ignoreCheckNames: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    trustedProducers: z
      .array(z.string().trim().min(1).max(100))
      .max(MAX_TRUSTED_PRODUCERS)
      .default([]),
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
    providers: [],
    scope: "workflow_owned",
    checkNames: [],
    ignoreCheckNames: [],
    trustedProducers: [],
    maxFixAttemptsPerPr: 2,
  },
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
