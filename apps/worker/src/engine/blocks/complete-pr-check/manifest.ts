import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({
    conclusion: z.enum(["success", "failure", "neutral"]),
    details: z.string().max(10_000).optional(),
    refreshHead: z.boolean().optional(),
  })
  .strict();


export const manifest = {
  type: "complete_pr_check",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "vcs",
    label: "Complete PR check",
    description: "Completes a check created by this workflow run.",
    glyph: "●",
    color: "#3C43E7",
    softColor: "#ECECFD",
  },
  defaults: { conclusion: "success", details: "", refreshHead: false },
  inputs: {
    check: {
      required: true,
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          headSha: { type: "string" },
          name: { type: "string" },
        },
        required: ["id", "headSha", "name"],
        additionalProperties: false,
      },
    },
    details: { required: false, schema: { type: "string" } },
  },
  execution: "map",
} satisfies BlockManifest;
