import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({
    body: z.string().trim().max(16000).optional(),
    target: z.enum(["primary", "all"]).default("primary"),
  })
  .strict();


export const manifest = {
  type: "post_pr_comment",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "vcs",
    label: "Post PR comment",
    description: "Posts a summary or response to the pull or merge request.",
    glyph: "❞",
    color: "#3C43E7",
    softColor: "#ECECFD",
  },
  defaults: { body: "", target: "all" },
  inputs: {
    body: { required: false, schema: { type: "string" } },
  },
  execution: "map",
} satisfies BlockManifest;
