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
    cron: z.string().default(""),
    timezone: z.string().default("UTC"),
    overlapPolicy: z.enum(["skip", "queue", "allow"]).default("skip"),
    catchUpGraceMinutes: z.number().int().min(5).default(60),
    taskTitle: z.string().default(""),
    taskDescription: z.string().default(""),
    rateLimitMax: z.number().int().min(1).optional(),
    rateLimitWindow: z.enum(["minute", "hour", "day", "month"]).optional(),
    repositoryPolicy: repositoryPolicy.optional(),
  })
  .strict();


export const manifest = {
  type: "trigger_schedule",
  paramsSchema,
  contract: {
    category: "trigger",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "trigger",
    label: "Schedule",
    description: "Starts the workflow on a recurring schedule in a timezone you configure.",
    glyph: "◷",
    color: "#D14343",
    softColor: "#FBECEC",
  },
  defaults: {
    cron: "",
    timezone: "UTC",
    overlapPolicy: "skip",
    catchUpGraceMinutes: 60,
    taskTitle: "",
    taskDescription: "",
  },
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
