import type { z } from "zod";
import type {
  BlockUiHints,
  WorkflowBlockAdditionalInputContract,
  WorkflowBlockInputContract,
  WorkflowParamValue,
  WorkflowValueSchema,
} from "@shared/contracts";
import type { ProvidedCapabilityId } from "./capabilities";

/**
 * The manifest is what core may know about an integration without running any
 * of its code: the editor, the dashboard, the health page and the Workflow
 * DevKit's flow bundle all read it. It is plain data, so a manifest file
 * imports only this package and never a Node module.
 */
export interface IntegrationManifest {
  /**
   * Lowercase letters and digits, starting with a letter, 3 to 32 long:
   * `jira`, `slack`. It names the package (`@integrations/<id>`), the webhook
   * URL (`/webhooks/<id>`) and the screen (`/integrations/<id>`), and it
   * prefixes every block type. Words core already uses are refused; see
   * `RESERVED_INTEGRATION_IDS`.
   */
  readonly id: string;
  /** Display name on the card, the palette group and the sidebar. */
  readonly name: string;
  /** One line: what this is, for someone deciding whether to connect it. */
  readonly description: string;
  readonly docsUrl?: string;
  readonly connection: IntegrationConnection;
  /** The capabilities this integration can serve. Each needs an adapter in the runtime. */
  readonly capabilities: readonly ProvidedCapabilityId[];
  readonly blocks: readonly IntegrationBlockManifest[];
  /** Screens of its own, shown as tabs next to the core Connection tab. */
  readonly pages: readonly IntegrationPage[];
  /** At least one. Each needs a probe in the runtime. */
  readonly health: readonly IntegrationHealthCheck[];
}

export interface IntegrationConnection {
  readonly fields: readonly ConnectionField[];
}

/**
 * One value the integration needs to connect: a site URL, an account, a token.
 *
 * A connection has one source at a time, chosen per integration: the
 * environment variables its fields name, or values an admin stored from the
 * dashboard. Values never mix across the two. With nothing stored, the
 * environment is the source when every required field has its variable set.
 */
export interface ConnectionField {
  /** The value's key in `ctx.connection`, in camelCase. */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /**
   * The environment variable that carries the value when the environment is
   * the source. Every field names one, so a deployment configured through its
   * environment keeps working without anyone touching the dashboard.
   */
  readonly env: string;
  /**
   * A secret is write-only. It reaches this integration's own server code and
   * nothing else: never an API response, an MCP result, the browser or a log
   * line. It has no default and every field must state it, because a token
   * shown back on a screen is the mistake this flag exists to prevent.
   */
  readonly secret: boolean;
  /** Absent means required: the connection is incomplete without it. */
  readonly optional?: boolean;
  /** Used when the source leaves the field unset. A secret has none. */
  readonly default?: string;
  /**
   * How the value is checked and entered. `integer` reaches `ctx.connection`
   * as a number and everything else as a string. `multiline` is text such as a
   * PEM key, entered in a text area.
   */
  readonly format?: "text" | "multiline" | "url" | "integer";
}

/** A probe the health page runs against the active connection. */
export interface IntegrationHealthCheck {
  /** Unique within the integration; the runtime's probe has the same key. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** A failing critical check turns the whole integration Failing. */
  readonly critical: boolean;
}

/**
 * A screen of the integration's own: one horizontal tab in its sidebar
 * section, at `/integrations/<integration id>/<page id>`. The React side of a
 * page is designed in S7; a manifest declares the tab now so the card and the
 * sidebar can say what connecting unlocks.
 */
export interface IntegrationPage {
  /** Lowercase words joined by hyphens. `connection` is the core tab and is refused. */
  readonly id: string;
  readonly label: string;
}

/**
 * An integration block: a core block manifest (see `BlockManifest` in
 * `@shared/contracts`) without the parts core decides for every integration
 * block, plus what the block declares about its output and its needs.
 *
 * Core decides: the category (always an action), the palette group (the
 * integration), and the execution (one step of the generic integration step).
 * An integration block is exactly one step, so waiting for a person, looping
 * or sleeping stays in core and is reached through a capability.
 */
export interface IntegrationBlockManifest {
  /**
   * `<integration id>_<name>` in snake_case, for example `slack_research`. It
   * is the string stored in workflow definitions, so renaming it orphans them.
   */
  readonly type: string;
  /** Parameters an author sets in the editor. Written with the `z` this package exports. */
  readonly paramsSchema: z.ZodTypeAny;
  readonly contract: {
    /** Output ports; a block with one outcome has `["out"]`. */
    readonly ports: readonly [string, ...string[]];
    /** Whether an author may wire a failure path. */
    readonly allowsFailurePort: boolean;
  };
  readonly ui: Omit<BlockUiHints, "group">;
  readonly defaults?: Readonly<Record<string, WorkflowParamValue>>;
  /** Values bound from upstream blocks, in the block catalog's type language. */
  readonly inputs?: Readonly<Record<string, WorkflowBlockInputContract>>;
  readonly additionalInputs?: readonly WorkflowBlockAdditionalInputContract[];
  readonly output: IntegrationBlockOutput;
  readonly requires?: IntegrationBlockRequirements;
}

export interface IntegrationBlockOutput {
  /** Fields next to `status` that downstream blocks may bind. */
  readonly properties: Readonly<Record<string, WorkflowValueSchema>>;
  /** Fields always present when the block continues through a normal port. */
  readonly required?: readonly string[];
  /** Every value `status` can take; a branch downstream can test for each. */
  readonly statusVariants: readonly [string, ...string[]];
}

/**
 * What the block needs besides its own integration's connection. The editor
 * offers the block only while each need is met, and the executor's context
 * carries exactly these: a capability or `llm` the block did not declare is
 * absent from its context type.
 */
export interface IntegrationBlockRequirements {
  readonly capabilities?: readonly ProvidedCapabilityId[];
  /** The block calls `ctx.llm`, so it needs a model core can call. */
  readonly llm?: boolean;
}

/**
 * Everything the runtime's types are built from is a literal: the id, each
 * block type, each connection field key. A manifest that widened one of them,
 * usually by annotating a block `: IntegrationBlockManifest` or by building
 * the array elsewhere, would silently switch every later check off: a missing
 * executor and a misspelled connection field would both compile. These types
 * turn that into a refusal at the manifest, where the mistake is.
 */
type LiteralNames<M extends IntegrationManifest> = string extends M["id"]
  ? "The integration id must be a literal, so write it in the manifest rather than through a widened type"
  : string extends M["blocks"][number]["type"]
    ? "Every block type must be a literal, so declare blocks with defineIntegrationBlock rather than annotating them : IntegrationBlockManifest"
    : string extends M["connection"]["fields"][number]["key"]
      ? "Every connection field key must be a literal, so write the fields in the manifest rather than through a widened type"
      : unknown;

type LiteralBlockName<B extends IntegrationBlockManifest> = string extends B["type"]
  ? "A block type must be a literal, so write it here rather than through a widened type"
  : unknown;

/**
 * Declares an integration. Returns the manifest unchanged; the `const` type
 * parameter keeps ids, field keys and block types as literals, which is what
 * types the runtime against this manifest. Conformance, not this function,
 * checks the values.
 */
export function defineIntegration<const M extends IntegrationManifest>(
  manifest: M & LiteralNames<M>,
): M {
  return manifest;
}

/** Declares one block in its own file with the same literal inference. */
export function defineIntegrationBlock<const B extends IntegrationBlockManifest>(
  block: B & LiteralBlockName<B>,
): B {
  return block;
}
