import { z } from "zod";

import type { McpToolName } from "./contracts.js";
import { policyFor, type McpToolPolicy } from "./policy.js";

/**
 * One source of truth for what this server offers: name -> description, input
 * schema, annotations. Two consumers read it for two different reasons and that
 * is the whole point. The tool modules register from it, so the SDK validates
 * against these schemas, and the transport gate validates against the same
 * objects before the SDK ever sees the call. A gate holding its own copy of a
 * schema would drift into either refusing a legal call or waving through the
 * one the SDK then bounces for free.
 *
 * Annotations are read from policyFor, never restated here: scope, roles,
 * mutation class and the hints an agent sees have to keep agreeing.
 *
 * Deliberately imports nothing but zod, contracts and policy: the gate loads
 * this on the request path before it has decided whether a call is servable, so
 * it must not drag the database or the outbound adapters in with it.
 */
export type McpToolDefinition = {
  description: string;
  inputSchema: z.AnyZodObject;
  annotations: McpToolPolicy["annotations"];
};

// Jira/GitLab issue keys are short ("PROJ-1234"); this just keeps a
// pathological input from being hashed into targetRefs/audit rows for free.
const TICKET_KEY_MAX_LENGTH = 64;
const MAX_COMMENTS_LIMIT = 50;
const MAX_RUNS_LIMIT = 100;
const RUN_ID_MAX_LENGTH = 200;
const TRACE_CURSOR_MAX_LENGTH = 512;

const runIdInputSchema = z.object({ runId: z.string().trim().min(1).max(RUN_ID_MAX_LENGTH) });

// `satisfies`, not a type annotation: each entry keeps its precise schema type,
// so a handler registered from this catalog still gets its arguments typed.
export const MCP_TOOL_CATALOG = {
  "system.capabilities": {
    description: "Describe this authenticated MCP deployment.",
    // Still restated in server.ts, which registers this one tool and is C1's
    // file to rewire. Identical by construction today, and the catalog test
    // pins the strictness the gate relies on.
    inputSchema: z.object({}).strict(),
    annotations: policyFor("system.capabilities").annotations,
  },
  "tickets.get": {
    description: "Fetch a ticket's fields, status, labels and (optionally) its comments.",
    inputSchema: z
      .object({
        ticketKey: z.string().min(1).max(TICKET_KEY_MAX_LENGTH),
        includeComments: z.boolean().optional(),
        commentsLimit: z.number().int().min(1).max(MAX_COMMENTS_LIMIT).optional(),
      })
      .strict(),
    annotations: policyFor("tickets.get").annotations,
  },
  "tickets.list_runs": {
    description: "List runs associated with a ticket, most recent first.",
    inputSchema: z
      .object({
        ticketKey: z.string().min(1).max(TICKET_KEY_MAX_LENGTH),
        limit: z.number().int().min(1).max(MAX_RUNS_LIMIT).optional(),
      })
      .strict(),
    annotations: policyFor("tickets.list_runs").annotations,
  },
  "runs.get": {
    description:
      "Get a run's current status. Returns `terminal` and `pollAfterMs` so a caller knows whether to poll again and how soon.",
    inputSchema: runIdInputSchema.strict(),
    annotations: policyFor("runs.get").annotations,
  },
  "runs.trace": {
    description:
      "Fetch a page of a run's captured block-attempt trace (workflow replay), most recent attempt first. `availability` is `not_captured` or `expired` when there is nothing to page through -- that is a real state, not an empty page.",
    inputSchema: runIdInputSchema
      .extend({ cursor: z.string().trim().min(1).max(TRACE_CURSOR_MAX_LENGTH).optional() })
      .strict(),
    annotations: policyFor("runs.trace").annotations,
  },
  "runs.result": {
    description:
      "Get a run's final outcome. While the run is still in progress this returns `result: null` and `terminal: false` -- never a partial result that looks final.",
    inputSchema: runIdInputSchema.strict(),
    annotations: policyFor("runs.result").annotations,
  },
  "runs.diagnose": {
    description:
      "Deterministically classify why a run stands where it does (category, confidence, evidence refs, next actions). Never runs a model over log content.",
    inputSchema: runIdInputSchema.strict(),
    annotations: policyFor("runs.diagnose").annotations,
  },
} satisfies Partial<Record<McpToolName, McpToolDefinition>>;

const CATALOG: Partial<Record<McpToolName, McpToolDefinition>> = MCP_TOOL_CATALOG;

/**
 * Resolves a caller-supplied string against the catalog. Returns the narrowed
 * name alongside its definition, so a caller that got past this never has to
 * assert a raw string is a tool name. `Object.hasOwn` and not `in`: "toString"
 * is not a tool this server offers.
 */
export function catalogedTool(
  name: string,
): { name: McpToolName; definition: McpToolDefinition } | null {
  if (!Object.hasOwn(CATALOG, name)) return null;
  const definition = CATALOG[name as McpToolName];
  return definition ? { name: name as McpToolName, definition } : null;
}
