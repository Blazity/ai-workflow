import type { z } from "zod";
import type {
  BlockOutput,
  JsonValue,
  SystemHealthMode,
  WorkflowBlockInputContract,
} from "@shared/contracts";
import type { AgentTracingAdapter } from "./agent-tracing";
import type { VcsRepositoryTarget } from "./capabilities";
import type { IntegrationRunStart, IntegrationRunState } from "./run-state";
import type { IntegrationBlockContext, IntegrationContext } from "./context";
import type { IssueTrackerAdapter } from "./issue-tracker";
import type { IntegrationBlockManifest, IntegrationManifest } from "./manifest";
import type { MemoryAdapter } from "./memory";
import type { MessagingAdapter } from "./messaging";
import type { VCSAdapter } from "./vcs";
import type { IntegrationWebhook, IntegrationWebhookReception } from "./webhook";

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
export type IntegrationRuntimeDefinition<M extends IntegrationManifest> =
  IntegrationRuntimeBase<M> & RunStateSlot<M>;

/**
 * `beginRun`, required exactly when the manifest declares `runState` and
 * refused otherwise, so the declaration and the code that serves it cannot
 * drift apart. A manifest that declared run state with nothing to create it
 * would hand every block `null` and, for a block that needs the handle, turn
 * the whole integration into a refusal nobody could explain.
 */
type RunStateSlot<M extends IntegrationManifest> = M extends { readonly runState: true }
  ? {
      /**
       * Creates this integration's per-run state, once per run. Core calls it
       * inside a step at the run's first use of the integration and records
       * the result with the run, so a suspended run comes back holding the
       * same value. It must therefore return JSON and nothing else.
       *
       * Returning `null`, or throwing, leaves the run without the handle: core
       * records that and carries on, and each use decides what to do without
       * one.
       */
      readonly beginRun: (
        start: IntegrationRunStart,
        ctx: IntegrationContext<M>,
      ) => Promise<IntegrationRunState | null>;
    }
  : { readonly beginRun?: never };

interface IntegrationRuntimeBase<M extends IntegrationManifest> {
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
   * What this integration does with a request sent to `/webhooks/<id>`: verify
   * it, say what it is, and deliver whatever core answered. See `webhook.ts`
   * for why it is two calls rather than one.
   *
   * Optional: an integration nobody calls back declares none, and the route
   * answers 404 for it.
   */
  readonly webhook?: IntegrationWebhook<M>;
  /**
   * What each of this integration's pages reads, keyed by the page id its
   * manifest declares. A page is a component in the dashboard's process with
   * no session, no database and no client of ours in its props, so this is the
   * only way it sees anything: core resolves the connection, calls the reader
   * on the server, and hands the page what it returned.
   *
   * Read-only and optional per page. A reader receives the ordinary context
   * and returns JSON, which is what reaches the browser, so nothing it returns
   * may carry a secret. A reader that throws is reported to the page as the
   * provider being unavailable, with the provider's own reason, redacted.
   */
  readonly api?: {
    readonly [PageId in M["pages"][number]["id"]]?: (
      ctx: IntegrationContext<M>,
    ) => Promise<JsonValue>;
  };
}

export type IntegrationRuntime<M extends IntegrationManifest> = IntegrationRuntimeDefinition<M> & {
  readonly manifest: M;
};

/**
 * One runtime as the generated registry holds it. Every signature here is
 * typed from a manifest, and core reads the manifest at run time rather than
 * knowing it statically, so the parameters are erased and the keys and results
 * are not: core can list an integration's blocks, health checks and
 * capabilities and use what each call returns, and the stage that builds a
 * context narrows the call once where it builds it.
 *
 * `IntegrationRuntime<IntegrationManifest>` is not that type: a block executor
 * typed against a literal block type is not assignable to one typed against
 * `IntegrationBlockManifest`, because its parameters are contravariant. Trying
 * it is how this interface came to exist.
 */
export interface ErasedIntegrationRuntime {
  readonly manifest: IntegrationManifest;
  readonly testConnection: ErasedIntegrationCall<ConnectionTestResult>;
  readonly capabilities: Readonly<Record<string, (...args: never[]) => unknown>>;
  readonly blocks: Readonly<
    Record<string, ErasedIntegrationCall<IntegrationBlockOutcome<IntegrationBlockManifest>>>
  >;
  readonly health: Readonly<Record<string, ErasedIntegrationCall<IntegrationHealthResult>>>;
  /** Present exactly when the manifest declares `runState`. */
  readonly beginRun?: ErasedIntegrationCall<IntegrationRunState | null>;
  /** One reader per page that has data behind it, keyed by page id. */
  readonly api?: Readonly<Record<string, ErasedIntegrationCall<JsonValue>>>;
  /** Present exactly when the manifest's integration answers a webhook. */
  readonly webhook?: {
    readonly receive: ErasedIntegrationCall<IntegrationWebhookReception>;
    readonly deliver?: ErasedIntegrationCall<void>;
  };
}

/** A call whose arguments core builds from the manifest rather than the type. */
export type ErasedIntegrationCall<R> = (...args: never[]) => Promise<R>;

/** Core creates adapters through these, with a fresh context whenever the connection changes. */
export interface IntegrationCapabilityFactories<M extends IntegrationManifest> {
  issue_tracker: (ctx: IntegrationContext<M>) => IssueTrackerAdapter;
  vcs: (ctx: IntegrationContext<M>, repository: VcsRepositoryTarget) => VCSAdapter;
  messaging: (ctx: IntegrationContext<M>) => MessagingAdapter;
  memory: (ctx: IntegrationContext<M>) => MemoryAdapter;
  agent_tracing: (ctx: IntegrationContext<M>) => AgentTracingAdapter;
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
