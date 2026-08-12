import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { McpPublicError, type McpToolName } from "./contracts.js";
import { policyFor, type McpToolPolicy } from "./policy.js";

/**
 * One source of truth for what this server offers: name -> description, input
 * schema, annotations. Two consumers read it for two different reasons and that
 * is the whole point. Every tool is registered from it through
 * registerCatalogTool below, so the SDK validates against these schemas, and the
 * transport gate validates against the same objects before the SDK ever sees the
 * call. A gate holding its own copy of a schema would drift into either refusing
 * a legal call or waving through the one the SDK then bounces for free.
 *
 * Annotations are read from policyFor, never restated here: scope, roles,
 * mutation class and the hints an agent sees have to keep agreeing.
 *
 * Deliberately imports nothing but zod, contracts and policy at runtime: the
 * gate loads this on the request path before it has decided whether a call is
 * servable, so it must not drag the database or the outbound adapters in with
 * it. The two SDK imports are types only and disappear at build time.
 */
export type McpToolDefinition = {
  description: string;
  // A strict object, or a strict object with a default, and nothing wider. The
  // default is how a tool with no required arguments accepts a call that omits
  // `arguments` altogether; see system.capabilities below.
  inputSchema: z.AnyZodObject | z.ZodDefault<z.AnyZodObject>;
  annotations: McpToolPolicy["annotations"];
};

// Jira/GitLab issue keys are short ("PROJ-1234"); this just keeps a
// pathological input from being hashed into targetRefs/audit rows for free.
const TICKET_KEY_MAX_LENGTH = 64;
const MAX_COMMENTS_LIMIT = 50;
const MAX_RUNS_LIMIT = 100;
const RUN_ID_MAX_LENGTH = 200;
const TRACE_CURSOR_MAX_LENGTH = 512;
const PR_URL_MAX_LENGTH = 2_048;
const TRIGGER_NODE_ID_MAX_LENGTH = 200;

const runIdInputSchema = z.object({ runId: z.string().trim().min(1).max(RUN_ID_MAX_LENGTH) });

const dispatchSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ticket"),
      ticketKey: z.string().trim().min(1).max(TICKET_KEY_MAX_LENGTH),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull_request"),
      url: z.string().url().max(PR_URL_MAX_LENGTH),
    })
    .strict(),
]);

const preflightInputSchema = z
  .object({
    // Named as the preflight response names it (api.ts:247), so an agent can
    // copy the field straight back into a dispatch.
    definitionId: z.number().int().positive(),
    triggerNodeId: z.string().trim().min(1).max(TRIGGER_NODE_ID_MAX_LENGTH),
    input: dispatchSubjectSchema,
  })
  .strict();

// `satisfies` against a TOTAL Record, not a type annotation: assignability
// already makes a missing entry a compile error, which is the point, and unlike
// an annotation it leaves every entry its precise schema type, so a handler
// registered from this catalog still gets its arguments typed instead of `any`.
export const MCP_TOOL_CATALOG = {
  "system.capabilities": {
    description: "Describe this authenticated MCP deployment.",
    // `.default({})` rather than a bare strict object: CallToolRequest makes
    // `arguments` optional, so a call that sends only a name is legal, and a bare
    // z.object() answers `undefined` with invalid_type. That refusal cost the
    // caller a rate-limit slot and left a `rejected` row behind for the likeliest
    // shape of an agent's very first call. Strictness is untouched, because the
    // default only fills an ABSENT object: {"extra":1} is still refused, by name.
    // One side effect worth knowing: the SDK reads a shape off an object schema
    // and finds none on a wrapped one, so tools/list advertises the empty-object
    // JSON Schema for this tool and the ADVERTISED copy loses
    // `additionalProperties: false`. What is enforced, here and in the gate, does
    // not change.
    inputSchema: z.object({}).strict().default({}),
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
  "workflows.dispatch_preflight": {
    description:
      "Resolve what a manual dispatch would run, whether it is runnable, and the digest to dispatch with.",
    inputSchema: preflightInputSchema,
    annotations: policyFor("workflows.dispatch_preflight").annotations,
  },
  "workflows.dispatch": {
    description:
      "Start a manual workflow run for exactly what workflows.dispatch_preflight resolved.",
    inputSchema: preflightInputSchema
      .extend({
        expectedDeployedVersion: z.number().int().positive(),
        preflightDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        idempotencyKey: z.string().uuid(),
      })
      .strict(),
    annotations: policyFor("workflows.dispatch").annotations,
  },
} satisfies Record<McpToolName, McpToolDefinition>;

export const MCP_ENABLED_DOMAINS = ["system", "tickets", "runs", "workflows"] as const;

const CATALOG: Record<McpToolName, McpToolDefinition> = MCP_TOOL_CATALOG;

type CatalogArgs<Name extends McpToolName> = z.output<
  (typeof MCP_TOOL_CATALOG)[Name]["inputSchema"]
>;

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
  return { name: name as McpToolName, definition: CATALOG[name as McpToolName] };
}

/**
 * The one shape a failing tool answers in, and the reason it is a shape at all:
 * the SDK's own tool-error path (server/mcp.js:139-146) forwards `error.message`
 * and drops `code`, `retryable` and `retryAfterMs`, so an agent was left reading
 * prose to decide whether to retry, wait, or give up. The message stays exactly
 * what it was; the fields that tell the agent what to DO now travel with it. The
 * gate in transport.ts answers its own refusals through here too, so where an
 * error was caught does not change how it is read.
 *
 * Only an McpPublicError is described. Anything else is a bug or an adapter
 * failure whose text may name a host, a query or a token, so it collapses onto
 * INTERNAL_ERROR with nothing of the original left, exactly as execute-tool.ts
 * already does before storing a verdict.
 */
export function mcpToolErrorResult(error: unknown): CallToolResult {
  const publicError =
    error instanceof McpPublicError
      ? error
      : new McpPublicError("INTERNAL_ERROR", "Internal error", false);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: publicError.code,
            message: publicError.message,
            retryable: publicError.retryable,
            ...(publicError.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: publicError.retryAfterMs }),
          },
        }),
      },
    ],
    isError: true,
  };
}

/**
 * How every tool in this server is registered: the catalogued definition itself
 * (never a copy), and one wrapper that turns a raised McpPublicError into the
 * structured result above. One helper rather than nine try/catch blocks, because
 * a tool that forgot the wrapper would silently go back to answering prose.
 */
export function registerCatalogTool<Name extends McpToolName>(
  server: McpServer,
  name: Name,
  handler: (input: CatalogArgs<Name>) => Promise<CallToolResult>,
): void {
  const definition: McpToolDefinition = MCP_TOOL_CATALOG[name];
  // Cast at this single boundary: the SDK has already parsed the arguments with
  // the very schema CatalogArgs is derived from, so the handler's own signature
  // stays typed off the catalog.
  server.registerTool(name, definition, async (input: unknown) => {
    try {
      return await handler(input as CatalogArgs<Name>);
    } catch (error) {
      return mcpToolErrorResult(error);
    }
  });
}
