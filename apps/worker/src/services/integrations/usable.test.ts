/**
 * What reaches core when an integration's own code fails, through the one
 * handle core's callers hold (`resolveUsableIntegrations`).
 *
 * `ctx.http` redacts what its requests throw, and an adapter is free to use
 * something else: GitLab's adapter calls `fetch` itself, GitHub's uses
 * Octokit. Node quotes a header value it refuses in full, so a token pasted
 * with a line break in it arrives in the error message, and every caller logs
 * that message and several show it. The boundary has to hold for all of them,
 * without turning the errors core decides by into plain ones.
 *
 * The real resolver, the real registry, the real adapters and Node's own
 * `fetch`; only the database read is replaced, with the answer a deployment
 * configured through its environment gives.
 */
import { type ErasedIntegrationRuntime, IssueTrackerNotFoundError } from "@integrations/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/repositories/integrations.js", () => ({
  readConnectedIntegrationConnections: async () => new Map(),
}));

const { redactingRuntime, resolveUsableIntegrations } = await import("./usable.js");
const { redactedError } = await import("./context.js");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function usable(id: string) {
  const resolved = await resolveUsableIntegrations({ filter: (manifest) => manifest.id === id });
  if (!resolved.readable) throw new Error(resolved.reason);
  const found = resolved.usable.find((candidate) => candidate.manifest.id === id);
  if (!found) throw new Error(`${id} is not usable in this test's environment`);
  return found;
}

/** Everything reachable from a thrown error, flattened, for "is it anywhere". */
function everythingIn(error: unknown, depth = 0): string {
  if (depth > 8 || error === undefined || error === null) return "";
  if (!(error instanceof Error)) return String(error);
  return [
    error.name,
    error.message,
    String(error.stack ?? ""),
    JSON.stringify(Object.fromEntries(Object.entries(error))),
    everythingIn(error.cause, depth + 1),
  ].join("\n");
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to fail, and it succeeded");
}

describe("an adapter's own failure, on its way into core", () => {
  it("carries no secret when the adapter went around ctx.http", async () => {
    // GitLab's adapter calls `fetch` itself. Node quotes a header value it
    // refuses whole; a token with a line break no longer gets this far (the
    // resolver fails the connection first), so the refusal is staged here.
    const token = "glpat-4f9a2c1e8b7d99";
    vi.stubEnv("GITLAB_TOKEN", token);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`Headers.append: "${token}" is an invalid header value.`);
      }),
    );
    const gitlab = await usable("gitlab");
    const vcs = (
      gitlab.runtime.capabilities.vcs as (
        ctx: unknown,
        repository: { repoPath: string; baseBranch: string },
      ) => { listRepositories(): Promise<unknown> }
    )(gitlab.ctx, { repoPath: "", baseBranch: "" });

    const error = await rejection(vcs.listRepositories());

    expect(error.message).toContain("[redacted]");
    expect(everythingIn(error)).not.toContain(token);
    // Still what Node threw, to a caller that tells a bad request from an outage.
    expect(error).toBeInstanceOf(TypeError);
  });

  it("is still the error core decides by", async () => {
    // Core reads a ticket that no longer exists from `instanceof
    // IssueTrackerNotFoundError`, in the watchdog, reconcile, dispatch and the
    // MCP tools. A boundary that handed back plain errors would turn every
    // deleted ticket into an outage.
    vi.stubEnv("JIRA_BASE_URL", "https://acme.atlassian.net");
    vi.stubEnv("JIRA_API_TOKEN", "atl-token-5c0ffee5");
    vi.stubEnv("JIRA_PROJECT_KEY", "AIW");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input).includes("/_edge/tenant_info")
          ? Response.json({ cloudId: "cloud-1" })
          : new Response(null, { status: 404 }),
      ),
    );
    const jira = await usable("jira");
    const tracker = (
      jira.runtime.capabilities.issue_tracker as (ctx: unknown) => {
        fetchTicket(id: string): Promise<unknown>;
      }
    )(jira.ctx);

    const error = await rejection(tracker.fetchTicket("AIW-404"));

    expect(error).toBeInstanceOf(IssueTrackerNotFoundError);
    expect((error as { code?: string }).code).toBe("NOT_FOUND");
  });
});

/**
 * The boundary itself, around runtimes shaped the way the ports allow: what
 * reaches core from every member that can throw, and what an adapter keeps
 * being to whoever holds it.
 */
describe("what the boundary covers", () => {
  const SECRET = "sk-live-7d1e40c9aa";
  const redact = (error: unknown) =>
    redactedError(error, (text) => text.split(SECRET).join("[redacted]"));
  const refuses = () => {
    throw new Error(`401 for key ${SECRET}`);
  };
  const refusesLater = async () => refuses();

  function runtimeWith(parts: Partial<ErasedIntegrationRuntime>): ErasedIntegrationRuntime {
    return {
      manifest: {} as ErasedIntegrationRuntime["manifest"],
      testConnection: async () => ({ ok: true }),
      capabilities: {},
      blocks: {},
      health: {},
      ...parts,
    };
  }

  async function expectRedacted(call: () => unknown) {
    const error = await rejection(Promise.resolve().then(call));
    expect(error.message).toBe("401 for key [redacted]");
    expect(everythingIn(error)).not.toContain(SECRET);
  }

  it("follows vcs.skillSource() into the adapter it returns", async () => {
    // GitHub's skill source runs on its own Octokit, off `ctx.http`.
    const source = { getFiles: refusesLater, getTree: refusesLater };
    const runtime = redactingRuntime(
      runtimeWith({ capabilities: { vcs: () => ({ skillSource: () => source }) } }),
      redact,
    );
    const vcs = (runtime.capabilities.vcs as () => { skillSource(): typeof source })();
    await expectRedacted(() => vcs.skillSource().getFiles());
  });

  it("follows memory.store into the adapter it holds", async () => {
    const runtime = redactingRuntime(
      runtimeWith({
        capabilities: { memory: () => ({ recall: refusesLater, store: { list: refusesLater } }) },
      }),
      redact,
    );
    const memory = (runtime.capabilities.memory as () => { store: { list(): Promise<unknown> } })();
    await expectRedacted(() => memory.store.list());
  });

  it("covers beginRun, a page reader and both webhook calls", async () => {
    const runtime = redactingRuntime(
      runtimeWith({
        beginRun: refusesLater,
        api: { usage: refusesLater },
        webhook: { receive: refusesLater, deliver: refusesLater },
      }),
      redact,
    );
    await expectRedacted(() => runtime.beginRun?.());
    await expectRedacted(() => runtime.api?.usage?.());
    await expectRedacted(() => runtime.webhook?.receive());
    await expectRedacted(() => runtime.webhook?.deliver?.());
  });

  it("works around a frozen adapter", async () => {
    // A proxy must report a frozen object's members exactly as they are, so a
    // view built on the adapter itself throws on the first method read.
    const frozen = Object.freeze({ recall: refusesLater });
    const runtime = redactingRuntime(runtimeWith({ capabilities: { memory: () => frozen } }), redact);
    const memory = (runtime.capabilities.memory as () => typeof frozen)();
    await expectRedacted(() => memory.recall());
  });

  it("calls the method the adapter holds now, not the one it held first", async () => {
    const adapter = { fetchTicket: async () => "first" };
    const runtime = redactingRuntime(
      runtimeWith({ capabilities: { issue_tracker: () => adapter } }),
      redact,
    );
    const tracker = (runtime.capabilities.issue_tracker as () => typeof adapter)();
    expect(await tracker.fetchTicket()).toBe("first");
    adapter.fetchTicket = async () => "second";
    expect(await tracker.fetchTicket()).toBe("second");
  });

  it("keeps a class adapter's identity, private state and data exactly as they are", async () => {
    class Adapter {
      readonly bytes = new TextEncoder().encode("hi");
      readonly seen = new Map([["AIW-1", 1]]);
      readonly #token = SECRET;
      async fetchTicket() {
        return { key: "AIW-1", tokenLength: this.#token.length };
      }
    }
    const adapter = new Adapter();
    const runtime = redactingRuntime(
      runtimeWith({ capabilities: { issue_tracker: () => adapter } }),
      redact,
    );
    const tracker = (runtime.capabilities.issue_tracker as () => Adapter)();

    expect(tracker).toBeInstanceOf(Adapter);
    expect(await tracker.fetchTicket()).toEqual({ key: "AIW-1", tokenLength: SECRET.length });
    // Data is handed over as the adapter holds it: a proxied typed array
    // fails every internal-slot check, and a proxied Map cannot be cloned.
    expect(tracker.bytes).toBe(adapter.bytes);
    expect(new TextDecoder().decode(tracker.bytes)).toBe("hi");
    expect(structuredClone(tracker.seen)).toEqual(new Map([["AIW-1", 1]]));
  });
});
