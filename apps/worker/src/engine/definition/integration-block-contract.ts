/**
 * An integration's block, written in the language the editor and the graph
 * already speak.
 *
 * A core block's contract comes from the generated catalog plus the
 * hand-written table in `block-registry.ts`. An integration's comes from its
 * own manifest, which declares the same things: ports, parameters, bound
 * inputs, and what downstream blocks may read from its output. This module is
 * the translation, and it is the only place core knows the shape of an
 * integration block.
 */
import type { IntegrationBlockManifest } from "@integrations/sdk";
import type {
  WorkflowBlockAvailability,
  WorkflowBlockContract,
  WorkflowBlockType,
  WorkflowParamValue,
  WorkflowValueSchema,
} from "@shared/contracts";
import type { DeploymentIntegrations } from "./integration-availability.js";

/**
 * Whether this build could describe the block at all.
 *
 * Read from the contract the resolver already produced, because a caller
 * holding a contract holds the same deployment the contract came from, and a
 * second lookup against the registry would answer about a different one in a
 * test that declared its own build. `unprovided` is set in exactly one place,
 * `unknownBlockContract` below.
 */
export function buildProvidesBlockType(contract: WorkflowBlockContract): boolean {
  return contract.unprovided !== true;
}

/**
 * Where an integration's blocks sit in the palette until the editor groups
 * them under the integration's own name (plan decision 13, stage S6). The
 * groups are a closed set in the block catalog, so an entry that named one per
 * integration would be core naming a provider.
 */
const INTEGRATION_BLOCK_GROUP = "utility" as const;

/**
 * The contract of one block an integration contributes, or of one this build no
 * longer ships.
 *
 * A type nothing claims still gets a contract, with the availability its caller
 * computed: a definition published while the integration existed keeps the
 * node, and the author has to be told which integration is missing rather than
 * meeting a blank canvas or a crash.
 */
export function integrationBlockContract(
  type: WorkflowBlockType,
  integrations: DeploymentIntegrations,
  availability: WorkflowBlockAvailability,
): WorkflowBlockContract {
  const entry = integrations.blocks.get(type);
  if (!entry) return unknownBlockContract(type, availability);
  return contractFor(type, entry.block, availability);
}

/** Every integration block this build ships, as `[type, contract]` pairs. */
export function integrationBlockContracts(
  integrations: DeploymentIntegrations,
  availabilityOf: (
    type: WorkflowBlockType,
    params: Record<string, WorkflowParamValue>,
  ) => WorkflowBlockAvailability,
): [WorkflowBlockType, WorkflowBlockContract][] {
  return [...integrations.blocks.entries()].map(([type, entry]) => {
    const blockType = type as WorkflowBlockType;
    const defaults = { ...entry.block.defaults };
    return [blockType, contractFor(blockType, entry.block, availabilityOf(blockType, defaults))];
  });
}

function contractFor(
  type: WorkflowBlockType,
  block: IntegrationBlockManifest,
  availability: WorkflowBlockAvailability,
): WorkflowBlockContract {
  const properties: Record<string, WorkflowValueSchema> = {
    status: { type: "string", enum: [...block.output.statusVariants] },
    ...block.output.properties,
  };
  return {
    type,
    presentation: {
      group: INTEGRATION_BLOCK_GROUP,
      label: block.ui.label,
      description: block.ui.description,
      glyph: block.ui.glyph,
      color: block.ui.color,
      softColor: block.ui.softColor,
    },
    defaults: { ...block.defaults },
    ports: [...block.contract.ports],
    allowsFailurePort: block.contract.allowsFailurePort,
    inputs: { ...block.inputs },
    additionalInputs: [...(block.additionalInputs ?? [])],
    output: {
      // Everything the block can emit, for the run view and for a binding that
      // reads a field the block only sometimes sets.
      schema: objectSchema(properties, ["status"]),
      // What a downstream binding may count on: `status` plus exactly the
      // fields the block declared required.
      bindingSchema: objectSchema(properties, ["status", ...(block.output.required ?? [])]),
      statusVariants: [...block.output.statusVariants],
      ...(block.output.mustRead?.length ? { mustRead: [...block.output.mustRead] } : {}),
    },
    availability,
  };
}

/**
 * A node whose block type nothing in this build provides.
 *
 * One port and no inputs: the graph still has to lay the node out, draw its
 * edge and refuse the definition with a sentence, and inventing a richer shape
 * for a block nobody can describe would be guessing.
 */
function unknownBlockContract(
  type: WorkflowBlockType,
  availability: WorkflowBlockAvailability,
): WorkflowBlockContract {
  const properties: Record<string, WorkflowValueSchema> = { status: { type: "string" } };
  return {
    type,
    presentation: {
      group: INTEGRATION_BLOCK_GROUP,
      label: type,
      description: "This build ships no integration providing this block.",
      glyph: "?",
      color: "#64748B",
      softColor: "#EEF1F5",
    },
    unprovided: true,
    defaults: {},
    ports: ["out"],
    allowsFailurePort: false,
    inputs: {},
    additionalInputs: [],
    output: {
      schema: objectSchema(properties, ["status"]),
      bindingSchema: objectSchema(properties, ["status"]),
      statusVariants: [],
    },
    availability,
  };
}

function objectSchema(
  properties: Record<string, WorkflowValueSchema>,
  required: readonly string[],
): WorkflowValueSchema {
  return {
    type: "object",
    properties,
    required: [...new Set(required)].filter((key) =>
      Object.prototype.hasOwnProperty.call(properties, key),
    ),
    additionalProperties: false,
  };
}
