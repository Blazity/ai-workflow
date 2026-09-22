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
  .regex(/^[a-z][a-z0-9_-]{2,31}:[^/\s]+(?:\/[^/\s]+)+$/u);
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
 * The review states this trigger waits for when a workflow names none: the
 * explicit "request changes" only. A plain comment is opt-in, because it needs
 * the automation account to be known (or the workflow answers its own review)
 * and because GitLab reports nothing else. The schema, the palette, dispatch
 * and the starter template all read it here.
 */
export const DEFAULT_REVIEW_TRIGGER_STATES = [
  "changes_requested",
] satisfies ("changes_requested" | "commented")[];

const paramsSchema = z
  .object({
    providers: z.array(z.string().trim().regex(/^[a-z][a-z0-9_-]{2,31}$/)).default([]),
    on: z
      .array(z.enum(["changes_requested", "commented"]))
      .min(1)
      .default([...DEFAULT_REVIEW_TRIGGER_STATES]),
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
    providers: [],
    on: DEFAULT_REVIEW_TRIGGER_STATES,
    scope: "workflow_owned",
    maxRunsPerPr: 10,
  },
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
