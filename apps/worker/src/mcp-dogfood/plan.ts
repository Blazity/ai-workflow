// Turns the frozen MCP contract into a probe plan.
//
// Lives outside src/mcp on purpose. That directory is the server's own code and
// a parallel stream is actively changing it; this is an operator tool that reads
// the contract and talks to a deployment over the network, so it has no business
// sharing a folder with the thing it is checking.
//
// Everything here is derived from the contract artifact rather than written out
// by hand, which is the point: when a tool is added to the contract it gets both
// of its probes with nobody editing this file. A hand-kept list would drift, and
// a drifting list reports full coverage of a surface it never touched.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type JsonSchema = {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

export type ContractTool = {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

export type Contract = {
  contractHash: string;
  errorCodes: string[];
  tools: ContractTool[];
};

/** Real identifiers an operator can supply so the happy path is really exercised. */
export type DogfoodFixtures = {
  ticketKey?: string;
  runId?: string;
  definitionId?: number;
  triggerNodeId?: string;
};

export type ProbeKind = "valid" | "invented_argument";

export type Probe = {
  tool: string;
  kind: ProbeKind;
  /** Undefined means the probe is planned but deliberately not sent. */
  args?: Record<string, unknown>;
  /** Error codes that mean the tool refused correctly rather than broke. */
  acceptedErrorCodes: string[];
  /** Set when the probe is planned but withheld, and why, so it can be reported. */
  skipped?: string;
  /** Argument names filled with a placeholder because no fixture was given. */
  placeholders: string[];
};

const DEFAULT_CONTRACT_PATH = fileURLToPath(
  new URL("../mcp/contracts/mcp-contract.json", import.meta.url),
);

export function loadContract(path: string = DEFAULT_CONTRACT_PATH): Contract {
  const contract = JSON.parse(readFileSync(path, "utf8")) as Contract;
  if (!Array.isArray(contract.tools) || contract.tools.length === 0) {
    throw new Error(`contract at ${path} declares no tools`);
  }
  return contract;
}

/**
 * A string that satisfies the schema it is given. Pattern and format come first
 * because a value that fails the schema would be refused by validation, and a
 * probe refused for the wrong reason proves nothing about the tool behind it.
 */
function sampleString(schema: JsonSchema): string {
  if (typeof schema.const === "string") return schema.const;
  if (schema.pattern) {
    // The only patterns the contract uses are anchored literal-plus-hex, so a
    // matching sample is built rather than solved. An unrecognised pattern is
    // surfaced instead of guessed, because a guess would read as a tool defect.
    const sha256 = /^\^sha256:\[0-9a-f\]\{64\}\$$/.exec(schema.pattern);
    if (sha256) return `sha256:${"0".repeat(64)}`;
    throw new Error(`no sample for pattern ${schema.pattern}`);
  }
  if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000000";
  if (schema.format === "uri") return "https://example.invalid/pull/1";
  return "dogfood-placeholder";
}

function sampleValue(schema: JsonSchema, name: string, fixtures: DogfoodFixtures, placeholders: string[]): unknown {
  // A named fixture always wins: it is the only way the valid probe reaches
  // real data instead of bouncing off NOT_FOUND.
  if (name === "ticketKey" && fixtures.ticketKey) return fixtures.ticketKey;
  if (name === "runId" && fixtures.runId) return fixtures.runId;
  if (name === "definitionId" && fixtures.definitionId !== undefined) return fixtures.definitionId;
  if (name === "triggerNodeId" && fixtures.triggerNodeId) return fixtures.triggerNodeId;

  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];

  const branches = schema.anyOf ?? schema.oneOf;
  // First branch, deterministically: the plan has to be the same on every run
  // or two reports of the same deployment stop being comparable.
  if (branches?.length) return sampleValue(branches[0]!, name, fixtures, placeholders);

  switch (schema.type) {
    case "object": {
      const value: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        const property = schema.properties?.[key];
        if (property) value[key] = sampleValue(property, key, fixtures, placeholders);
      }
      return value;
    }
    case "array":
      return schema.items ? [sampleValue(schema.items, name, fixtures, placeholders)] : [];
    case "integer":
    case "number": {
      const floor = schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : schema.minimum ?? 1;
      placeholders.push(name);
      return floor;
    }
    case "boolean":
      return true;
    default: {
      const value = sampleString(schema);
      if (value === "dogfood-placeholder") placeholders.push(name);
      return value;
    }
  }
}

/** Required arguments only: an optional argument the tool never sees cannot break it. */
export function sampleArguments(
  tool: ContractTool,
  fixtures: DogfoodFixtures,
): { args: Record<string, unknown>; placeholders: string[] } {
  const placeholders: string[] = [];
  const args = sampleValue(tool.inputSchema, tool.name, fixtures, placeholders) as Record<string, unknown>;
  return { args, placeholders };
}

/**
 * The invented argument every tool is probed with. The contract closes every
 * object with additionalProperties: false, so this is refused by the tool's own
 * validation on every tool including the ones that take no arguments at all,
 * which is what makes one universal negative probe possible. It also never
 * reaches an effect: validation runs before the tool body, so it is safe to
 * send at a mutating tool.
 *
 * The name is deliberately dull. An argument name shaped like an instruction is
 * a separate concern the server already tests, and smuggling one in here would
 * put it in the operator's report.
 */
export const INVENTED_ARGUMENT = "dogfoodNotAnArgument";

export function planProbes(
  contract: Contract,
  fixtures: DogfoodFixtures,
  options: { allowDispatch: boolean },
): Probe[] {
  const probes: Probe[] = [];
  for (const tool of contract.tools) {
    const { args, placeholders } = sampleArguments(tool, fixtures);
    // A tool that can change something is not called for real unless the
    // operator asks. Skipping it silently would be the worse failure, so the
    // probe is still planned and reports itself as withheld.
    const mutating = tool.annotations?.readOnlyHint !== true;
    const allowedMutation = tool.name === "workflows.dispatch" && options.allowDispatch;
    const withhold = mutating && !allowedMutation;
    probes.push({
      tool: tool.name,
      kind: "valid",
      ...(withhold
        ? { skipped: "mutating tool withheld; only workflows.dispatch has an explicit opt-in" }
        : { args }),
      // Placeholder identifiers cannot match real rows, so NOT_FOUND is the
      // tool working, not failing. With fixtures it still counts: the operator
      // may have handed over an identifier this deployment does not hold.
      //
      // VALIDATION_FAILED is accepted too, and reported as a coverage gap
      // rather than a defect. A tool can require "one of these two optional
      // fields", which JSON Schema here does not express, so the arguments
      // built from the contract are refused however correct the tool is.
      // Calling that a failure would cry wolf; hiding it would claim a happy
      // path nobody walked. The report names it under Coverage instead.
      acceptedErrorCodes: ["NOT_FOUND", "VALIDATION_FAILED"],
      placeholders,
    });
    probes.push({
      tool: tool.name,
      kind: "invented_argument",
      args: { ...args, [INVENTED_ARGUMENT]: 1 },
      acceptedErrorCodes: ["VALIDATION_FAILED"],
      placeholders,
    });
  }
  return probes;
}
