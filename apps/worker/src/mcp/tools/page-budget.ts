/**
 * How big a page of a briefing or a round may be when a TOOL serves it.
 *
 * The package's own ceiling is `MCP_MAX_RESULT_BYTES` exactly, and that is the
 * wrong number here for two reasons a caller cannot see:
 *
 * 1. `sanitizeMcpData` measures `{ data, meta }`, so a page AT the ceiling plus
 *    its meta is over it and the whole result becomes a digest. A briefing
 *    replaced by `sha256:...` is the one answer this feature must never give.
 * 2. `mcpEnvelopeResult` sends the envelope TWICE, once as `structuredContent`
 *    and once as a JSON string inside a text block, where every quote and
 *    backslash costs two bytes. So a page crosses the wire at more than twice
 *    its own size, and a client that shows about 48 KB inline writes anything
 *    larger to a file. A path to a file is not a prompt anybody can read.
 *
 * So the tool has its own default and its own maximum, derived from those two
 * numbers, and refuses a larger request by name instead of letting either
 * happen. HTTP keeps the package's cap, because neither reason applies there.
 * THE SAME (offset, limit) STILL RETURNS THE SAME BYTES ON BOTH SURFACES: only
 * what each asks for by default differs.
 *
 * The three constants below are measured, not guessed: `page-budget.test.ts`
 * builds a real worst-case page, sends it through `mcpEnvelopeResult` and
 * `sanitizeMcpData`, and fails when the envelope grows past what they reserve.
 */
import type { SettingsSnapshot } from "@shared/contracts";

import {
  AGENT_VISIBILITY_PAGE_MAX_BYTES,
  AGENT_VISIBILITY_PAGE_MIN_BYTES,
  type PageBounds,
} from "../../services/agent-visibility/index.js";
import { mcpSettings } from "../../services/settings/runtime-settings.js";

/** What an MCP client shows inline. Above it, Claude Code saves the result to
 *  a file and prints a path. */
export const MCP_CLIENT_INLINE_BYTES = 48 * 1024;

/**
 * What one page costs on the wire per byte of itself: two copies, one of them
 * a JSON string whose quotes and backslashes are escaped.
 *
 * 2.3 rather than 2.0 because the escaped copy of a page of small objects is
 * about 15% larger than the page (every key and every string value carries two
 * escaped quotes). MEASURED OVER A LIST PAGE OF SECTION HEADERS, which is the
 * most quote-dense shape this surface serves, so it is conservative for a page
 * of section TEXT, where the escaping is nearly free and the real cost is close
 * to 2.0. Conservative in the safe direction: a page comes out smaller than a
 * client will show, never larger.
 */
export const MCP_WIRE_FACTOR = 2.3;

/**
 * Everything around the page: `meta` (request and trace ids, the server
 * version, the contract hash, the trust label, the counters), the `content`
 * wrapper, `structuredContent`, and the JSON-RPC frame. Reserved once, on both
 * sides of the budget.
 */
export const MCP_RESULT_OVERHEAD_BYTES = 1_024;

function clamp(value: number): number {
  return Math.min(Math.max(Math.floor(value), AGENT_VISIBILITY_PAGE_MIN_BYTES), AGENT_VISIBILITY_PAGE_MAX_BYTES);
}

/**
 * The default and the maximum a tool serves under this deployment's settings.
 *
 * The maximum keeps the result off the digest path; the default keeps it off
 * the file path. An operator who lowers `MCP_MAX_RESULT_BYTES` lowers both.
 */
export function mcpPageBounds(settings: SettingsSnapshot): PageBounds {
  const maximum = clamp(mcpSettings(settings).maxResultBytes - MCP_RESULT_OVERHEAD_BYTES);
  const wanted = clamp((MCP_CLIENT_INLINE_BYTES - MCP_RESULT_OVERHEAD_BYTES) / MCP_WIRE_FACTOR);
  return { default: Math.min(wanted, maximum), maximum };
}
