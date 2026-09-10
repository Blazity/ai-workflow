import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z
  .object({
    title: z.string().optional(),
    body: z.string().optional(),
  })
  .strict();


export const manifest = {
  type: "open_pr",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "vcs",
    label: "Open PR/MR",
    description: "Creates or reuses pull or merge requests from a successful Finalize output.",
    glyph: "⇪",
    color: "#3C43E7",
    softColor: "#ECECFD",
  },
  defaults: {
    title: "[{{ticket_key}}] {{ticket_title}}",
    body: "**Ticket:** [{{ticket_key}}]({{ticket_url}})\n\n## What changed\n{{change_summary}}",
  },
  inputs: {
    repositories: {
      required: true,
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            provider: { type: "string" },
            repoPath: { type: "string" },
            branchName: { type: "string" },
            defaultBranch: { type: "string" },
            expectedHead: { type: "string" },
            pushedHead: { type: "string" },
          },
          required: [
            "provider",
            "repoPath",
            "branchName",
            "defaultBranch",
            "expectedHead",
            "pushedHead",
          ],
          additionalProperties: false,
        },
      },
    },
    title: { required: false, schema: { type: "string" } },
    body: { required: false, schema: { type: "string" } },
  },
  execution: "inline",
} satisfies BlockManifest;
