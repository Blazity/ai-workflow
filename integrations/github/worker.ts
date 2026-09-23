import {
  defineIntegrationRuntime,
  readProviderFailure,
  refusedOrThrow,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
} from "@integrations/sdk";
import { buildOctokit, readPrivateKey, type GitHubAppCredential } from "./auth";
import { githubHandleIdentity } from "./handles";
import { manifest } from "./manifest";
import { GitHubAdapter } from "./vcs";
import { webhook } from "./webhook";

type GitHubManifest = typeof manifest;
type GitHubContext = IntegrationContext<GitHubManifest>;

function credentialOf(ctx: GitHubContext): GitHubAppCredential {
  return {
    appId: ctx.connection.appId,
    privateKey: ctx.connection.privateKey,
    installationId: ctx.connection.installationId,
  };
}

/**
 * The adapter for one repository, or for none.
 *
 * `repoPath` is empty for the callers that want the connection rather than a
 * repository: minting sandbox credentials, resolving the bot identity, parsing
 * a pull request URL, listing what the installation can see. Those must work
 * without a repository, so an empty path is carried through as empty owner and
 * repo rather than refused here; the methods that need a repository fail at the
 * call that needs it, with the repository in the message.
 */
function adapter(ctx: GitHubContext, repository?: { repoPath: string; baseBranch: string }) {
  const target = repository ?? { repoPath: "", baseBranch: "" };
  const [owner = "", repo = ""] = target.repoPath.split("/");
  return new GitHubAdapter({
    octokit: octokitOf(ctx),
    http: ctx.http,
    appId: ctx.connection.appId,
    owner,
    repo,
    baseBranch: target.baseBranch,
    log: ctx.log,
  });
}

/** The connection's one client, on the context's HTTP (see `buildOctokit`). */
function octokitOf(ctx: GitHubContext) {
  return buildOctokit(credentialOf(ctx), ctx.http.fetch);
}

/** The App itself, on the App JWT. Fails when the key or the App id is wrong. */
async function authenticatedApp(ctx: GitHubContext): Promise<{ slug?: string; name?: string }> {
  const { data } = await octokitOf(ctx).apps.getAuthenticated();
  return { slug: data?.slug ?? undefined, name: data?.name ?? undefined };
}

/**
 * What the installation can see, on an installation token.
 *
 * This is the check that tells "the credentials are fine" apart from "the App
 * was uninstalled": the key still signs and `GET /app` still answers, while
 * minting a token for an installation that no longer exists fails outright. A
 * deployment whose installation was removed has to read that here rather than
 * discover it when a run tries to open a pull request.
 */
async function installationRepositories(ctx: GitHubContext): Promise<number> {
  const { data } = await octokitOf(ctx).apps.listReposAccessibleToInstallation({
    per_page: 1,
  });
  return data.total_count ?? data.repositories?.length ?? 0;
}

/** Compared without a trailing slash, which GitHub keeps or drops as it likes
 *  and which addresses the same route either way. */
function trimUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A health check GitHub did not pass, read with the SDK's rule. Down either
 * way, because the check did not pass; the sentence is what differs, since a
 * refusal sends the admin to a value and an answer that says nothing about
 * the values (a 5xx, a spent rate limit, no answer at all) sends them to wait.
 * Read on Octokit's own error, whose headers carry the rate limit.
 */
function checkFailed(
  error: unknown,
  sentences: { readonly refused: string; readonly unanswered: string },
): { status: "down"; message: string } {
  return readProviderFailure(error).kind === "refused"
    ? { status: "down", message: sentences.refused }
    : {
        status: "down",
        message: `GitHub did not answer, so ${sentences.unanswered} could not be checked (${reason(error)}).`,
      };
}

/**
 * Every event a workflow in this product can be triggered by. A missing one
 * means a trigger that simply never fires, which is the failure an operator
 * cannot see from this side.
 */
const REQUIRED_WEBHOOK_EVENTS = [
  "check_run",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
] as const;

/**
 * What GitHub says about the App's own webhook.
 *
 * This asks the App API rather than this deployment's records, because the two
 * failures that matter are only visible from GitHub's side: an App subscribed
 * to too few events, and a delivery GitHub recorded as rejected. A 401 in that
 * log is a secret mismatch by definition, since the status code GitHub stored
 * is the one this worker answered with.
 *
 * It also compares the URL GitHub holds against the one core says deliveries
 * arrive at. An App pointed at another deployment answers every other check
 * perfectly while nothing it sends ever reaches here, and core's own delivery
 * row only notices after a week of silence, which is not a health check. When
 * core cannot say what its own address is, the URL is printed rather than
 * judged.
 */
async function appWebhookState(ctx: GitHubContext): Promise<{
  status: "live" | "degraded" | "down";
  message: string;
}> {
  const octokit = octokitOf(ctx);
  const [app, hook, deliveries] = await Promise.all([
    octokit.apps.getAuthenticated(),
    octokit.request("GET /app/hook/config"),
    octokit.request("GET /app/hook/deliveries", { per_page: 1 }),
  ]);
  const subscribed = new Set((app.data as { events?: string[] }).events ?? []);
  const missing = REQUIRED_WEBHOOK_EVENTS.filter((event) => !subscribed.has(event));
  if (missing.length > 0) {
    return {
      status: "down",
      message: `The App does not subscribe to ${missing.join(", ")}, so those triggers can never fire. Add them under the App's Permissions and events.`,
    };
  }
  const config = hook.data as { url?: unknown; insecure_ssl?: unknown };
  if (String(config.insecure_ssl) === "1") {
    return {
      status: "down",
      message: "The App's webhook has TLS verification switched off. Turn it back on.",
    };
  }
  const url = typeof config.url === "string" ? config.url : "not set";
  const expected = ctx.webhookUrl;
  if (expected && trimUrl(url) !== trimUrl(expected)) {
    return {
      status: "down",
      message: `The App sends its webhooks to ${url}, and this deployment receives them at ${expected}. Nothing the App sends reaches here until that URL is corrected in its settings.`,
    };
  }
  const latest = (deliveries.data as Array<{ delivered_at?: string; status_code?: number }>)[0];
  if (!latest?.delivered_at) {
    // Live, not amber: the configuration is verified at the provider, which is
    // all this row claims. Whether anything has actually arrived here is core's
    // own delivery check, and painting a freshly connected App amber would put
    // a warning on every connection nobody can act on.
    return {
      status: "live",
      message: `Events and TLS verified for the webhook at ${url}; GitHub has not delivered anything yet.`,
    };
  }
  const code = latest.status_code;
  if (typeof code === "number" && code >= 200 && code < 300) {
    return {
      status: "live",
      message: `Events and TLS verified for the webhook at ${url}; the latest delivery returned ${code}.`,
    };
  }
  if (code === 401) {
    return {
      status: "down",
      message: `The latest delivery to ${url} was rejected with 401: the App's webhook secret differs from the one this connection holds.`,
    };
  }
  // A 5xx is this deployment's own answer: the delivery arrived and was
  // signed correctly, and the worker then failed to act on it (a dispatch
  // error, settings it could not read, an integration switched off since).
  // Being busy is not among them any more: that is answered 202. So it is
  // amber with the code, pointing at this side rather than at the App.
  if (typeof code === "number" && code >= 500) {
    return {
      status: "degraded",
      message: `The latest delivery to ${url} was answered ${code} by this deployment, so that event started nothing. The App and its webhook are fine; the worker failed to act on the delivery, and its webhook delivery log and diagnostics say why.`,
    };
  }
  return {
    status: "down",
    message: `The latest delivery to ${url} failed with ${code ?? "an unknown status"}.`,
  };
}

const definition: IntegrationRuntimeDefinition<GitHubManifest> = {
  webhook,
  testConnection: async (ctx) => {
    // The key is read before anything is sent, so an admin who pasted the wrong
    // thing is told what was expected instead of reading GitHub's opinion of
    // some bytes we mangled. A failed test never becomes the active connection.
    const key = readPrivateKey(ctx.connection.privateKey);
    // A key that does not read as one is a verdict about that value, which
    // core files as malformed rather than as GitHub refusing it.
    if (!key.ok) return { ok: false, reason: key.reason, malformed: true };
    try {
      const app = await authenticatedApp(ctx);
      const repositories = await installationRepositories(ctx);
      return {
        ok: true,
        message: `Connected as ${app.slug ?? app.name ?? "the configured App"}; installation ${
          ctx.connection.installationId
        } can see ${repositories} repositor${repositories === 1 ? "y" : "ies"}.`,
      };
    } catch (error) {
      // Octokit's error carries the status GitHub answered. A 401 on the App
      // JWT or a 404 for the installation is a verdict on these values; a 5xx,
      // a spent rate limit or a request that never got an answer is not.
      return refusedOrThrow(error);
    }
  },
  capabilities: {
    vcs: (ctx, repository) => adapter(ctx, repository),
  },
  vcsHandles: githubHandleIdentity,
  blocks: {},
  health: {
    app: async (ctx) => {
      const key = readPrivateKey(ctx.connection.privateKey);
      if (!key.ok) return { status: "down", message: key.reason };
      try {
        const app = await authenticatedApp(ctx);
        return {
          status: "live",
          message: `Authenticated as ${app.slug ?? app.name ?? "the configured App"}.`,
        };
      } catch (error) {
        return checkFailed(error, {
          refused: `GitHub did not accept the App (${reason(error)}). Check the App id and the private key.`,
          unanswered: "the App",
        });
      }
    },
    installation: async (ctx) => {
      const key = readPrivateKey(ctx.connection.privateKey);
      if (!key.ok) return { status: "down", message: key.reason };
      try {
        const repositories = await installationRepositories(ctx);
        return repositories > 0
          ? {
              status: "live",
              message: `Installation ${ctx.connection.installationId} can see ${repositories} repositor${
                repositories === 1 ? "y" : "ies"
              }.`,
            }
          : {
              status: "degraded",
              message: `Installation ${ctx.connection.installationId} exists but grants access to no repository. Add repositories to it on GitHub.`,
            };
      } catch (error) {
        return checkFailed(error, {
          refused: `GitHub refused installation ${ctx.connection.installationId} (${reason(error)}). Check the Installation id and that the App is still installed.`,
          unanswered: `installation ${ctx.connection.installationId}`,
        });
      }
    },
    webhook: async (ctx) => {
      const key = readPrivateKey(ctx.connection.privateKey);
      if (!key.ok) return { status: "down", message: key.reason };
      if (!ctx.connection.webhookSecret) {
        return {
          status: "degraded",
          message:
            "No webhook secret is set on this connection, so every delivery to /webhooks/github is refused. Copy the secret from the App's webhook settings.",
        };
      }
      try {
        return await appWebhookState(ctx);
      } catch (error) {
        return checkFailed(error, {
          refused: `GitHub refused to show the App's webhook settings (${reason(error)}). Check the App id and the private key.`,
          unanswered: "the App's webhook settings",
        });
      }
    },
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
