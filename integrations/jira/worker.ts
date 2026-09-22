import {
  defineIntegrationRuntime,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
} from "@integrations/sdk";
import { manifest } from "./manifest";
import { JiraAdapter } from "./issue-tracker";
import { adapterFor, webhook } from "./webhook";

type JiraManifest = typeof manifest;
type JiraContext = IntegrationContext<JiraManifest>;

const WEBHOOK_EVENT_THIS_DEPLOYMENT_NEEDS = "jira:issue_updated";

async function account(ctx: JiraContext): Promise<string> {
  return adapterFor(ctx).getCurrentUserAccountId();
}

/**
 * The statuses of the configured project, which is also the cheapest proof
 * that the project exists and this account can see it.
 */
async function statuses(ctx: JiraContext): Promise<Array<{ id: string; name: string }>> {
  const list = await adapterFor(ctx).listStatuses();
  return list ?? [];
}

const definition: IntegrationRuntimeDefinition<JiraManifest> = {
  webhook,
  testConnection: async (ctx) => {
    try {
      const accountId = await account(ctx);
      const found = await statuses(ctx);
      if (found.length === 0) {
        return {
          ok: false,
          reason: `Connected as ${accountId}, but project ${ctx.connection.projectKey} has no statuses this account can see. Check the project key and this account's access to it.`,
        };
      }
      return {
        ok: true,
        message: `Connected to ${ctx.connection.projectKey}, ${found.length} status${found.length === 1 ? "" : "es"} visible.`,
      };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  capabilities: {
    issue_tracker: (ctx) =>
      new JiraAdapter({
        baseUrl: ctx.connection.baseUrl,
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
        return { status: "live", message: "Jira accepts the token." };
      } catch {
        // Two separate checks on purpose, and the sentence is the one core's
        // probe used to say. A deployment whose runs flow through webhooks can
        // hide a stale project key for weeks, and one blended message made
        // that undiagnosable from the Health screen. The underlying error is
        // not repeated here because it is a transport line an operator cannot
        // act on, while the two values named below are the ones they can.
        return {
          status: "down",
          message:
            "Jira authentication failed: the Site URL or the API token was not accepted.",
        };
      }
    },
    /**
     * A project key that names nothing used to stop the worker at boot,
     * because the site, the token and the project key were required
     * environment variables. They are connection values now, and a deployment
     * with no issue tracker at all is a legitimate state, so the loud failure
     * had to go somewhere rather than disappear. It is here: a project nobody
     * can see reads Down on the health screen and says which value to fix,
     * instead of every delivery being quietly ignored as the wrong project.
     */
    project: async (ctx) => {
      try {
        const found = await statuses(ctx);
        return found.length > 0
          ? {
              status: "live",
              message: `Project ${ctx.connection.projectKey} is visible, with ${found.length} status${found.length === 1 ? "" : "es"} to move tickets between.`,
            }
          : {
              status: "down",
              message: `Project ${ctx.connection.projectKey} has no statuses this account can see. Either the project key is wrong or the account has no access to it, and until it is fixed every delivery about a ticket is ignored as belonging to another project.`,
            };
      } catch {
        return {
          status: "down",
          message: `Jira authenticated, but project ${ctx.connection.projectKey} is not accessible; check the Project key on this integration and the token account's access to that project.`,
        };
      }
    },
    "webhook-registration": async (ctx) => {
      const expected = ctx.webhookUrl;
      if (!expected) {
        return {
          status: "degraded",
          message:
            "This deployment has no public URL configured, so there is nothing to compare Jira's webhook against.",
        };
      }
      let registrations: Awaited<ReturnType<JiraAdapter["listWebhookRegistrations"]>>;
      try {
        registrations = await adapterFor(ctx).listWebhookRegistrations(ctx.signal);
      } catch (error) {
        return { status: "down", message: error instanceof Error ? error.message : String(error) };
      }
      if (registrations === null) {
        return {
          status: "degraded",
          message:
            "This account cannot list Jira's system webhooks, so whether one is registered was not checked. Whether deliveries actually arrive is the check below.",
        };
      }
      const hook = registrations.find(
        (entry) => withoutQuery(entry.url) === withoutQuery(expected),
      );
      if (!hook) {
        return {
          status: "down",
          message: `No Jira webhook points at ${expected}. Add one in Jira under Settings, System, Webhooks.`,
        };
      }
      if (!hook.enabled) {
        return { status: "down", message: `The Jira webhook for ${expected} is switched off.` };
      }
      if (!hook.events.includes(WEBHOOK_EVENT_THIS_DEPLOYMENT_NEEDS)) {
        return {
          status: "down",
          message:
            "The Jira webhook for this deployment does not send issue updates, so a ticket entering the AI column will only be noticed by the slower poll.",
        };
      }
      return { status: "live", message: `Jira calls ${expected} on every issue update.` };
    },
  },
};

function withoutQuery(url: string): string {
  return (url.split("?")[0] ?? "").replace(/\/+$/u, "").toLowerCase();
}

export const runtime = defineIntegrationRuntime(manifest, definition);
