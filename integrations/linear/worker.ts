import {
  defineIntegrationRuntime,
  readProviderFailure,
  refusedOrThrow,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
} from "@integrations/sdk";
import { manifest } from "./manifest";
import { LinearAdapter } from "./issue-tracker";
import { linearQueryRule } from "./query-rule";
import { adapterFor, webhook } from "./webhook";

type LinearManifest = typeof manifest;
type LinearContext = IntegrationContext<LinearManifest>;

const WEBHOOK_EVENTS_THIS_DEPLOYMENT_NEEDS = ["Issue", "Comment"] as const;

/**
 * Reads the account ID belonging to the authenticated viewer.
 */
async function account(ctx: LinearContext): Promise<string> {
  return adapterFor(ctx).getCurrentUserAccountId();
}

/**
 * Lists the workflow states available in the configured team.
 */
async function statuses(ctx: LinearContext): Promise<Array<{ id: string; name: string }>> {
  const list = await adapterFor(ctx).listStatuses();
  return list ?? [];
}

/**
 * The runtime definition for the Linear integration.
 */
const definition: IntegrationRuntimeDefinition<LinearManifest> = {
  webhook,
  testConnection: async (ctx) => {
    const rawToken = ctx.connection.apiToken;
    if (!rawToken || rawToken.trim() === "" || /\s/u.test(rawToken)) {
      return {
        ok: false,
        reason: "The API key must not contain whitespace or newline characters.",
        malformed: true,
      };
    }
    const rawTeamKey = ctx.connection.projectKey;
    if (!rawTeamKey || rawTeamKey.trim() === "") {
      return {
        ok: false,
        reason: "The Team key is required.",
        malformed: true,
      };
    }

    let accountId: string;
    try {
      accountId = await account(ctx);
    } catch (error) {
      return refusedOrThrow(
        error,
        `Linear did not accept this API key (${messageOf(error)}). Check the key.`,
      );
    }

    let found: Array<{ id: string; name: string }>;
    try {
      found = await statuses(ctx);
    } catch (error) {
      return refusedOrThrow(
        error,
        `Connected as ${accountId}, but team ${ctx.connection.projectKey} is not visible to this account (${messageOf(error)}). Check the team key and this account's access to it.`,
      );
    }

    if (found.length === 0) {
      return {
        ok: false,
        reason: `Connected as ${accountId}, but team ${ctx.connection.projectKey} has no workflow states this account can see. Check the team key and this account's access to it.`,
      };
    }

    return {
      ok: true,
      message: `Connected to ${ctx.connection.projectKey}, ${found.length} status${found.length === 1 ? "" : "es"} visible.`,
    };
  },
  issueTrackerQueryRule: linearQueryRule,
  capabilities: {
    issue_tracker: (ctx) =>
      new LinearAdapter({
        apiToken: ctx.connection.apiToken,
        projectKey: ctx.connection.projectKey,
        fetch: ctx.http.fetch,
      }),
  },
  blocks: {},
  health: {
    api: async (ctx) => {
      try {
        await account(ctx);
        return { status: "live", message: "Linear accepts the API key." };
      } catch (error) {
        return readProviderFailure(error).kind === "refused"
          ? {
              status: "down",
              message: "Linear authentication failed: the API key was not accepted.",
            }
          : {
              status: "down",
              message: `Linear did not answer, so the API key could not be checked (${messageOf(error)}).`,
            };
      }
    },
    project: async (ctx) => {
      try {
        const found = await statuses(ctx);
        return found.length > 0
          ? {
              status: "live",
              message: `Team ${ctx.connection.projectKey} is visible, with ${found.length} workflow state${found.length === 1 ? "" : "s"} to move issues between.`,
            }
          : {
              status: "down",
              message: `Team ${ctx.connection.projectKey} has no workflow states this account can see. Either the team key is wrong or the account has no access to it, and until it is fixed every delivery about an issue is ignored as belonging to another team.`,
            };
      } catch (error) {
        return readProviderFailure(error).kind === "refused"
          ? {
              status: "down",
              message: `Linear authenticated, but team ${ctx.connection.projectKey} is not accessible; check the Team key on this integration and the API key account's access to that team.`,
            }
          : {
              status: "down",
              message: `Linear did not answer, so team ${ctx.connection.projectKey} could not be checked (${messageOf(error)}).`,
            };
      }
    },
    "webhook-registration": async (ctx) => {
      const expected = ctx.webhookUrl;
      if (!expected) {
        return {
          status: "degraded",
          message:
            "This deployment has no public URL configured, so there is nothing to compare Linear's webhook against.",
        };
      }
      let registrations: Awaited<ReturnType<LinearAdapter["listWebhookRegistrations"]>>;
      try {
        registrations = await adapterFor(ctx).listWebhookRegistrations(ctx.signal);
      } catch (error) {
        return { status: "down", message: error instanceof Error ? error.message : String(error) };
      }
      if (registrations === null) {
        return {
          status: "degraded",
          message:
            "This account cannot list Linear's webhooks, so whether one is registered was not checked. Whether deliveries actually arrive is the check below.",
        };
      }
      const hook = registrations.find(
        (entry) => withoutQuery(entry.url) === withoutQuery(expected),
      );
      if (!hook) {
        return {
          status: "down",
          message: `No Linear webhook points at ${expected}. Add one in Linear under Settings, API, Webhooks.`,
        };
      }
      if (!hook.enabled) {
        return { status: "down", message: `The Linear webhook for ${expected} is switched off.` };
      }
      const missing = WEBHOOK_EVENTS_THIS_DEPLOYMENT_NEEDS.filter(
        (event) => !hook.events.includes(event),
      );
      if (missing.length > 0) {
        return {
          status: "down",
          message: `The Linear webhook for this deployment does not send ${missing.join(" and ")} events, so an issue entering the AI column or a comment answer will only be noticed by the slower poll.`,
        };
      }
      return { status: "live", message: `Linear calls ${expected} on issue and comment updates.` };
    },
  },
};

/**
 * Extracts a human readable error message from an unknown error value.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Strips the query string and trailing slashes from a URL for loose comparisons.
 */
function withoutQuery(url: string): string {
  return (url.split("?")[0] ?? "").replace(/\/+$/u, "").toLowerCase();
}

/**
 * The exported runtime implementation for the Linear integration.
 */
export const runtime = defineIntegrationRuntime(manifest, definition);
