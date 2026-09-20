/**
 * What a briefing is served as.
 *
 * Nothing structured is ever cut to fit a page. A briefing is served as a
 * small overview, a list of section headers, and each growable child list
 * (a section's parts and redaction spans, the context's repositories, the
 * unresolved sources) as its own cursor-paged list (`pageList`). The overview
 * is bounded by construction, so it fits the default page whatever the
 * briefing holds.
 */
import { z } from "zod";
import {
  agentBriefingHarnessSchema,
  agentBriefingIdentitySchema,
  agentBriefingRepositoryContextRefSchema,
  agentBriefingSectionFieldsSchema,
  agentBriefingTotalsSchema,
  checkSectionSizes,
  type AgentBriefingIndex,
  type AgentBriefingSection,
} from "./briefing-schema";
import { AGENT_BRIEFING_PARTS_PER_SECTION_MAX, AGENT_VISIBILITY_SCHEMA_VERSION } from "./limits";
import { byteCountSchema } from "./primitives";

/**
 * Everything about a send that is not a list: which send, what harness, how
 * big, and where the repository context is. `totals.sections` says how many
 * section headers there are to page.
 */
export const agentBriefingOverviewSchema = z.object({
  schemaVersion: z.literal(AGENT_VISIBILITY_SCHEMA_VERSION),
  identity: agentBriefingIdentitySchema,
  harness: agentBriefingHarnessSchema,
  budgetBytes: byteCountSchema,
  totals: agentBriefingTotalsSchema,
  metadataRedactions: byteCountSchema,
  repositoryContext: agentBriefingRepositoryContextRefSchema.nullable(),
  unresolvedSourceCount: byteCountSchema,
});
export type AgentBriefingOverview = z.infer<typeof agentBriefingOverviewSchema>;

/** A section without its parts and spans, with how many of each it has. */
export const agentBriefingSectionHeaderSchema = agentBriefingSectionFieldsSchema
  .extend({
    partCount: z.number().int().min(0).max(AGENT_BRIEFING_PARTS_PER_SECTION_MAX),
    /** Spans listed, which a page of spans walks; `redactionCount` counts all. */
    spanCount: byteCountSchema,
    /** Summed over the parts. */
    controlCharactersStripped: byteCountSchema,
  })
  .superRefine(checkSectionSizes);
export type AgentBriefingSectionHeader = z.infer<typeof agentBriefingSectionHeaderSchema>;

export function agentBriefingOverview(index: AgentBriefingIndex): AgentBriefingOverview {
  return {
    schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION,
    identity: index.identity,
    harness: index.harness,
    budgetBytes: index.budgetBytes,
    totals: index.totals,
    metadataRedactions: index.metadataRedactions,
    repositoryContext: index.repositoryContext,
    unresolvedSourceCount: index.unresolvedSourceCount,
  };
}

export function agentBriefingSectionHeader(section: AgentBriefingSection): AgentBriefingSectionHeader {
  const { parts, redactions, ...fields } = section;
  return {
    ...fields,
    partCount: parts.length,
    spanCount: redactions.length,
    controlCharactersStripped: parts.reduce((total, part) => total + (part.controlCharactersStripped ?? 0), 0),
  };
}
