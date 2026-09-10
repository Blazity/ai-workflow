import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({ checkName: z.string().trim().min(1).max(200) })
  .strict();


export const manifest = {
  type: "create_pr_check",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: false,
  },
  ui: {
    group: "vcs",
    label: "Create PR check",
    description: "Creates a pending check for the exact pull request commit being reviewed.",
    glyph: "◌",
    color: "#3C43E7",
    softColor: "#ECECFD",
  },
  defaults: { checkName: "AI Workflow / Review" },
  inputs: {},
  execution: "map",
} satisfies BlockManifest;
