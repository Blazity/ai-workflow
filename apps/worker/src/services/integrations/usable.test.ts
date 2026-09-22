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
import { IssueTrackerNotFoundError } from "@integrations/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/repositories/integrations.js", () => ({
  readConnectedIntegrationConnections: async () => new Map(),
}));

const { resolveUsableIntegrations } = await import("./usable.js");

/** A token as it arrives from a terminal that wrapped it. */
const WRAPPED_TOKEN = "glpat-4f9a2c\n1e8b7d99";

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
    vi.stubEnv("GITLAB_TOKEN", WRAPPED_TOKEN);
    const gitlab = await usable("gitlab");
    const vcs = (
      gitlab.runtime.capabilities.vcs as (
        ctx: unknown,
        repository: { repoPath: string; baseBranch: string },
      ) => { listRepositories(): Promise<unknown> }
    )(gitlab.ctx, { repoPath: "", baseBranch: "" });

    const error = await rejection(vcs.listRepositories());

    expect(error.message).toContain("[redacted]");
    expect(everythingIn(error)).not.toContain("1e8b7d99");
    expect(everythingIn(error)).not.toContain("glpat-4f9a2c");
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
