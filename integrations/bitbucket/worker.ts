import {
  defineIntegrationRuntime,
  readProviderFailure,
  refusedOrThrow,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
} from "@integrations/sdk";
import { bitbucketHandleIdentity } from "./checks";
import { bitbucketClient } from "./client";
import { manifest } from "./manifest";
import { BitbucketAdapter } from "./vcs";
import { webhook } from "./webhook";

type BitbucketManifest = typeof manifest;
type BitbucketContext = IntegrationContext<BitbucketManifest>;

/** A workspace ID as Bitbucket allows one: lowercase letters, digits, `-` and `_`. */
const WORKSPACE_ID = /^[a-z0-9][a-z0-9_-]*$/u;

function adapter(ctx: BitbucketContext, repository?: { repoPath: string; baseBranch: string }) {
  const target = repository ?? { repoPath: "", baseBranch: "" };
  return new BitbucketAdapter({
    http: ctx.http,
    token: ctx.connection.token,
    workspace: ctx.connection.workspace,
    repoPath: target.repoPath,
    baseBranch: target.baseBranch,
    ...(ctx.connection.botLogin ? { botLogin: ctx.connection.botLogin } : {}),
    log: ctx.log,
  });
}

/**
 * One page of one repository of the workspace. It proves the token
 * authenticates and reaches the workspace in one call, for every kind of
 * access token: a repository token sees its one repository there. `size`,
 * when Bitbucket includes it, is how many the token sees.
 */
async function workspaceRepositories(
  ctx: BitbucketContext,
): Promise<{ ok: true; count: number | null; first: string | null } | { ok: false; response: Response }> {
  const response = await bitbucketClient({ http: ctx.http, token: ctx.connection.token }).send(
    `/repositories/${encodeURIComponent(ctx.connection.workspace)}?pagelen=1`,
    { retries: 0, timeoutMs: 3_500 },
  );
  if (!response.ok) return { ok: false, response };
  const page = (await response.json().catch(() => null)) as {
    size?: unknown;
    values?: Array<{ full_name?: unknown }>;
  } | null;
  if (!page || !Array.isArray(page.values)) {
    throw new Error("api.bitbucket.org did not answer the way the Bitbucket API does.");
  }
  const first = typeof page.values[0]?.full_name === "string" ? page.values[0].full_name : null;
  const count = typeof page.size === "number" ? page.size : page.values.length === 0 ? 0 : null;
  return { ok: true, count, first };
}

function repositoriesInWords(count: number | null): string {
  if (count === null) return "at least one repository";
  return `${count} repositor${count === 1 ? "y" : "ies"}`;
}

const definition: IntegrationRuntimeDefinition<BitbucketManifest> = {
  webhook,
  /**
   * Lists one repository of the workspace with the token. 401 is a token
   * Bitbucket does not accept, 403 one without the `repository` scope, 404 a
   * workspace that does not exist or that the token cannot see: each is the
   * admin's to fix. Bitbucket failing or unreachable throws, so an outage is
   * not recorded as a bad token.
   */
  testConnection: async (ctx) => {
    const workspace = ctx.connection.workspace.trim();
    if (!WORKSPACE_ID.test(workspace)) {
      return {
        ok: false,
        malformed: true,
        reason:
          "The workspace is the workspace ID from bitbucket.org/<workspace>/..., in lowercase letters, digits, hyphens and underscores.",
      };
    }
    if (/\s/u.test(ctx.connection.token)) {
      return {
        ok: false,
        malformed: true,
        reason: "The access token contains a space or a line break; paste it again as one line.",
      };
    }
    const listed = await workspaceRepositories(ctx);
    if (!listed.ok) {
      return refusedOrThrow(
        listed.response,
        `Bitbucket refused the access token for workspace ${workspace} (${listed.response.status}). The token needs the repository scope on that workspace.`,
      );
    }
    if (listed.count === 0) {
      return {
        ok: false,
        reason: `Bitbucket accepted the access token, but it sees no repository in workspace ${workspace}.`,
      };
    }
    return {
      ok: true,
      message: `Connected to Bitbucket workspace ${workspace}; ${repositoriesInWords(listed.count)} visible${listed.first ? ` (${listed.first} first)` : ""}.`,
    };
  },
  capabilities: {
    vcs: (ctx, repository) => adapter(ctx, repository),
  },
  vcsHandles: bitbucketHandleIdentity,
  blocks: {},
  health: {
    api: async (ctx) => {
      const listed = await workspaceRepositories(ctx);
      if (listed.ok) return { status: "live", message: `Workspace ${ctx.connection.workspace} answers.` };
      const refused = readProviderFailure(listed.response).kind === "refused";
      return {
        status: refused ? "down" : "degraded",
        message: refused
          ? `Bitbucket refused the access token (${listed.response.status}).`
          : `Bitbucket did not answer (${listed.response.status}), so this could not be checked.`,
      };
    },
    repositories: async (ctx) => {
      const listed = await workspaceRepositories(ctx);
      if (!listed.ok) {
        return { status: "down", message: `Bitbucket would not list repositories (${listed.response.status}).` };
      }
      return listed.count === 0
        ? { status: "degraded", message: "The token works but sees no repository in the workspace." }
        : { status: "live", message: `The token sees ${repositoriesInWords(listed.count)}.` };
    },
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
