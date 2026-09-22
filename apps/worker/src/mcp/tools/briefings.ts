/**
 * `runs.briefing`: what a run's agents were really sent, as a tool.
 *
 * The MCP half of the `/api/v1/runs/{runId}/briefings` routes, over the SAME
 * read model, because the point of this stage is that a person and an agent
 * debugging one run cannot be shown different things. This file does MCP error
 * codes and the transport's own page budget, and nothing else: every rule about
 * what a briefing is, who may read it and how it pages lives in
 * `services/agent-visibility`.
 *
 * Registered last (server.ts) because `FIRST_SLICE_TOOLS` appends these two
 * last and the contract artifact pins `tools/list` to that order.
 *
 * `workflows.node_briefing` lives here too rather than beside the workflow
 * authoring tools: it is the same read model and the same page budget, asked
 * from the definition end.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  AgentVisibilityReadError,
  connectedBriefingReads,
  connectedNodeBriefingReadsOf,
  readBriefingAttempts,
  readBriefingRepositoryContext,
  readBriefingSectionPage,
  readBriefingSectionParts,
  readBriefingSections,
  readBriefingSectionSpans,
  readBriefingUnresolvedSources,
  readNodeLastBriefing,
  type PageBounds,
} from "../../services/agent-visibility/index.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpRead } from "../execute-tool.js";
import { mcpEnvelopeResult, registerCatalogTool } from "../tool-catalog.js";
import { mcpPageBounds } from "./page-budget.js";

type BriefingView =
  | "attempts"
  | "sections"
  | "section"
  | "parts"
  | "spans"
  | "repository_context"
  | "unresolved_sources";

/** The read model's refusals, as MCP error codes. The sentence is kept because
 *  it is what tells an agent what to ask for instead. */
function asPublicError(error: unknown): unknown {
  if (!(error instanceof AgentVisibilityReadError)) return error;
  return new McpPublicError(error.mcpCode, error.message, false);
}

function refused(message: string): McpPublicError {
  return new McpPublicError("VALIDATION_FAILED", message, false);
}

/** A field the chosen view needs and the call did not carry. Refused by name,
 *  so an agent that guessed the wrong view learns which one it wanted. */
function required<T>(value: T | undefined, field: string, view: BriefingView): T {
  if (value === undefined) {
    throw refused(
      `The "${view}" view of runs.briefing needs ${field}. Call it with view "attempts" first: every briefing it lists carries the briefingId, and every section header carries its sectionIndex.`,
    );
  }
  return value;
}

export function registerBriefingTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(server, "runs.briefing", async (input) => {
    const view: BriefingView = input.view ?? "attempts";
    const bounds = mcpPageBounds(deps.settings);
    const envelope = await executeMcpRead({
      deps,
      toolName: "runs.briefing",
      targetRefs: [input.runId],
      operation: async () => {
        try {
          return await serve(input, view, bounds, deps.actor.organizationId);
        } catch (error) {
          throw asPublicError(error);
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  // The same read model, addressed from the definition instead of from a run,
  // because that is where the operator asking the question is standing.
  registerCatalogTool(server, "workflows.node_briefing", async (input) => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "workflows.node_briefing",
      targetRefs: [String(input.definitionId), input.nodeId],
      operation: async () => {
        try {
          return await readNodeLastBriefing(
            connectedNodeBriefingReadsOf(connectedBriefingReads),
            {
              definitionId: input.definitionId,
              nodeId: input.nodeId,
              organizationId: deps.actor.organizationId,
              bounds: mcpPageBounds(deps.settings),
            },
          );
        } catch (error) {
          throw asPublicError(error);
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });
}

type BriefingInput = {
  runId: string;
  view?: BriefingView;
  nodeId?: string;
  attempt?: number;
  activationScopeId?: string;
  briefingId?: number;
  sectionIndex?: number;
  offset?: number;
  cursor?: string;
  limit?: number;
};

async function serve(
  input: BriefingInput,
  view: BriefingView,
  bounds: PageBounds,
  organizationId: string,
): Promise<unknown> {
  // Refused rather than clamped: an agent handed a smaller page than it asked
  // for cannot tell that from a shorter list, and the numbers it may ask for
  // are not the package's here (see page-budget.ts).
  if (input.limit !== undefined && input.limit > bounds.maximum) {
    throw refused(
      `Over MCP a page of a briefing is at most ${bounds.maximum} bytes, because the whole result is replaced by a digest above the server's result limit and this tool never lets that happen; ${input.limit} was asked for. Leaving limit out serves ${bounds.default} bytes, which a client still shows inline.`,
    );
  }
  const paging = {
    bounds,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
  const run = { runId: input.runId, organizationId };
  if (view === "attempts") {
    return readBriefingAttempts(connectedBriefingReads, {
      ...run,
      ...paging,
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
      ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
      ...(input.activationScopeId === undefined
        ? {}
        : { activationScopeId: input.activationScopeId }),
    });
  }
  const briefing = { ...run, ...paging, briefingId: required(input.briefingId, "a briefingId", view) };
  switch (view) {
    case "sections":
      return readBriefingSections(connectedBriefingReads, briefing);
    case "repository_context":
      return readBriefingRepositoryContext(connectedBriefingReads, briefing);
    case "unresolved_sources":
      return readBriefingUnresolvedSources(connectedBriefingReads, briefing);
    case "section":
      return readBriefingSectionPage(connectedBriefingReads, {
        ...run,
        bounds,
        briefingId: briefing.briefingId,
        sectionIndex: required(input.sectionIndex, "a sectionIndex", view),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    case "parts":
      return readBriefingSectionParts(connectedBriefingReads, {
        ...briefing,
        sectionIndex: required(input.sectionIndex, "a sectionIndex", view),
      });
    case "spans":
      return readBriefingSectionSpans(connectedBriefingReads, {
        ...briefing,
        sectionIndex: required(input.sectionIndex, "a sectionIndex", view),
      });
  }
}
