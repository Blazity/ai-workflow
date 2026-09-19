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
  defineIntegration,
  defineIntegrationBlock,
  defineIntegrationRuntime,
  FatalError,
  IssueTrackerNotFoundError,
  z,
  type ConnectionValues,
  type IntegrationBlockContext,
  type IntegrationBlockManifest,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
  type IssueTrackerAdapter,
  type IssueTrackerMoveTarget,
  type MessagingAdapter,
  type PullRequestHead,
  type ReviewThreadFeed,
  type TicketContent,
  type TicketEvent,
  type VCSAdapter,
  type VcsRepositoryTarget,
} from "./index";
import { fixtureManifest, pingBlock, researchBlock } from "./fixture-manifest";

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
  if (!response.ok) throw new Error(`Fixture provider answered ${response.status} for ${path}.`);
  return response.json();
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

  async searchTickets(query: string): Promise<string[]> {
    return (await readJson(this.ctx, `/search?q=${encodeURIComponent(query)}`)) as string[];
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
    return (await readJson(this.ctx, this.path(`/pulls/${prId}/head`))) as PullRequestHead;
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
    async notifyForTicket(ticketKey: string, event: TicketEvent): Promise<void> {
      try {
        await readJson(ctx, "/messages", { method: "POST", body: JSON.stringify({ ticketKey, kind: event.kind }) });
      } catch (err) {
        // The port promises never to throw.
        ctx.log.warn({ err: err instanceof Error ? err.message : String(err), ticketKey }, "fixture_notify_failed");
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
    issue_tracker: (ctx) => new FixtureTracker(ctx),
    vcs: (ctx, repository) => new FixtureRepository(ctx, repository),
    messaging: fixtureMessaging,
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
};

export const fixtureRuntime = defineIntegrationRuntime(fixtureManifest, definition);

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

const _refusedManifests = {
  reservedCapability: () =>
    defineIntegration({
      ...fixtureManifest,
      // @ts-expect-error `memory` has no port until S13 designs it
      capabilities: ["memory"],
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
      requires: { capabilities: ["agent_tracing"] },
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
      memory: { read: async () => [] },
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
  undeclaredPort: (): IntegrationRuntimeDefinition<FixtureManifest> => ({
    ...definition,
    blocks: {
      ...definition.blocks,
      // @ts-expect-error `port` must be one of the block's declared ports
      sdkfixture_ping: async () => ({ kind: "next", port: "sideways", output: { status: "ok" } }),
    },
  }),
};
