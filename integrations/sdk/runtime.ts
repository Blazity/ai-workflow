import type { z } from "zod";
import type {
  BlockOutput,
  SystemHealthMode,
  WorkflowBlockInputContract,
} from "@shared/contracts";
import type { VcsRepositoryTarget } from "./capabilities";
import type { IntegrationBlockContext, IntegrationContext } from "./context";
import type { IssueTrackerAdapter } from "./issue-tracker";
import type { IntegrationBlockManifest, IntegrationManifest } from "./manifest";
import type { MessagingAdapter } from "./messaging";
import type { VCSAdapter } from "./vcs";

/**
 * The worker entry of an integration: the code behind its manifest. Core
 * imports it only from worker steps and routes, never from workflow code, so
 * it may use Node and any provider SDK. Every key is typed from the manifest:
 * a declared block without an executor, a declared capability without an
 * adapter or a declared health check without a probe does not compile.
 *
 * None of these functions carries a step directive. Core runs each block in
 * one generic integration step, which is what keeps a moved or renamed
 * integration from stranding a run.
 *
 * Core never re-runs a block executor that has started: the generic
 * integration step sets no retries, the way core's own side-effecting steps
 * do, so a block that posts a comment and then throws does not post it twice.
 * Retrying a transient failure is the integration's own business, through
 * `ctx.http`. Throw `FatalError` when retrying cannot help at all: core stops
 * there and never retries the call, wherever it was made from.
 */
export interface IntegrationRuntimeDefinition<M extends IntegrationManifest> {
  /**
   * Proves that `ctx.connection` works, cheaply. Core runs it before stored
   * values become active and when an admin presses Test. A refusal reports
   * the provider's own reason; core redacts secrets from it before anyone
   * sees it.
   */
  readonly testConnection: (ctx: IntegrationContext<M>) => Promise<ConnectionTestResult>;
  readonly capabilities: {
    readonly [C in M["capabilities"][number]]: IntegrationCapabilityFactories<M>[C];
  };
  readonly blocks: {
    readonly [B in M["blocks"][number] as B["type"]]: IntegrationBlockExecutor<M, B>;
  };
  readonly health: {
    readonly [H in M["health"][number] as H["id"]]: (
      ctx: IntegrationContext<M>,
    ) => Promise<IntegrationHealthResult>;
  };
  /**
   * Reserved for S9, which designs webhook translation: a handler verifies a
   * provider request and returns normalized core events, and core dispatches
   * them. Pull request events already have a normalized shape
   * (`TriggerEvent` in `@shared/contracts`) that S9 starts from; ticket and
   * slash command events have none yet.
   */
  readonly webhook?: never;
  /**
   * Reserved for S8, which designs the worker handlers an integration's own
   * pages read their data from.
   */
  readonly api?: never;
}

export interface IntegrationRuntime<M extends IntegrationManifest>
  extends IntegrationRuntimeDefinition<M> {
  readonly manifest: M;
}

/** Core creates adapters through these, with a fresh context whenever the connection changes. */
export interface IntegrationCapabilityFactories<M extends IntegrationManifest> {
  issue_tracker: (ctx: IntegrationContext<M>) => IssueTrackerAdapter;
  vcs: (ctx: IntegrationContext<M>, repository: VcsRepositoryTarget) => VCSAdapter;
  messaging: (ctx: IntegrationContext<M>) => MessagingAdapter;
}

export type ConnectionTestResult =
  | { readonly ok: true; readonly message?: string }
  | { readonly ok: false; readonly reason: string };

export interface IntegrationHealthResult {
  readonly status: Extract<SystemHealthMode, "live" | "degraded" | "down">;
  readonly message?: string;
}

export type IntegrationBlockExecutor<
  M extends IntegrationManifest,
  B extends IntegrationBlockManifest,
> = (
  invocation: IntegrationBlockInvocation<B>,
  ctx: IntegrationBlockContext<M, B>,
) => Promise<IntegrationBlockOutcome<B>>;

/** What the workflow handed the block: its parameters, parsed, and its bound inputs. */
export interface IntegrationBlockInvocation<B extends IntegrationBlockManifest> {
  readonly params: z.output<B["paramsSchema"]>;
  readonly inputs: BlockInputs<B>;
}

/**
 * `next` continues through `port` (the first port when omitted) with an output
 * downstream blocks can bind. `failed` is an expected failure: `message` is
 * what a person reads in the run view and the ticket comment, `detail` goes to
 * the log. A thrown error is an unexpected failure. Core re-runs none of them.
 */
export type IntegrationBlockOutcome<B extends IntegrationBlockManifest> =
  | {
      readonly kind: "next";
      readonly output: IntegrationBlockOutputValue<B>;
      readonly port?: B["contract"]["ports"][number];
    }
  | { readonly kind: "failed"; readonly message: string; readonly detail?: string };

/**
 * The output of a block: `status` narrowed to the variants it declared, the
 * fields it declared as required, and any other JSON the graph may carry. The
 * required fields are typed from the manifest, so a block that promises
 * downstream bindings a field cannot forget it or give it another type.
 */
export type IntegrationBlockOutputValue<B extends IntegrationBlockManifest> = BlockOutput & {
  readonly status: B["output"]["statusVariants"][number];
} & RequiredOutputFields<B>;

type RequiredOutputFields<B extends IntegrationBlockManifest> = B["output"]["required"] extends
  readonly (infer K)[]
  ? {
      readonly [P in K & keyof B["output"]["properties"]]: SchemaValue<
        B["output"]["properties"][P]
      >;
    }
  : unknown;

type BlockInputs<B extends IntegrationBlockManifest> = B["inputs"] extends Readonly<
  Record<string, WorkflowBlockInputContract>
>
  ? {
      readonly [K in keyof B["inputs"]]: B["inputs"][K] extends { readonly required: true }
        ? SchemaValue<B["inputs"][K]["schema"]>
        : SchemaValue<B["inputs"][K]["schema"]> | undefined;
    }
  : Readonly<Record<string, never>>;

/** The block catalog's type language, read as TypeScript. */
type SchemaValue<S> = S extends { readonly type: "string" }
  ? string
  : S extends { readonly type: "number" }
    ? number
    : S extends { readonly type: "boolean" }
      ? boolean
      : S extends { readonly type: "null" }
        ? null
        : S extends { readonly type: "nullable"; readonly value: infer V }
          ? SchemaValue<V> | null
          : S extends { readonly type: "array"; readonly items: infer I }
            ? SchemaValue<I>[]
            : S extends { readonly type: "object" }
              ? Readonly<Record<string, unknown>>
              : unknown;

/**
 * Pairs a manifest with its implementation. The manifest's literal types
 * decide every key the definition must have, and what each block's params,
 * inputs, context and output are.
 */
export function defineIntegrationRuntime<M extends IntegrationManifest>(
  manifest: M,
  definition: IntegrationRuntimeDefinition<M>,
): IntegrationRuntime<M> {
  return { ...definition, manifest };
}

