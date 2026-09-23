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
import type { IssueTrackerAdapter, IssueTrackerQueryRule } from "./issue-tracker";
import type { IntegrationBlockManifest, IntegrationManifest } from "./manifest";
import type { MemoryAdapter } from "./memory";
import type { MessagingAdapter } from "./messaging";
import type { VCSAdapter, VcsHandleIdentity } from "./vcs";
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
  IntegrationRuntimeBase<M> & RunStateSlot<M> & IssueTrackerQueryRuleSlot<M> & VcsHandlesSlot<M>;

/**
 * `issueTrackerQueryRule`, required exactly when the manifest declares the
 * `issue_tracker` capability and refused otherwise: how this tracker reads a
 * query an author typed, for core to ask without a connection when a
 * definition is saved and before the investigate block searches (see
 * `IssueTrackerQueryRule`). A tracker that could drop a query at run time and
 * not say so would leave the author with a search that quietly ignores them.
 */
type IssueTrackerQueryRuleSlot<M extends IntegrationManifest> = "issue_tracker" extends M["capabilities"][number]
  ? { readonly issueTrackerQueryRule: IssueTrackerQueryRule }
  : { readonly issueTrackerQueryRule?: never };

/**
 * `vcsHandles`, required exactly when the manifest declares the `vcs`
 * capability and refused otherwise: how this provider's handles compare, for
 * core to call without a connection (see `VcsHandleIdentity`). A provider that
 * could mint handles and not compare them would bind no failed check at all.
 */
type VcsHandlesSlot<M extends IntegrationManifest> = "vcs" extends M["capabilities"][number]
  ? { readonly vcsHandles: VcsHandleIdentity }
  : { readonly vcsHandles?: never };

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
   * sees it. When to refuse and when to throw: `ConnectionTestResult`.
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
   * only way it sees anything of ours or of its connection: core resolves the
   * connection, calls the reader on the server, and hands the page what it
   * returned.
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
  /** Present exactly when the manifest declares the `issue_tracker`
   *  capability. Pure: nothing in it takes a context, so nothing needs erasing. */
  readonly issueTrackerQueryRule?: IssueTrackerQueryRule;
  /** Present exactly when the manifest declares the `vcs` capability. Pure:
   *  nothing in it takes a context, so nothing needs erasing. */
  readonly vcsHandles?: VcsHandleIdentity;
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

/**
 * What a connection test answers, and the difference between answering and
 * throwing is the whole contract.
 *
 * `{ ok: false, reason }` means the provider ANSWERED and refused this
 * configuration: a rejected token, a project that does not exist, a scope the
 * key lacks. Core files it as `credential_rejected` and the card goes
 * Failing, which stops every run that needs this integration. Return it only
 * for a verdict.
 *
 * A throw means there was no verdict: the provider could not be reached, or it
 * answered something that is not an answer about these values (a 429, a 5xx,
 * an HTML error page from a proxy, a body that does not parse). Core files it
 * as `provider_unreachable` and keeps the connection as it was, because an
 * outage during a Test says nothing about the credential. Catching every error
 * and returning `{ ok: false }` turns a thirty second outage into a Failing
 * card that only a person pressing Test again can clear.
 *
 * Which is which is not for each integration to decide:
 * `refusedOrThrow(responseOrError, reason)` returns the refusal for a failure
 * that is one and throws for every other, by the one rule in
 * `provider-failure.ts`. Provider vocabulary on top of HTTP (a Slack error
 * code, say) is the integration's to translate into those two meanings.
 *
 * `malformed` marks a refusal no provider made: the values could not form a
 * request (a token with a line break, a URL that does not parse). Core files
 * it as `value_malformed` rather than `credential_rejected`. `refusedOrThrow`
 * sets it; an integration that checks a value itself before sending (a key
 * that does not parse) may set it too.
 *
 * Either way, values being saved do not become active: only a pass does that.
 *
 * `message` on a pass NAMES WHAT THE VALUES REACHED when the provider can
 * tell: the account, workspace, site or project (`Connected to acme-prod in
 * Acme`). The admin reads it before any run uses the values, and it is the
 * only place they notice a valid key for the wrong project, which no refusal
 * will ever report. When the key alone decides the account, ask the provider
 * which one it is (a whoami or ping call) rather than echoing a field back.
 * When the provider cannot tell, say that instead of saying nothing.
 *
 * Core redacts the connection's secrets from `reason`, `message` and a thrown
 * message before anyone sees them.
 */
export type ConnectionTestResult =
  | { readonly ok: true; readonly message?: string }
  | { readonly ok: false; readonly reason: string; readonly malformed?: true };

/**
 * What one health check measured.
 *
 * A failure reads by the same rule as a connection test
 * (`readProviderFailure`), and the status is the same either way, because
 * from this deployment the provider is not working: `down`. The MESSAGE is
 * where the two differ, and it has to: a refusal names the value to fix ("the
 * token was not accepted"), and no verdict says the provider did not answer,
 * so nobody rotates a working credential over an outage. `degraded` is for a
 * check that passed with something to say (a probe message it could not
 * delete, an installation that grants no repository).
 */
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
