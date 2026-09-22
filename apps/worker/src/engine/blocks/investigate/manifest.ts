import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const MAX_RESULTS_CEILING = 10;

/**
 * The value a stored graph carries in `sources` for the chat half of this
 * block. It is this block's parameter vocabulary, written into definitions
 * people already published, not a provider core talks to: messaging reaches
 * whichever integration serves the capability. It lives here so the one place
 * outside this block that reads it (the availability resolver) names the
 * block's vocabulary rather than a provider. S12 splits this block and takes
 * the word with it (ADR-010).
 */
export const INVESTIGATE_CHAT_SOURCE = "chat";
/** The value a stored graph carries in `sources` for the issue tracker half
 *  of this block. Same reasoning as `INVESTIGATE_CHAT_SOURCE`. */
const INVESTIGATE_TRACKER_SOURCE = "issue_tracker";

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
      .optional(),
    maxResults: z.number().int().min(1).max(MAX_RESULTS_CEILING).optional(),
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:/-]+$/u).optional(),
  })
  .strict();

/** The tracker a saved template will be sent to, as far as saving needs it. */
export interface InvestigateQueryTracker {
  /** Its name, for the person reading the refusal. */
  readonly name: string;
  /** Its `issueTrackerQueries` (`IssueTrackerQueryRule` in @integrations/sdk,
   *  written out because a core block manifest imports no package). */
  readonly queries: { problem(query: string): string | null };
}

/**
 * The params schema a definition is saved against when a tracker is there to
 * ask: the query template checked by that tracker's own rule. The template is
 * written in the tracker's query language, so only the tracker can say
 * whether it would run it, and core keeps no copy of any tracker's syntax.
 * Without a tracker only the length is checked, and at run time the adapter
 * still drops a query it would not run.
 */
export function paramsSchemaForTracker(tracker: InvestigateQueryTracker) {
  return paramsSchema.superRefine((params, ctx) => {
    const template = params.issueTrackerQueryTemplate;
    if (template === undefined) return;
    const problem = tracker.queries.problem(template);
    if (problem === null) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issueTrackerQueryTemplate"],
      message: `${tracker.name} would not run this query, so the block would search without it. ${problem}`,
    });
  });
}

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
