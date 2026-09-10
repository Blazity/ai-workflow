import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

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
