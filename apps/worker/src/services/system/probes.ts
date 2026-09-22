import type { SettingsSnapshot, SystemHealthResponse } from "@shared/contracts";
import { FIRST_SLICE_TOOLS } from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  defaultBuiltinHarnessProfile,
} from "@shared/harness";
import { env } from "../../infra/vcs-config.js";
import { mcpSettings } from "../settings/index.js";
import {
  checkConnectedDatabaseConnectivity,
  getConnectedLatestActiveCustomWebhookDelivery,
  listConnectedActiveCustomWebhookRejections,
  listConnectedCustomWebhookEndpointStates,
} from "../../db/repositories/system-health.js";
import {
  collectSystemHealth,
  PublicHealthProbeError,
  type SystemHealthConfig,
  type SystemHealthProbeResult,
  type SystemHealthProbes,
} from "./collect.js";
import { integrationHealthContributions } from "./integration-health.js";
import { integrationManifests } from "@integrations/registry";
import { readConnectedIntegrationConnections } from "../../db/repositories/integrations.js";
import { integrationHealthEntries } from "./integration-probes.js";
import {
  getLatestSystemHealthObservations,
  sweepSystemHealthObservations,
  systemHealthObservationScope,
} from "./observations.js";

const LOCAL_OBSERVATION_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const REQUIRED_RESEND_WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
] as const;

/** Runs only when an admin presses Scan. The observation-table housekeeping rides on the
 * same request so nothing health-related runs from cron or page rendering. */
export async function collectDeploymentSystemHealth(
  settings: SettingsSnapshot,
): Promise<SystemHealthResponse> {
  const config = configFromEnvironment(settings);
  await sweepSystemHealthObservations().catch(() => {});
  // Whatever this build ships, asked of the registry rather than listed here.
  // The connected read, named here: a scan runs against a deployment, and this
  // is the frame that knows it. `integrationHealthEntries` decides from the
  // rows and touches nothing.
  const contributions = integrationHealthContributions(
    integrationManifests.length === 0
      ? []
      : integrationHealthEntries(await readConnectedIntegrationConnections()),
  );
  return collectSystemHealth({
    config,
    probes: { ...probesForEnvironment(config), ...contributions.probes },
    contributed: contributions.definitions,
  });
}

export function configFromEnvironment(settings: SettingsSnapshot): SystemHealthConfig {
  const defaultProfile = defaultBuiltinHarnessProfile();
  return {
    databaseUrl: env.DATABASE_URL,
    agentKind: defaultProfile.harness.provider,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicModel:
      BUILTIN_HARNESS_PROFILE_MANIFESTS[
        BUILTIN_HARNESS_PROFILE_IDS.claude
      ].model.id,
    codexApiKey: env.CODEX_API_KEY,
    codexOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
    codexModel:
      BUILTIN_HARNESS_PROFILE_MANIFESTS[
        BUILTIN_HARNESS_PROFILE_IDS.codex
      ].model.id,
    betterAuthSecret: env.BETTER_AUTH_SECRET,
    betterAuthUrl: env.BETTER_AUTH_URL,
    dashboardOrigin: env.DASHBOARD_ORIGIN,
    ssoIssuer: env.SSO_ISSUER,
    ssoAllowedDomain: env.SSO_ALLOWED_DOMAIN,
    ssoClientId: env.SSO_CLIENT_ID,
    ssoClientSecret: env.SSO_CLIENT_SECRET,
    resendApiKey: env.RESEND_API_KEY,
    resendFromEmail: env.RESEND_FROM_EMAIL,
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET,
    mcpEnabled: mcpSettings(settings).enabled,
    webhookTriggerEncryptionKey: env.WEBHOOK_TRIGGER_ENCRYPTION_KEY,
  };
}

export function probesForEnvironment(config: SystemHealthConfig): SystemHealthProbes {
  const probes: SystemHealthProbes = {
    "database.connectivity": async () => {
      try {
        await checkConnectedDatabaseConnectivity();
      } catch {
        throw new PublicHealthProbeError("Database did not respond.");
      }
    },
    "email.webhook-delivery": async (signal) =>
      resendWebhookResult(config, signal),
    "custom-webhooks.aggregate": () => customWebhookAggregate(),
  };

  if (config.ssoIssuer) {
    probes["sso.discovery"] = async (signal) => {
      const issuer = config.ssoIssuer!.replace(/\/+$/, "");
      const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
        signal,
      }).catch(() => null);
      const metadata = response?.ok
        ? ((await response.json().catch(() => null)) as {
            issuer?: unknown;
            authorization_endpoint?: unknown;
          } | null)
        : null;
      if (
        !metadata ||
        metadata.issuer !== config.ssoIssuer ||
        typeof metadata.authorization_endpoint !== "string"
      ) {
        throw new PublicHealthProbeError("SSO discovery or issuer check failed.");
      }
    };
  }

  if (config.resendApiKey) {
    probes["email.sender"] = (signal) => resendSenderResult(config, signal);
  }


  if (config.mcpEnabled) {
    probes["mcp.contract"] = async () => {
      const toolCount: number = FIRST_SLICE_TOOLS.length;
      if (toolCount === 0) {
        throw new PublicHealthProbeError("MCP contract has no tools.");
      }
    };
  }

  Object.assign(probes, agentProbes(config));
  return probes;
}

function localObservations(integrationId: string, secret: string | undefined) {
  return getLatestSystemHealthObservations(
    integrationId,
    "webhook-delivery",
    systemHealthObservationScope(secret),
  );
}

/** Turns the worker's own record of signed requests into a check result. With
 * no request in the window the secret is merely "configured": the scan makes
 * no claim it cannot back, and it never invents an amber state for silence. */
function classifyObservations(
  observations: Awaited<ReturnType<typeof getLatestSystemHealthObservations>>,
  now: Date = new Date(),
): SystemHealthProbeResult {
  const latest = observations[0];
  if (!latest || now.getTime() - latest.observedAt.getTime() > LOCAL_OBSERVATION_FRESH_MS) {
    return {
      mode: "configured",
      evidenceSource: "configuration",
      message: "Secret is set; no signed request has reached this worker in the last 7 days.",
    };
  }
  if (latest.outcome === "accepted") {
    return {
      mode: "live",
      evidenceSource: "local-observation",
      observedAt: latest.observedAt.toISOString(),
      message: "A recent request passed signature verification.",
    };
  }
  return {
    mode: "degraded",
    evidenceSource: "local-observation",
    observedAt: latest.observedAt.toISOString(),
    message:
      latest.reason === "handler_failed"
        ? "A recent request passed signature verification but the worker handler failed; check the worker logs."
        : latest.reason === "invalid_signature"
          ? "A recent request failed signature verification; the secret configured at the provider differs from this deployment's."
          : `A recent request was rejected (${latest.reason}).`,
  };
}

async function resendSenderResult(
  config: SystemHealthConfig,
  signal: AbortSignal,
): Promise<SystemHealthProbeResult | void> {
  const response = await resendFetch(config, "/domains", signal);
  if (response.ok) {
    const body = (await response.json().catch(() => null)) as {
      data?: Array<{ name?: string; status?: string }>;
    } | null;
    const senderDomain = emailDomain(config.resendFromEmail);
    if (senderDomain) {
      if (!Array.isArray(body?.data)) {
        throw new PublicHealthProbeError(
          "Resend did not return sender-domain verification data.",
        );
      }
      const domain = body.data.find((candidate) => candidate.name === senderDomain);
      if (!domain || domain.status !== "verified") {
        throw new PublicHealthProbeError("Resend sender domain is not verified.");
      }
    }
    return;
  }
  const error = (await response.json().catch(() => null)) as { name?: unknown } | null;
  if (response.status === 401 && error?.name === "restricted_api_key") {
    return {
      mode: "live",
      message:
        "Resend accepted the send-only key; this key type cannot inspect sender-domain verification.",
    };
  }
  throw new PublicHealthProbeError("Resend authentication failed.");
}

async function resendWebhookResult(
  config: SystemHealthConfig,
  signal: AbortSignal,
): Promise<SystemHealthProbeResult> {
  if (!config.resendApiKey) {
    return classifyObservations(
      await localObservations("email", config.resendWebhookSecret),
    );
  }
  const response = await resendFetch(config, "/webhooks", signal);
  if (response.ok) {
    const body = (await response.json()) as {
      data?: Array<{ endpoint?: string; status?: string; events?: string[] }>;
    };
    const expectedUrl = providerWebhookUrl(config, "resend");
    const hook = body.data?.find(
      (candidate) => normalizeUrl(candidate.endpoint ?? "") === expectedUrl,
    );
    if (!hook || hook.status !== "enabled") {
      throw new PublicHealthProbeError("The Resend webhook endpoint is missing or disabled.");
    }
    const events = new Set(hook.events ?? []);
    const missingEvents = REQUIRED_RESEND_WEBHOOK_EVENTS.filter(
      (event) => !events.has(event),
    );
    if (missingEvents.length > 0) {
      throw new PublicHealthProbeError(
        `The Resend webhook is missing required events: ${missingEvents.join(", ")}.`,
      );
    }
    const local = classifyObservations(
      await localObservations("email", config.resendWebhookSecret),
    );
    return local.mode === "configured"
      ? {
          mode: "live",
          evidenceSource: "provider-config",
          message: "Resend webhook is enabled with every handled event; no delivery has arrived in the last 7 days.",
        }
      : local;
  }
  if (response.status === 401) {
    const local = classifyObservations(
      await localObservations("email", config.resendWebhookSecret),
    );
    return {
      ...local,
      message: `The Resend key cannot inspect webhook configuration. ${local.message}`,
    };
  }
  throw new PublicHealthProbeError("Resend webhook configuration check failed.");
}

async function customWebhookAggregate(): Promise<SystemHealthProbeResult> {
  const endpoints = await listConnectedCustomWebhookEndpointStates();
  const active = endpoints.filter((endpoint) => !endpoint.revokedAt);
  if (active.length === 0) {
    return {
      mode: "not-configured",
      message: "No active custom webhook endpoint exists.",
      coverage: { checked: 0, total: endpoints.length },
    };
  }
  const latestDelivery = await getConnectedLatestActiveCustomWebhookDelivery();
  const rejection = await listConnectedActiveCustomWebhookRejections(utcDayStart())
    .catch(() => [] as Array<{ count: number }>);
  const observedAt = latestDelivery[0]?.createdAt;
  const deliveryIsFresh = Boolean(
    observedAt && Date.now() - observedAt.getTime() <= LOCAL_OBSERVATION_FRESH_MS,
  );
  return {
    mode: rejection.length > 0 ? "down" : deliveryIsFresh ? "live" : "configured",
    ...(observedAt ? { observedAt: observedAt.toISOString() } : {}),
    coverage: { checked: active.length, total: endpoints.length },
    message: rejection.length > 0
      ? "An active custom endpoint rejected a request today."
      : deliveryIsFresh
        ? "Custom endpoints accepted a delivery in the last 7 days."
        : "Custom endpoints are active; none received a delivery in the last 7 days.",
  };
}

function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function agentProbes(config: SystemHealthConfig): SystemHealthProbes {
  if (config.agentKind === "claude" && config.anthropicApiKey && config.anthropicModel) {
    if (config.anthropicApiKey.startsWith("sk-ant-oat")) return {};
    return {
      "agent.model": async (signal) => {
        const response = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": config.anthropicApiKey!,
            "anthropic-version": "2023-06-01",
          },
          signal,
        }).catch(() => null);
        if (!response?.ok) throw new PublicHealthProbeError("Anthropic authentication failed.");
        const body = (await response.json().catch(() => null)) as {
          data?: Array<{ id?: unknown }>;
        } | null;
        if (!body?.data?.some((model) => model.id === config.anthropicModel)) {
          throw new PublicHealthProbeError("Configured Claude model is unavailable.");
        }
      },
    };
  }
  if (config.agentKind === "codex" && config.codexApiKey && config.codexModel) {
    return {
      "agent.model": async (signal) => {
        const response = await fetch(
          `https://api.openai.com/v1/models/${encodeURIComponent(config.codexModel!)}`,
          { headers: { Authorization: `Bearer ${config.codexApiKey}` }, signal },
        ).catch(() => null);
        if (!response?.ok) throw new PublicHealthProbeError("OpenAI authentication failed.");
      },
    };
  }
  return {};
}

function resendFetch(
  config: SystemHealthConfig,
  path: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${config.resendApiKey}` },
    signal,
  });
}

function providerWebhookUrl(
  config: SystemHealthConfig,
  provider: "resend",
): string {
  const base = (config.betterAuthUrl ?? "").replace(/\/+$/, "");
  return normalizeUrl(`${base}/webhooks/${provider}`);
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function emailDomain(value: string | undefined): string | null {
  const address = value?.match(/<([^>]+)>/)?.[1] ?? value;
  const domain = address?.split("@").at(-1)?.trim().toLowerCase();
  return domain || null;
}
