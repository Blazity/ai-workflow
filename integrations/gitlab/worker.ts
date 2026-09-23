import {
  defineIntegrationRuntime,
  readProviderFailure,
  refusedOrThrow,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
} from "@integrations/sdk";
import { gitlabHandleIdentity } from "./pipeline-checks";
import { manifest } from "./manifest";
import { GitLabAdapter } from "./vcs";
import { webhook } from "./webhook";

type GitLabManifest = typeof manifest;
type GitLabContext = IntegrationContext<GitLabManifest>;

function adapter(
  ctx: GitLabContext,
  repository?: { repoPath: string; baseBranch: string },
) {
  const target = repository ?? { repoPath: "", baseBranch: "" };
  return new GitLabAdapter({
    token: ctx.connection.token,
    host: ctx.connection.host,
    projectId: target.repoPath,
    baseBranch: target.baseBranch,
    legacyProjectId: ctx.connection.legacyProjectId,
    log: ctx.log,
  });
}

/**
 * One read of the GitLab API with the connection's token, through `ctx.http`,
 * so it is bounded by the context and a non-2xx comes back as the answer it
 * was rather than as a sentence.
 */
function gitlab(ctx: GitLabContext, path: string): Promise<Response> {
  const host = ctx.connection.host.replace(/\/+$/u, "");
  return ctx.http.fetch(`${host}/api/v4${path}`, {
    headers: { "PRIVATE-TOKEN": ctx.connection.token },
  });
}

/** Who the token is, or GitLab's answer when it would not say. */
async function authenticatedUser(
  ctx: GitLabContext,
): Promise<{ ok: true; username: string } | { ok: false; response: Response }> {
  const response = await gitlab(ctx, "/user");
  if (!response.ok) return { ok: false, response };
  const user = (await response.json()) as { username?: unknown };
  return {
    ok: true,
    username: typeof user.username === "string" ? user.username : "the configured account",
  };
}

/**
 * How many projects the token is a member of, in words, or GitLab's answer
 * when it would not list them.
 *
 * One page of one project: GitLab puts the total in `x-total`, so this costs
 * the same for a token that sees three projects and one that sees three
 * thousand. It leaves the header out past 10,000, and then the count says so.
 */
async function visibleProjects(
  ctx: GitLabContext,
): Promise<{ ok: true; count: number | null } | { ok: false; response: Response }> {
  const response = await gitlab(ctx, "/projects?membership=true&simple=true&per_page=1");
  if (!response.ok) return { ok: false, response };
  const page = (await response.json()) as unknown;
  const total = response.headers.get("x-total");
  if (total !== null && Number.isInteger(Number(total))) return { ok: true, count: Number(total) };
  return { ok: true, count: Array.isArray(page) && page.length === 0 ? 0 : null };
}

function projectsInWords(count: number | null): string {
  if (count === null) return "more than 10,000 projects";
  return `${count} project${count === 1 ? "" : "s"}`;
}

/** What a health row says about an answer that was not a success. */
function unhealthy(response: Response, refused: string): { status: "down"; message: string } {
  return readProviderFailure(response).kind === "refused"
    ? { status: "down", message: `${refused} (${response.status}).` }
    : {
        status: "down",
        message: `GitLab did not answer (${response.status}), so this could not be checked.`,
      };
}

const definition: IntegrationRuntimeDefinition<GitLabManifest> = {
  webhook,
  /**
   * `/user` proves the token; the project listing proves it can read projects,
   * which is a different scope (`read_api`) that a token made for something
   * else may lack. A refusal from either is the admin's to fix; GitLab failing
   * or unreachable throws, so an outage is not recorded as a bad token.
   */
  testConnection: async (ctx) => {
    const user = await authenticatedUser(ctx);
    if (!user.ok) {
      return refusedOrThrow(
        user.response,
        `GitLab refused the token (${user.response.status} ${user.response.statusText}).`,
      );
    }
    const projects = await visibleProjects(ctx);
    if (!projects.ok) {
      return refusedOrThrow(
        projects.response,
        `GitLab accepted the token for ${user.username} but refused to list its projects (${projects.response.status} ${projects.response.statusText}). The token needs the read_api scope.`,
      );
    }
    return {
      ok: true,
      message: `Connected as ${user.username}; ${projectsInWords(projects.count)} visible.`,
    };
  },
  capabilities: {
    vcs: (ctx, repository) => adapter(ctx, repository),
  },
  vcsHandles: gitlabHandleIdentity,
  blocks: {},
  health: {
    api: async (ctx) => {
      const user = await authenticatedUser(ctx);
      return user.ok
        ? { status: "live", message: `Authenticated as ${user.username}.` }
        : unhealthy(user.response, "GitLab refused the token");
    },
    projects: async (ctx) => {
      const projects = await visibleProjects(ctx);
      if (!projects.ok) return unhealthy(projects.response, "GitLab refused to list projects");
      return projects.count === 0
        ? { status: "degraded", message: "The token works but exposes no projects." }
        : { status: "live", message: `The token sees ${projectsInWords(projects.count)}.` };
    },
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
