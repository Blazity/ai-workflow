import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const repositoryScriptGroupNameSchema = z
  .string()
  .max(40, "group name must be at most 40 characters")
  .regex(
    /^[a-z][a-z0-9-]*$/u,
    "group name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
  );
const paramsSchema = z
  .object({
    commands: z.array(z.string().trim().min(1)).optional(),
    groups: z.array(repositoryScriptGroupNameSchema).min(1).optional(),
    skipReason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.skipReason && (value.commands?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skipReason"],
        message: "Skip reason cannot be combined with commands.",
      });
    }
    if (value.skipReason && (value.groups?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skipReason"],
        message: "Skip reason cannot be combined with groups.",
      });
    }
    if ((value.groups?.length ?? 0) > 0 && (value.commands?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groups"],
        message: "Groups cannot be combined with explicit commands.",
      });
    }
  });

export { repositoryScriptGroupNameSchema };


export const manifest = {
  type: "run_checks",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "utility",
    label: "Run checks",
    description: "Legacy: runs configured or explicit validation commands in the workspace. Use Run scripts instead, which reports per-group verdicts and coverage.",
    glyph: "✓",
    color: "#64748B",
    softColor: "#EEF1F5",
  },
  defaults: { commands: [] },
  inputs: {},
  execution: "map",
} satisfies BlockManifest;
