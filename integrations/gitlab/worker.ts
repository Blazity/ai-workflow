import {
  defineIntegrationRuntime,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
} from "@integrations/sdk";
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

async function authenticatedUser(ctx: GitLabContext): Promise<{ username?: string }> {
  const response = await ctx.http.fetch(`${ctx.connection.host}/api/v4/user`, {
    headers: { "PRIVATE-TOKEN": ctx.connection.token },
  });
  if (!response.ok) {
    throw new Error(`GitLab refused the token (${response.status} ${response.statusText}).`);
  }
  return (await response.json()) as { username?: string };
}

const definition: IntegrationRuntimeDefinition<GitLabManifest> = {
  webhook,
  testConnection: async (ctx) => {
    try {
      const user = await authenticatedUser(ctx);
      const repositories = await adapter(ctx).listRepositories();
      return {
        ok: true,
        message: `Connected as ${user.username ?? "the configured account"}; ${repositories.length} project${repositories.length === 1 ? "" : "s"} visible.`,
      };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  capabilities: {
    vcs: (ctx, repository) => adapter(ctx, repository),
  },
  blocks: {},
  health: {
    api: async (ctx) => {
      try {
        const user = await authenticatedUser(ctx);
        return { status: "live", message: `Authenticated as ${user.username ?? "the configured account"}.` };
      } catch (error) {
        return { status: "down", message: error instanceof Error ? error.message : String(error) };
      }
    },
    projects: async (ctx) => {
      try {
        const repositories = await adapter(ctx).listRepositories();
        return repositories.length > 0
          ? { status: "live", message: `${repositories.length} project${repositories.length === 1 ? "" : "s"} visible.` }
          : { status: "degraded", message: "The token works but exposes no projects." };
      } catch (error) {
        return { status: "down", message: error instanceof Error ? error.message : String(error) };
      }
    },
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
