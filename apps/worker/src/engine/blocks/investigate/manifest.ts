import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const MAX_RESULTS_CEILING = 10;

/**
 * The value a stored graph carries in `sources` for the chat half of this
 * block. It is this block's parameter vocabulary, written into definitions
 * people already published, not a provider core talks to: messaging reaches
 * whichever integration serves the capability. It lives here, read through
 * `investigateSources` below, so the availability resolver names the block's
 * vocabulary rather than a provider. S12 splits this block and takes the word
 * with it (ADR-010).
 */
const INVESTIGATE_CHAT_SOURCE = "chat";
/** The value a stored graph carries in `sources` for the issue tracker half
 *  of this block. Same reasoning as `INVESTIGATE_CHAT_SOURCE`. */
const INVESTIGATE_TRACKER_SOURCE = "issue_tracker";

/**
 * Which halves of the block a node turns on, read by the block's own execution
 * and by the availability resolver, so the capabilities a node is said to use
 * are the ones it runs with. Mirrors the dashboard's `investigateSources`.
 *
 * Accepts both the capability vocabulary (`issue_tracker`, `chat`) and the old
 * provider vocabulary (`jira`, `slack`, and the `providers` key), because a run
 * suspended before the rename replays a recorded plan built with the old words:
 * without this tolerance that run would resume investigating nothing. An absent
 * or unreadable list means both are on: the schema defaults it that way, and a
 * node whose selection cannot be read should investigate everything rather than
 * silently investigate nothing.
 */
export function investigateSources(
  params: Readonly<Record<string, unknown>> | undefined,
): { issueTracker: boolean; chat: boolean } {
  const raw = params?.sources ?? params?.providers;
  if (!Array.isArray(raw)) return { issueTracker: true, chat: true };
  return {
    issueTracker: raw.includes(INVESTIGATE_TRACKER_SOURCE) || raw.includes("jira"),
    chat: raw.includes(INVESTIGATE_CHAT_SOURCE) || raw.includes("slack"),
  };
}

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
    sources: z
      .array(z.enum([INVESTIGATE_TRACKER_SOURCE, INVESTIGATE_CHAT_SOURCE]))
      .min(1)
      .default([INVESTIGATE_TRACKER_SOURCE, INVESTIGATE_CHAT_SOURCE]),
    chatChannels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    chatLookbackDays: z.number().int().min(1).max(365).optional(),
    issueTrackerQueryTemplate: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine(hasBalancedJqlStructure, "Query template has unbalanced parentheses or quotes")
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
    description: "Searches this deployment's issue tracker and chat for context on the ticket and builds an evidence-backed classification and theory for a human decision. The issue tracker search is always scoped to the project the connection names, and chat to the configured channels; a query template narrows within that scope and cannot widen past it. Read-only: it never mutates the ticket, so every path leaving this block MUST end in a ticket mutation (Update ticket status or a label) or a Human question, otherwise the trigger poller re-runs the investigation (two LLM calls) on every poll.",
    glyph: "⌕",
    color: "#2563EB",
    softColor: "#E9EFFD",
  },
  defaults: {
    sources: [INVESTIGATE_TRACKER_SOURCE, INVESTIGATE_CHAT_SOURCE],
    chatLookbackDays: 30,
    maxResults: 10,
  },
  inputs: {},
  execution: "map",
} satisfies BlockManifest;
