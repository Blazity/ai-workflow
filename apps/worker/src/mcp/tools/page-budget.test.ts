/**
 * The two numbers a briefing page is budgeted against, measured rather than
 * asserted.
 *
 * Both are about what a caller cannot see: the digest that replaces a result
 * over `MCP_MAX_RESULT_BYTES`, and the file a client writes a result to when it
 * is too large to show. If the envelope around a page grows (a field added to
 * `meta`, a longer contract hash), these tests go red before a page does.
 */
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../infra/vcs-config.js", () => ({
  env: {
    MCP_SERVER_VERSION: "0.1.0",
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_MAX_REQUEST_BYTES: 1_048_576,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    MCP_AUDIT_RETENTION_DAYS: 365,
  },
}));

const { settingsSnapshotFromEnvironment } = await import(
  "../../services/settings/snapshot.js"
);
const { sanitizeMcpData } = await import("../sanitize-result.js");
const { mcpEnvelopeResult } = await import("../tool-catalog.js");
const {
  MCP_CLIENT_INLINE_BYTES,
  MCP_RESULT_OVERHEAD_BYTES,
  MCP_WIRE_FACTOR,
  mcpPageBounds,
} = await import("./page-budget.js");

const settings = settingsSnapshotFromEnvironment();

/** A page of the shape this surface really serves: a list of small objects,
 *  which is the most quote-dense thing it sends and therefore the worst case
 *  for the escaped copy. */
function pageOf(bytes: number): unknown {
  const item = (index: number) => ({
    index,
    kind: "repository_instructions",
    title: `AGENTS.md of acme/service-${index}`,
    storedSha256: "a".repeat(64),
  });
  const wrap = (items: unknown[]) => ({
    schemaVersion: 1,
    cursor: null,
    items,
    shortened: [],
    nextCursor: null,
    total: items.length,
  });
  const each = Buffer.byteLength(JSON.stringify(item(0)), "utf8") + 1;
  const items = Array.from({ length: Math.max(1, Math.floor(bytes / each)) }, (_unused, at) => item(at));
  // Trim rather than grow: measuring after every push is quadratic, and this
  // builds pages of half a megabyte.
  while (items.length > 1 && Buffer.byteLength(JSON.stringify(wrap(items)), "utf8") > bytes) {
    items.pop();
  }
  return wrap(items);
}

function envelopeOf(page: unknown) {
  return sanitizeMcpData(page, {
    requestId: "11111111-1111-4111-8111-111111111111",
    traceId: "22222222-2222-4222-8222-222222222222",
    trust: "external_untrusted",
    maxBytes: 524_288,
    secrets: [],
  });
}

function wireBytes(page: unknown): number {
  return Buffer.byteLength(JSON.stringify(mcpEnvelopeResult(envelopeOf(page))), "utf8");
}

describe("the MCP page budget", () => {
  // Red when: the envelope around a page grows past what the budget reserves,
  // which would let a maximum page tip the whole result into a digest.
  it("reserves enough for everything around the page", () => {
    const bounds = mcpPageBounds(settings);
    const page = pageOf(bounds.maximum - 512);
    const pageBytes = Buffer.byteLength(JSON.stringify(page), "utf8");

    const envelope = envelopeOf(page);
    const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");

    expect(envelope.meta.truncated).toBe(false);
    expect(envelopeBytes - pageBytes).toBeLessThan(MCP_RESULT_OVERHEAD_BYTES);
    expect(envelopeBytes).toBeLessThanOrEqual(524_288);
  });

  // Red when: a page served at the default crosses what a client shows inline,
  // so every page of a briefing reaches a person as a path to a file. The
  // envelope goes out twice, once escaped, which is the whole reason the
  // default is not the package's 48 KB.
  it("keeps a default page inline after the envelope is sent twice", () => {
    const bounds = mcpPageBounds(settings);

    expect(wireBytes(pageOf(bounds.default))).toBeLessThanOrEqual(MCP_CLIENT_INLINE_BYTES);
  });

  // Red when: the wire factor is optimistic, which is the same failure as
  // above but shows it as a number rather than as a threshold.
  it("costs no more per byte than the factor the budget assumes", () => {
    const page = pageOf(16_384);
    const pageBytes = Buffer.byteLength(JSON.stringify(page), "utf8");

    const measured = (wireBytes(page) - MCP_RESULT_OVERHEAD_BYTES) / pageBytes;

    expect(measured).toBeLessThanOrEqual(MCP_WIRE_FACTOR);
  });

  // Red when: an operator lowering the result limit does not lower what this
  // surface will serve, so the digest comes back by configuration.
  it("follows the deployment's own result limit down", () => {
    const lowered = { ...settings, MCP_MAX_RESULT_BYTES: 32_768 };

    const bounds = mcpPageBounds(lowered);

    expect(bounds.maximum).toBe(32_768 - MCP_RESULT_OVERHEAD_BYTES);
    expect(bounds.default).toBeLessThanOrEqual(bounds.maximum);
  });
});
