import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

import { hashCanonicalJson } from "./canonical-json.js";
import { FIRST_SLICE_TOOLS, MCP_ERROR_CODES, type McpErrorCode } from "./contracts.js";
import type { McpToolPolicy } from "./policy.js";
import { MCP_TOOL_CATALOG, type McpToolDefinition } from "./tool-catalog.js";

/**
 * The published MCP contract as a value: what an agent can call, with what
 * arguments, and which error codes it may get back. Two things read it.
 *
 * 1. MCP_CONTRACT_HASH, which travels in every envelope's meta, in every audit row
 *    and in system.capabilities. It is a digest of THIS surface, so a description,
 *    an argument schema or an annotation that changes moves the hash. The hash it
 *    replaced was taken over a hand-written list of tool NAMES, which could not
 *    notice a schema change and, worse, had drifted from the error-code union it
 *    was supposed to publish.
 * 2. contracts/mcp-contract.json, the committed snapshot. `mcp:contract:check`
 *    regenerates the artifact and fails when it differs, so the surface cannot
 *    change without the diff showing what a client's view of it becomes.
 */

export type McpContractTool = {
  name: string;
  description: string;
  /** JSON Schema exactly as tools/list advertises it; see advertisedInputSchema. */
  inputSchema: Record<string, unknown>;
  annotations: McpToolPolicy["annotations"];
};

export type McpContractSurface = {
  errorCodes: readonly McpErrorCode[];
  tools: readonly McpContractTool[];
};

export type McpContractArtifact = McpContractSurface & { contractHash: string };

// mcp.js:807 keeps this private, and mcp.js:75-83 answers with it for any input
// schema normalizeObjectSchema cannot reduce to an object -- which is the case for
// system.capabilities, whose schema is wrapped in `.default({})`. Mirrored here so
// the artifact records what the client is actually served, not a schema the client
// never sees. What the server ENFORCES for that tool is still the strict object;
// the catalog explains that asymmetry where it is created.
const EMPTY_OBJECT_JSON_SCHEMA = { type: "object", properties: {} } as const;

/**
 * The same conversion tools/list performs, through the same SDK functions, so the
 * artifact cannot describe a schema in a dialect the client never receives.
 * Reimplementing zod -> JSON Schema here (or pulling in a second converter) would
 * put the artifact and the wire one library version apart.
 */
function advertisedInputSchema(definition: McpToolDefinition): Record<string, unknown> {
  const objectSchema = normalizeObjectSchema(definition.inputSchema);
  return objectSchema
    ? toJsonSchemaCompat(objectSchema, { strictUnions: true, pipeStrategy: "input" })
    : { ...EMPTY_OBJECT_JSON_SCHEMA };
}

// Iterated in FIRST_SLICE_TOOLS order, not the catalog's own key order: the array
// is the order the contract publishes, and canonicalJson preserves array order, so
// the hash covers it too.
function publishedSurface(): McpContractSurface {
  return {
    errorCodes: MCP_ERROR_CODES,
    tools: FIRST_SLICE_TOOLS.map((name) => {
      const definition = MCP_TOOL_CATALOG[name];
      return {
        name,
        description: definition.description,
        inputSchema: advertisedInputSchema(definition),
        annotations: definition.annotations,
      };
    }),
  };
}

/**
 * The digest over the surface. The two fields are picked out rather than hashed
 * whole, so handing this a full McpContractArtifact -- which is a surface plus the
 * hash, and therefore assignable -- cannot fold last run's hash into this one.
 */
export function mcpContractHash(surface: McpContractSurface): string {
  return hashCanonicalJson({ errorCodes: surface.errorCodes, tools: surface.tools });
}

export const MCP_CONTRACT_ARTIFACT: McpContractArtifact = (() => {
  const surface = publishedSurface();
  return { contractHash: mcpContractHash(surface), ...surface };
})();

export const MCP_CONTRACT_HASH = MCP_CONTRACT_ARTIFACT.contractHash;

// Resolved from this module rather than from process.cwd(), so the generator, the
// check and the test all find the one snapshot regardless of where they run from.
// Only those three read it: the readiness route and system.capabilities report
// MCP_CONTRACT_HASH, computed above, never the file, so a deployment that never
// shipped the JSON still reports the truth about itself.
export const MCP_CONTRACT_SNAPSHOT_PATH = fileURLToPath(
  new URL("./contracts/mcp-contract.json", import.meta.url),
);

/** Trailing newline included: the snapshot is a committed text file. */
export function serializeMcpContract(artifact: McpContractArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function writeMcpContractSnapshot(): void {
  writeFileSync(
    MCP_CONTRACT_SNAPSHOT_PATH,
    serializeMcpContract(MCP_CONTRACT_ARTIFACT),
    "utf8",
  );
}

export type McpContractCheckResult = { ok: boolean; message: string };

/**
 * Compares the freshly built artifact against the committed snapshot as TEXT, so
 * formatting counts too: the snapshot is only useful as a reviewable diff if the
 * only way to change it is to regenerate it.
 */
export function checkMcpContractSnapshot(): McpContractCheckResult {
  const expected = serializeMcpContract(MCP_CONTRACT_ARTIFACT);
  let committed: string;
  try {
    committed = readFileSync(MCP_CONTRACT_SNAPSHOT_PATH, "utf8");
  } catch {
    return {
      ok: false,
      message:
        `MCP contract snapshot is missing at ${MCP_CONTRACT_SNAPSHOT_PATH}.\n` +
        `Run: pnpm --filter worker mcp:contract:generate`,
    };
  }
  if (committed === expected) {
    return {
      ok: true,
      message:
        `MCP contract check passed: ${MCP_CONTRACT_ARTIFACT.tools.length} tool(s) and ` +
        `${MCP_CONTRACT_ARTIFACT.errorCodes.length} error code(s) at contract hash ` +
        `${MCP_CONTRACT_ARTIFACT.contractHash}.`,
    };
  }
  // The committed hash is quoted because it is the one number a reader needs: it
  // says whether the surface moved or only the snapshot's formatting did.
  const committedHash = readCommittedHash(committed);
  return {
    ok: false,
    message:
      "MCP contract check FAILED: the committed snapshot no longer matches the published surface.\n" +
      `  built hash:     ${MCP_CONTRACT_ARTIFACT.contractHash}\n` +
      `  committed hash: ${committedHash}\n` +
      `  snapshot:       ${MCP_CONTRACT_SNAPSHOT_PATH}\n` +
      "Run: pnpm --filter worker mcp:contract:generate, then review the diff.",
  };
}

function readCommittedHash(committed: string): string {
  try {
    const parsed: unknown = JSON.parse(committed);
    const hash = (parsed as { contractHash?: unknown }).contractHash;
    return typeof hash === "string" ? hash : "(absent)";
  } catch {
    return "(unparseable)";
  }
}
