import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "fetch_pr_context",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "vcs",
    label: "Fetch PR context",
    description: "Loads review comments, check results, and conflict state for the PR or MR.",
    glyph: "⇊",
    color: "#3C43E7",
    softColor: "#ECECFD",
  },
  defaults: {},
  inputs: {},
  execution: "map",
} satisfies BlockManifest;
