/**
 * The worker half of this package's fixture integration. It implements the
 * three moved ports for a provider core has never heard of, and one block that
 * uses every member of the context. The package typecheck compiles it, so a
 * port or context change that breaks an integration breaks this file first.
 *
 * The end of the file holds what the contract must refuse, each as a line
 * under `@ts-expect-error`: if a type grows loose enough to accept one, the
 * directive is unused and the typecheck fails.
 */
import {
  AGENT_TRACING_DIR_TOKEN,
  defineIntegration,
  defineIntegrationBlock,
  defineIntegrationRuntime,
  FatalError,
  IssueTrackerNotFoundError,
  isPullRequestRefusal,
  PullRequestUnreadableError,
  z,
  type AgentTracingAdapter,
  type ConnectionValues,
  type IntegrationBlockContext,
  type IntegrationBlockManifest,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
  type IssueTrackerAdapter,
  type IssueTrackerMoveTarget,
  type MessagingAdapter,
  type MessagingConversation,
  type MessagingDelivery,
  type MessagingTicket,
  type PullRequestHead,
  type ReviewThreadFeed,
  type TicketContent,
  type TicketEvent,
  type VCSAdapter,
  type VcsRepositoryTarget,
} from "./index";
import type { JsonValue } from "@shared/contracts";
import { fixtureManifest, otelFixtureManifest, pingBlock, researchBlock } from "./fixture-manifest";

type FixtureManifest = typeof fixtureManifest;
type FixtureContext = IntegrationContext<FixtureManifest>;

async function readJson(ctx: FixtureContext, path: string, init?: RequestInit): Promise<unknown> {
  const response = await ctx.http.fetch(new URL(path, ctx.connection.baseUrl), {
    // The context's signal reaches an adapter too, so a capability called from
    // a webhook route stops when the route does.
    signal: ctx.signal,
    ...init,
    headers: { authorization: `Bearer ${ctx.connection.apiToken}` },
  });
  if (response.status === 401) throw new FatalError("The fixture provider refused the API token.");
  if (!response.ok) {
    // The status and headers ride along, so a caller can tell a refusal of
    // one resource from any other failure (`isPullRequestRefusal`).
    throw Object.assign(new Error(`Fixture provider answered ${response.status} for ${path}.`), {
      status: response.status,
      response: { headers: response.headers },
    });
  }
  return response.json();
}

/** Equality by value: handles cross JSON, so the same check is never the
 *  same object twice. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every((key) => Object.hasOwn(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]))
  );
}

class FixtureTracker implements IssueTrackerAdapter {
  constructor(private readonly ctx: FixtureContext) {}

  async fetchTicket(id: string): Promise<TicketContent> {
    const response = await this.ctx.http.fetch(new URL(`/tickets/${id}`, this.ctx.connection.baseUrl));
    if (response.status === 404) throw new IssueTrackerNotFoundError("Ticket", id);
    const body = (await response.json()) as { title: string; description: string };
    return {
      id,
      identifier: id,
      title: body.title,
      description: body.description,
      acceptanceCriteria: "",
      comments: [],
      labels: [],
      trackerStatus: "open",
      attachments: [],
    };
  }

  async moveTicket(id: string, target: IssueTrackerMoveTarget): Promise<void> {
    const name = typeof target === "string" ? target : target.name;
    await readJson(this.ctx, `/tickets/${id}/status`, { method: "PUT", body: JSON.stringify({ name }) });
  }

  async postComment(id: string, comment: string, options?: { signal?: AbortSignal }): Promise<string | null> {
    const body = (await readJson(this.ctx, `/tickets/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ comment }),
      ...(options?.signal ? { signal: options.signal } : {}),
    })) as { url?: string };
    return body.url ?? null;
  }

  async ticketsInStatus(status: string): Promise<string[]> {
    return (await readJson(
      this.ctx,
      `/search?status=${encodeURIComponent(status)}`,
    )) as string[];
  }

  /**
   * The account this fixture connection acts as.
   *
   * Required by the port, and this fixture is where that requirement is worth
   * feeling: it is the smallest complete issue tracker in the repository, so
   * if an adapter could be written without answering "was that me", this one
   * would be written without it. The product's own ticket moves fire the
   * tracker's webhook, and an adapter that could not say who acted would make
   * every one of them read as a person pulling the ticket out.
   */
  async getCurrentUserAccountId(): Promise<string> {
    const body = (await readJson(this.ctx, "/me")) as { accountId?: string };
    if (typeof body.accountId !== "string" || body.accountId === "") {
      throw new Error("The fixture provider did not say which account this token is.");
    }
    return body.accountId;
  }
}

class FixtureRepository implements VCSAdapter {
  constructor(
    private readonly ctx: FixtureContext,
    private readonly repository: VcsRepositoryTarget,
  ) {}

  private path(suffix: string): string {
    return `/repos/${this.repository.repoPath}${suffix}`;
  }

  async createBranchIfMissing(name: string, base: string): Promise<"created" | "existing"> {
    const body = (await readJson(this.ctx, this.path("/branches"), {
      method: "POST",
      body: JSON.stringify({ name, base }),
    })) as { created: boolean };
    return body.created ? "created" : "existing";
  }

  async resetOwnedBranch(name: string, base: string): Promise<void> {
    await readJson(this.ctx, this.path(`/branches/${name}`), { method: "PUT", body: JSON.stringify({ base }) });
  }

  async createPR(branch: string, title: string, body: string) {
    const created = (await readJson(this.ctx, this.path("/pulls"), {
      method: "POST",
      body: JSON.stringify({ branch, title, body, base: this.repository.baseBranch }),
    })) as { id: number; url: string };
    return { id: created.id, url: created.url, branch };
  }

  async push(branch: string, files: Array<{ path: string; content: string }>): Promise<void> {
    await readJson(this.ctx, this.path(`/branches/${branch}/commits`), {
      method: "POST",
      body: JSON.stringify({ files }),
    });
  }

  async getPRComments() {
    return [];
  }

  async postPRComment(prId: number, body: string): Promise<{ url: string | null }> {
    const posted = (await readJson(this.ctx, this.path(`/pulls/${prId}/comments`), {
      method: "POST",
      body: JSON.stringify({ body }),
    })) as { url?: string };
    return { url: posted.url ?? null };
  }

  async getCheckRunResults() {
    return [];
  }

  async getPRConflictStatus(): Promise<boolean> {
    return false;
  }

  async getPRHeadSha(prId: number): Promise<string> {
    return (await this.getPRHead(prId)).headSha;
  }

  async findPR() {
    return null;
  }

  async getBranchSha(branch: string): Promise<string> {
    const sha = await this.getBranchShaIfExists(branch);
    if (sha === null) throw new FatalError(`Branch ${branch} does not exist.`);
    return sha;
  }

  async getBranchShaIfExists(branch: string): Promise<string | null> {
    const response = await this.ctx.http.fetch(new URL(this.path(`/branches/${branch}`), this.ctx.connection.baseUrl));
    if (response.status === 404) return null;
    return ((await response.json()) as { sha: string }).sha;
  }

  async getPRHead(prId: number): Promise<PullRequestHead> {
    try {
      return (await readJson(this.ctx, this.path(`/pulls/${prId}/head`))) as PullRequestHead;
    } catch (error) {
      // Gone, or forbidden to this token for this pull request alone, is
      // closed for good. A refused token, a token without the scope to read
      // pull requests at all, and an outage are thrown as they came, so the
      // delivery can be retried once the connection is repaired.
      if (isPullRequestRefusal(error)) {
        throw new PullRequestUnreadableError(`Fixture pull request ${prId} cannot be read.`, { cause: error });
      }
      throw error;
    }
  }

  async listReviewThreads(): Promise<ReviewThreadFeed> {
    return { threads: [], truncated: 0, contextTruncated: 0, snapshotAt: new Date(0).toISOString() };
  }

  async settleReviewThread() {
    return { action: "skipped_existing_reply" as const };
  }

  async postRunFailureNote(input: { prId: number; body: string }): Promise<void> {
    await this.postPRComment(input.prId, input.body);
  }
}

function fixtureMessaging(ctx: FixtureContext): MessagingAdapter {
  return {
    async notifyForTicket(
      ticket: MessagingTicket,
      event: TicketEvent,
      conversation: MessagingConversation,
    ): Promise<MessagingDelivery> {
      try {
        const sent = (await readJson(ctx, "/messages", {
          method: "POST",
          body: JSON.stringify({
            ticketKey: ticket.key,
            kind: event.kind,
            thread: conversation.handle,
          }),
        })) as { id?: string };
        // A provider that anchored a conversation hands the handle back; core
        // owns the row it lives in.
        if (conversation.handle === null && typeof sent.id === "string") {
          await conversation.remember(sent.id);
        }
        return { delivered: true };
      } catch (err) {
        // The port promises never to throw; it answers instead.
        const reason = err instanceof Error ? err.message : String(err);
        ctx.log.warn({ err: reason, ticketKey: ticket.key }, "fixture_notify_failed");
        return { delivered: false, reason };
      }
    },
  };
}

const findingsSchema = z.object({
  summary: z.string(),
  relevant: z.array(z.string()),
});

async function probe(ctx: IntegrationContext<FixtureManifest>, path: string) {
  const response = await ctx.http.fetch(new URL(path, ctx.connection.baseUrl), { signal: ctx.signal, retries: 0 });
  return response.ok
    ? { status: "live" as const }
    : { status: "down" as const, message: `The provider answered ${response.status}.` };
}

/**
 * What the sandbox needs so this provider sees the agent: its own tracer
 * script, the packages the script imports, the bucket it reports into, and a
 * hook on each moment the harness offers. Nothing here knows how a harness
 * registers a hook; core does that.
 */
function fixtureTracing(ctx: FixtureContext): AgentTracingAdapter {
  return {
    setup: (invocation) => {
      const bucketId = invocation.state?.bucketId;
      if (typeof bucketId !== "string") return null;
      return {
        packages: [{ ecosystem: "python", name: "opentelemetry-sdk", minVersion: "1.20.0" }],
        files: [
          { path: "tracer.py", contentBase64: "cHJpbnQoIjopIikK", executable: true },
        ],
        // The token is for the hooks, so the agent never has it.
        hookEnvironment: {
          SDKFIXTURE_BUCKET: bucketId,
          SDKFIXTURE_TOKEN: ctx.connection.apiToken,
        },
        hooks: [
          { event: "prompt_submitted", command: `python3 "${AGENT_TRACING_DIR_TOKEN}/tracer.py" prompt` },
          { event: "session_ended", command: `python3 "${AGENT_TRACING_DIR_TOKEN}/tracer.py" stop` },
        ],
      };
    },
  };
}

const definition: IntegrationRuntimeDefinition<FixtureManifest> = {
  testConnection: async (ctx) => {
    const response = await ctx.http.fetch(new URL("/me", ctx.connection.baseUrl), {
      headers: { authorization: `Bearer ${ctx.connection.apiToken}` },
      signal: ctx.signal,
      timeoutMs: 5_000,
    });
    if (response.ok) return { ok: true, message: `Signed in to app ${ctx.connection.appId}.` };
    return { ok: false, reason: await response.text() };
  },
  capabilities: {
    agent_tracing: fixtureTracing,
    issue_tracker: (ctx) => new FixtureTracker(ctx),
    vcs: (ctx, repository) => new FixtureRepository(ctx, repository),
    messaging: fixtureMessaging,
  },
  // The fixture tracker has no search, so it runs no query and says so rather
  // than accepting one it would ignore.
  issueTrackerQueryRule: {
    problem: () => "The fixture tracker has no search, so it runs no query.",
  },
  // The fixture's handles are whatever its provider answers, compared by value
  // because they come back parsed. It never recorded a check without a handle,
  // so it has no `recordedCheckHandle`.
  vcsHandles: {
    sameHandle: (left, right) => left !== undefined && right !== undefined && sameJson(left, right),
  },
  blocks: {
    sdkfixture_research: async ({ params, inputs }, ctx) => {
      const ticket = await ctx.capabilities.issue_tracker.fetchTicket(inputs.ticketKey);
      const hits = (await readJson(
        ctx,
        `/search?q=${encodeURIComponent(params.query)}&days=${params.lookbackDays}`,
      )) as string[];
      ctx.log.info({ runId: ctx.run.runId, nodeId: ctx.run.nodeId, hits: hits.length }, "fixture_research_searched");
      if (hits.length === 0) {
        // One port, and the outcome in `status`: the graph reads an integration
        // block's ports from core's catalog, which holds none of them, so a
        // second port would be offered in the editor and propagate to nothing.
        // A branch downstream tests `status` instead.
        return { kind: "next", output: { status: "nothing_found", summary: "", matches: 0 } };
      }
      if (inputs.repository !== undefined) {
        const repository = ctx.capabilities.vcs({
          provider: fixtureManifest.id,
          repoPath: inputs.repository,
          baseBranch: "main",
        });
        await repository.getBranchShaIfExists("main");
      }
      const findings = await ctx.llm.generateObject({
        system: "You summarise search results for a ticket.",
        prompt: `${ticket.title}\n\n${hits.join("\n")}`,
        schema: findingsSchema,
      });
      await ctx.capabilities.messaging.notifyForTicket(inputs.ticketKey, {
        kind: "note",
        text: findings.summary,
      });
      if (ctx.run.attempt > 3) {
        return { kind: "failed", message: "The fixture provider kept timing out.", detail: `attempt ${ctx.run.attempt}` };
      }
      return {
        kind: "next",
        output: { status: "found", summary: findings.summary, matches: findings.relevant.length },
      };
    },
    sdkfixture_ping: async (_invocation, ctx) => {
      await readJson(ctx, "/ping");
      return { kind: "next", output: { status: "ok" } };
    },
  },
  health: {
    auth: (ctx) => probe(ctx, "/me"),
    webhook: (ctx) => probe(ctx, "/webhooks/last"),
  },
  // Created once for the run, because this provider numbers a second bucket
  // for the same name rather than returning the first.
  beginRun: async (start, ctx) => {
    const created = (await readJson(ctx, "/buckets", {
      method: "POST",
      body: JSON.stringify({ name: start.subjectKey }),
    })) as { id: string };
    return { bucketId: created.id };
  },
  api: {
    overview: async (ctx) => {
      const body = (await readJson(ctx, "/overview")) as { score: number };
      return { score: body.score };
    },
  },
};

export const fixtureRuntime = defineIntegrationRuntime(fixtureManifest, definition);

/**
 * The foil's runtime: tracing with no run handle, no package, no file and no
 * hook. If `agent_tracing` ever requires one of those, this stops compiling,
 * which is the point of keeping it here rather than in a report nobody reruns.
 */
const otelDefinition: IntegrationRuntimeDefinition<typeof otelFixtureManifest> = {
  testConnection: async (ctx) => {
    const response = await ctx.http.fetch(new URL("/v1/traces", ctx.connection.endpoint), {
      method: "HEAD",
      headers: { authorization: `Bearer ${ctx.connection.apiKey}` },
      signal: ctx.signal,
    });
    return response.ok ? { ok: true } : { ok: false, reason: `The collector answered ${response.status}.` };
  },
  capabilities: {
    agent_tracing: (ctx) => ({
      // The harness is the exporter here, so what it reads has to be in its
      // own environment; the port's `hookEnvironment` is for a provider whose
      // hooks do the exporting.
      setup: (invocation) => ({
        environment: {
          OTEL_EXPORTER_OTLP_ENDPOINT: ctx.connection.endpoint,
          OTEL_EXPORTER_OTLP_HEADERS: `authorization=Bearer ${ctx.connection.apiKey}`,
          OTEL_RESOURCE_ATTRIBUTES: `aiw.run_id=${invocation.run.runId}`,
        },
      }),
    }),
  },
  blocks: {},
  health: {
    collector: async (ctx) => {
      const response = await ctx.http.fetch(new URL("/health", ctx.connection.endpoint), {
        signal: ctx.signal,
      });
      return response.ok ? { status: "live" } : { status: "down", message: "The collector did not answer." };
    },
  },
};

export const otelFixtureRuntime = defineIntegrationRuntime(otelFixtureManifest, otelDefinition);

// ---------------------------------------------------------------------------
// What the types promise. Each alias fails to compile if the promise breaks.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type FixtureConnection = ConnectionValues<FixtureManifest>;
type ResearchContext = IntegrationBlockContext<FixtureManifest, typeof researchBlock>;
type PingContext = IntegrationBlockContext<FixtureManifest, typeof pingBlock>;

type _FixturePromises = [
  // Required text is a string, `integer` a number, optional without a default may be absent,
  // optional with a default is always there.
  Expect<Equal<FixtureConnection["baseUrl"], string>>,
  Expect<Equal<FixtureConnection["appId"], number>>,
  Expect<Equal<FixtureConnection["botLogin"], string | undefined>>,
  Expect<Equal<FixtureConnection["host"], string>>,
  // The standard fetch signature, so provider SDKs that take a custom fetch accept it.
  Expect<IntegrationContext<FixtureManifest>["http"]["fetch"] extends typeof fetch ? true : false>,
  // `vcs` with many providers is a lookup by repository; the others are adapters.
  Expect<Equal<ReturnType<ResearchContext["capabilities"]["vcs"]>, VCSAdapter>>,
  Expect<Equal<ResearchContext["capabilities"]["issue_tracker"], IssueTrackerAdapter>>,
  // Params are the parsed zod output, defaults applied.
  Expect<Equal<Parameters<typeof definition.blocks.sdkfixture_research>[0]["params"]["lookbackDays"], number>>,
  // A block is told what the run is about and what this integration's per-run
  // state is, and the state is nullable: creating it can fail.
  Expect<Equal<ResearchContext["run"]["subjectKey"], string>>,
  Expect<Equal<ResearchContext["run"]["state"], Readonly<Record<string, JsonValue>> | null>>,
];

// ---------------------------------------------------------------------------
// What the contract refuses.

// @ts-expect-error the ping block did not require `llm`, so its context has none
type _PingHasNoLlm = PingContext["llm"];

// @ts-expect-error the ping block required no capability, so none is in its context
type _PingHasNoTracker = PingContext["capabilities"]["issue_tracker"];

// @ts-expect-error run identity exists only while a block executes, not in a connection test
type _ConnectionTestHasNoRun = IntegrationContext<FixtureManifest>["run"];

// @ts-expect-error `llm` is block-only as well
type _ConnectionTestHasNoLlm = IntegrationContext<FixtureManifest>["llm"];

// @ts-expect-error `agent_tracing` is applied by core to a sandbox, so a block holds no adapter for it
type _ResearchHasNoTracing = ResearchContext["capabilities"]["agent_tracing"];

const _refusedManifests = {
  reservedCapability: () =>
    defineIntegration({
      ...fixtureManifest,
      // @ts-expect-error `agent_tools` has no port until a later plan designs it
      capabilities: ["agent_tools"],
    }),
  widenedBlockType: () =>
    // @ts-expect-error a block annotated with the wide type would switch every later check off
    defineIntegration({
      ...fixtureManifest,
      blocks: [pingBlock as IntegrationBlockManifest],
    }),
  reservedRequirement: () =>
    defineIntegrationBlock({
      ...pingBlock,
      // @ts-expect-error a block may require only a capability that has a port
      requires: { capabilities: ["agent_tools"] },
    }),
};

const _refusedRuntimes = {
  missingExecutor: (): IntegrationRuntimeDefinition<FixtureManifest> => ({
    ...definition,
    // @ts-expect-error every declared block needs an executor
    blocks: { sdkfixture_ping: definition.blocks.sdkfixture_ping },
  }),
  reservedCapabilityAdapter: (): IntegrationRuntimeDefinition<FixtureManifest> => ({
    ...definition,
    capabilities: {
      ...definition.capabilities,
      // @ts-expect-error an adapter for a reserved capability is not an object anything accepts
      agent_tools: { read: async () => [] },
    },
  }),
  webhookBeforeS9: (): IntegrationRuntimeDefinition<FixtureManifest> => ({
    ...definition,
    // @ts-expect-error the webhook slot is reserved for S9
    webhook: async () => [],
  }),
  undeclaredStatus: (): IntegrationRuntimeDefinition<FixtureManifest> => ({
    ...definition,
    blocks: {
      ...definition.blocks,
      // @ts-expect-error `status` must be one of the block's declared variants
      sdkfixture_ping: async () => ({ kind: "next", output: { status: "maybe" } }),
    },
  }),
  missingDeclaredOutputField: (): IntegrationRuntimeDefinition<FixtureManifest> => ({
    ...definition,
    blocks: {
      ...definition.blocks,
      // @ts-expect-error the research block declared `summary` as always present in its output
      sdkfixture_research: async () => ({ kind: "next", output: { status: "found", matches: 0 } }),
    },
  }),
  runStateWithoutBeginRun: (): IntegrationRuntimeDefinition<FixtureManifest> =>
    // @ts-expect-error the manifest declares runState, so beginRun is required
    ({ ...definition, beginRun: undefined }),
  trackerWithoutQueryRule: (): IntegrationRuntimeDefinition<FixtureManifest> =>
    // @ts-expect-error the manifest declares issue_tracker, so how it reads an authored query is required
    ({ ...definition, issueTrackerQueryRule: undefined }),
  queryRuleWithoutTracker: (): IntegrationRuntimeDefinition<typeof otelFixtureManifest> => ({
    ...otelDefinition,
    // @ts-expect-error only a tracker reads authored queries
    issueTrackerQueryRule: definition.issueTrackerQueryRule,
  }),
  vcsWithoutHandleIdentity: (): IntegrationRuntimeDefinition<FixtureManifest> =>
    // @ts-expect-error the manifest declares vcs, so how its handles compare is required
    ({ ...definition, vcsHandles: undefined }),
  handleIdentityWithoutVcs: (): IntegrationRuntimeDefinition<typeof otelFixtureManifest> => ({
    ...otelDefinition,
    // @ts-expect-error only a vcs integration mints handles to compare
    vcsHandles: definition.vcsHandles,
  }),
  readerForUndeclaredPage: (): IntegrationRuntimeDefinition<FixtureManifest> => ({
    ...definition,
    api: {
      ...definition.api,
      // @ts-expect-error the manifest declares no page called "activity"
      activity: async () => ({}),
    },
  }),
  undeclaredPort: (): IntegrationRuntimeDefinition<FixtureManifest> => ({
    ...definition,
    blocks: {
      ...definition.blocks,
      // @ts-expect-error `port` must be one of the block's declared ports
      sdkfixture_ping: async () => ({ kind: "next", port: "sideways", output: { status: "ok" } }),
    },
  }),
};
