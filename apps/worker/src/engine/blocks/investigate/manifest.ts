import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const MAX_RESULTS_CEILING = 10;
function hasBalancedJqlStructure(clause: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < clause.length; index += 1) {
    const char = clause[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !quoted;
}
const paramsSchema = z
  .object({
    providers: z.array(z.enum(["jira", "slack"])).min(1).default(["jira", "slack"]),
    slackChannels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    slackLookbackDays: z.number().int().min(1).max(365).optional(),
    jiraJqlTemplate: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine(hasBalancedJqlStructure, "JQL template has unbalanced parentheses or quotes")
      .optional(),
    maxResults: z.number().int().min(1).max(MAX_RESULTS_CEILING).optional(),
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:/-]+$/u).optional(),
  })
  .strict();


export const manifest = {
  type: "investigate",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "ticket",
    label: "Investigate",
    description: "Searches Jira and Slack for context on the ticket and builds an evidence-backed classification and theory for a human decision. Jira is always scoped to the configured project and Slack to the configured channels; a JQL template narrows within that project and cannot widen past it. Read-only: it never mutates the ticket, so every path leaving this block MUST end in a ticket mutation (Update ticket status or a label) or a Human question, otherwise the trigger poller re-runs the investigation (two LLM calls) on every poll.",
    glyph: "⌕",
    color: "#2563EB",
    softColor: "#E9EFFD",
  },
  defaults: {
    providers: ["jira", "slack"],
    slackLookbackDays: 30,
    maxResults: 10,
  },
  inputs: {},
  execution: "map",
} satisfies BlockManifest;
