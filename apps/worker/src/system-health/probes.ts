import { createAppAuth } from "@octokit/auth-app";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { SystemHealthResponse } from "@shared/contracts";
import { env } from "../../env.js";
import { JiraAdapter } from "../adapters/issue-tracker/jira.js";
import { getDb } from "../db/client.js";
import {
  webhookTriggerDeliveries,
  webhookTriggerEndpoints,
  webhookTriggerRejectionCounters,
} from "../db/schema.js";
import { buildOctokit } from "../lib/github-auth.js";
import { MCP_CONTRACT_ARTIFACT } from "../mcp/contract-artifact.js";
import {
  collectSystemHealth,
  PublicHealthProbeError,
  type SystemHealthConfig,
  type SystemHealthProbeResult,
  type SystemHealthProbes,
} from "./collect.js";
import {
  getLatestSystemHealthObservations,
  sweepSystemHealthObservations,
  systemHealthObservationScope,
} from "./observations.js";

const LOCAL_OBSERVATION_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GITLAB_HEALTH_PROJECTS = 25;
const MAX_ACTIVE_GITLAB_WEBHOOK_TESTS = 4;
const REQUIRED_GITHUB_WEBHOOK_EVENTS = [
  "check_run",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
] as const;
const REQUIRED_RESEND_WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
] as const;

/** Runs only when an admin presses Scan. Every probe is active (GitLab gets a
 * real test delivery), and the observation-table housekeeping rides on the
 * same request so nothing health-related runs from cron or page rendering. */
export async function collectDeploymentSystemHealth(): Promise<SystemHealthResponse> {
  const config = configFromEnvironment();
  await sweepSystemHealthObservations(getDb()).catch(() => undefined);
  return collectSystemHealth({
    config,
    probes: probesForEnvironment(config),
  });
}

export function configFromEnvironment(): SystemHealthConfig {
  return {
    databaseUrl: env.DATABASE_URL,
    jiraBaseUrl: env.JIRA_BASE_URL,
    jiraApiToken: env.JIRA_API_TOKEN,
    jiraProjectKey: env.JIRA_PROJECT_KEY,
    jiraWebhookSecret: env.JIRA_WEBHOOK_SECRET,
    githubAppId: env.GITHUB_APP_ID,
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    githubInstallationId: env.GITHUB_INSTALLATION_ID,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    gitlabToken: env.GITLAB_TOKEN,
    gitlabHost: env.GITLAB_HOST,
    gitlabWebhookSecret: env.GITLAB_WEBHOOK_SECRET,
    gitlabProjectId: env.GITLAB_PROJECT_ID,
    agentKind: env.AGENT_KIND,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    anthropicModel: env.CLAUDE_MODEL,
    codexApiKey: env.CODEX_API_KEY,
    codexOauthToken: env.CODEX_CHATGPT_OAUTH_TOKEN,
    codexModel: env.CODEX_MODEL,
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
    slackToken: env.CHAT_SDK_SLACK_TOKEN,
    slackChannelId: env.CHAT_SDK_CHANNEL_ID,
    slackSigningSecret: env.SLACK_SIGNING_SECRET,
    slackAllowedUserIds: env.SLACK_ALLOWED_USER_IDS,
    arthurApiKey: env.GENAI_ENGINE_API_KEY,
    arthurTraceEndpoint: env.GENAI_ENGINE_TRACE_ENDPOINT,
    mcpEnabled: env.MCP_ENABLED,
    webhookTriggerEncryptionKey: env.WEBHOOK_TRIGGER_ENCRYPTION_KEY,
  };
}

export function probesForEnvironment(config: SystemHealthConfig): SystemHealthProbes {
  const probes: SystemHealthProbes = {
    "database.connectivity": async () => {
      try {
        await getDb().execute(sql.raw("select 1"));
      } catch {
        throw new PublicHealthProbeError("Database did not respond.");
      }
    },
    "jira.api": async (signal) => {
      if (!config.jiraBaseUrl || !config.jiraApiToken || !config.jiraProjectKey) return;
      const adapter = new JiraAdapter({
        baseUrl: config.jiraBaseUrl,
        apiToken: config.jiraApiToken,
        projectKey: config.jiraProjectKey,
      });
      // Two separate errors on purpose: a deployment where runs flow through
      // webhooks can hide a stale project key for weeks, and one blended
      // message made that undiagnosable from the Health screen.
      try {
        await adapter.getCurrentUserAccountId(signal);
      } catch {
        throw new PublicHealthProbeError(
          "Jira authentication failed: the base URL or API token was not accepted.",
        );
      }
      try {
        await adapter.listStatuses(signal);
      } catch {
        throw new PublicHealthProbeError(
          "Jira authenticated, but the configured project is not accessible; check JIRA_PROJECT_KEY and the token account's access to that project.",
        );
      }
    },
    "jira.webhook-delivery": (signal) => jiraWebhookResult(config, signal),
    "email.webhook-delivery": async (signal) =>
      resendWebhookResult(config, signal),
    "slack.webhook-delivery": async () =>
      classifyObservations(await localObservations("slack", config.slackSigningSecret)),
    "custom-webhooks.aggregate": () => customWebhookAggregate(),
  };

  if (config.githubAppId && config.githubAppPrivateKey && config.githubInstallationId) {
    const auth = {
      appId: config.githubAppId,
      privateKeyBase64: config.githubAppPrivateKey,
      installationId: config.githubInstallationId,
    };
    probes["github.app-installation"] = async (signal) => {
      try {
        await buildOctokit(auth).apps.getInstallation({
          installation_id: config.githubInstallationId!,
          request: { signal },
        });
      } catch {
        throw new PublicHealthProbeError("GitHub App installation check failed.");
      }
    };
    probes["github.repositories"] = async (signal) => {
      const response = await buildOctokit(auth).apps
        .listReposAccessibleToInstallation({
          per_page: 1,
          request: { signal },
        })
        .catch(() => {
          throw new PublicHealthProbeError("GitHub repository access failed.");
        });
      if (response.data.total_count === 0) {
        throw new PublicHealthProbeError(
          "GitHub App installation has no accessible repositories.",
        );
      }
      return {
        coverage: { checked: response.data.repositories.length, total: response.data.total_count },
      };
    };
    probes["github.webhook-delivery"] = (signal) =>
      githubWebhookResult(config, signal);
  }

  if (config.gitlabToken) {
    probes["gitlab.api"] = async (signal) => {
      const response = await gitlabFetch(config, "/user", signal);
      if (!response.ok) {
        throw new PublicHealthProbeError("GitLab authentication failed.");
      }
    };
    probes["gitlab.repositories"] = async (signal) => {
      const projects = await gitlabProjects(config, signal);
      if (projects.total === 0) {
        throw new PublicHealthProbeError(
          "GitLab token has no accessible projects.",
        );
      }
      return { coverage: { checked: projects.projects.length, total: projects.total } };
    };
    probes["gitlab.webhook-delivery"] = (signal) => gitlabWebhookResult(config, signal);
  }

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

  if (config.slackToken) {
    probes["slack.bot-auth"] = async (signal) => {
      const result = await slackApi(config, "auth.test", {}, signal);
      if (result?.ok !== true) {
        throw new PublicHealthProbeError("Slack authentication failed.");
      }
    };
    probes["slack.channel"] = (signal) => slackChannelDeliveryResult(config, signal);
  }

  if (config.arthurApiKey && config.arthurTraceEndpoint) {
    probes["arthur.api"] = async (signal) => {
      const baseUrl = config.arthurTraceEndpoint!
        .replace(/\/api\/v1\/traces\/?$/, "")
        .replace(/\/+$/, "");
      const response = await fetch(`${baseUrl}/api/v2/tasks?page_size=1`, {
        headers: {
          Authorization: `Bearer ${config.arthurApiKey}`,
          "ngrok-skip-browser-warning": "true",
        },
        signal,
      }).catch(() => null);
      if (!response?.ok) {
        throw new PublicHealthProbeError("Arthur task API authentication failed.");
      }
    };
  }

  if (config.mcpEnabled) {
    probes["mcp.contract"] = async () => {
      if (MCP_CONTRACT_ARTIFACT.tools.length === 0) {
        throw new PublicHealthProbeError("MCP contract has no tools.");
      }
    };
  }

  Object.assign(probes, agentProbes(config));
  return probes;
}

function localObservations(integrationId: string, secret: string | undefined) {
  return getLatestSystemHealthObservations(
    getDb(),
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

async function jiraWebhookResult(
  config: SystemHealthConfig,
  signal: AbortSignal,
): Promise<SystemHealthProbeResult> {
  const local = classifyObservations(
    await localObservations("jira", config.jiraWebhookSecret),
  );
  if (!config.jiraBaseUrl || !config.jiraApiToken || !config.jiraProjectKey) return local;
  const adapter = new JiraAdapter({
    baseUrl: config.jiraBaseUrl,
    apiToken: config.jiraApiToken,
    projectKey: config.jiraProjectKey,
  });
  const registrations = await adapter.listWebhookRegistrations(signal).catch(() => {
    throw new PublicHealthProbeError("Jira webhook listing failed.");
  });
  if (registrations === null) {
    return {
      ...local,
      message: `The Jira token cannot list system webhooks, so registration is not checked. ${local.message}`,
    };
  }
  const expectedUrl = providerWebhookUrl(config, "jira");
  const hook = registrations.find(
    (entry) => normalizeUrl(entry.url.split("?")[0] ?? "") === expectedUrl,
  );
  if (!hook) throw new PublicHealthProbeError("No Jira webhook points at this worker.");
  if (!hook.enabled) throw new PublicHealthProbeError("The Jira webhook for this worker is disabled.");
  if (!hook.events.includes("jira:issue_updated")) {
    throw new PublicHealthProbeError("The Jira webhook does not send issue updates.");
  }
  if (local.mode === "degraded") return local;
  return {
    mode: "live",
    evidenceSource: local.mode === "live" ? "local-observation" : "provider-config",
    ...(local.observedAt ? { observedAt: local.observedAt } : {}),
    message:
      local.mode === "live"
        ? "Jira webhook is registered and a recent signed delivery was accepted."
        : "Jira webhook is registered and enabled; no delivery has arrived in the last 7 days.",
  };
}

async function githubWebhookResult(
  config: SystemHealthConfig,
  signal: AbortSignal,
): Promise<SystemHealthProbeResult> {
  const appId = config.githubAppId!;
  const privateKey = Buffer.from(config.githubAppPrivateKey!, "base64").toString("utf8");
  const appAuth = createAppAuth({ appId, privateKey });
  const authentication = await appAuth({ type: "app" });
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${authentication.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const [appResponse, configResponse, deliveriesResponse] = await Promise.all([
    fetch("https://api.github.com/app", { headers, signal }),
    fetch("https://api.github.com/app/hook/config", { headers, signal }),
    fetch("https://api.github.com/app/hook/deliveries?per_page=1", { headers, signal }),
  ]);
  if (!appResponse.ok || !configResponse.ok || !deliveriesResponse.ok) {
    throw new PublicHealthProbeError("GitHub App webhook API check failed.");
  }
  const app = (await appResponse.json()) as { events?: string[] };
  const appEvents = new Set(app.events ?? []);
  const missingEvents = REQUIRED_GITHUB_WEBHOOK_EVENTS.filter(
    (event) => !appEvents.has(event),
  );
  if (missingEvents.length > 0) {
    throw new PublicHealthProbeError(
      `The GitHub App is missing required webhook events: ${missingEvents.join(", ")}.`,
    );
  }
  const hook = (await configResponse.json()) as { url?: unknown; insecure_ssl?: unknown };
  const expectedUrl = providerWebhookUrl(config, "github");
  if (typeof hook.url !== "string" || normalizeUrl(hook.url) !== expectedUrl) {
    throw new PublicHealthProbeError("GitHub App webhook URL does not match this worker.");
  }
  if (String(hook.insecure_ssl) === "1") {
    throw new PublicHealthProbeError("GitHub App webhook disables TLS verification.");
  }
  const deliveries = (await deliveriesResponse.json()) as Array<{
    delivered_at?: string;
    status_code?: number;
  }>;
  const latest = deliveries[0];
  // GitHub's own delivery log is authoritative: the status code it recorded is
  // what this worker answered, so a 401 there is a secret mismatch by definition.
  if (latest?.delivered_at) {
    const observedAt = new Date(latest.delivered_at);
    const ok =
      typeof latest.status_code === "number" &&
      latest.status_code >= 200 &&
      latest.status_code < 300;
    return {
      mode: ok ? "live" : "down",
      observedAt: observedAt.toISOString(),
      evidenceSource: "provider-delivery",
      message: ok
        ? `Events, URL and TLS verified; latest GitHub delivery returned ${latest.status_code}.`
        : latest.status_code === 401
          ? "Latest GitHub delivery was rejected with HTTP 401: the App's webhook secret differs from GITHUB_WEBHOOK_SECRET."
          : `Latest GitHub delivery failed with HTTP ${latest.status_code ?? "unknown"}.`,
    };
  }
  const local = classifyObservations(
    await localObservations("github", config.githubWebhookSecret),
  );
  if (local.mode !== "configured") return local;
  return {
    mode: "live",
    evidenceSource: "provider-config",
    message: "Events, URL and TLS verified; GitHub has not delivered anything yet.",
  };
}

type GitLabProject = { id: number; path_with_namespace?: string };

async function gitlabProjects(
  config: SystemHealthConfig,
  signal: AbortSignal,
): Promise<{ projects: GitLabProject[]; total: number }> {
  if (config.gitlabProjectId) {
    const response = await gitlabFetch(
      config,
      `/projects/${encodeURIComponent(config.gitlabProjectId)}`,
      signal,
    );
    if (!response.ok) throw new PublicHealthProbeError("Configured GitLab project is unavailable.");
    return { projects: [(await response.json()) as GitLabProject], total: 1 };
  }
  const response = await gitlabFetch(
    config,
    `/projects?membership=true&simple=true&per_page=${MAX_GITLAB_HEALTH_PROJECTS}&page=1`,
    signal,
  );
  if (!response.ok) throw new PublicHealthProbeError("GitLab repository listing failed.");
  const projects = (await response.json()) as GitLabProject[];
  const total = Number(response.headers.get("x-total") ?? projects.length);
  return { projects, total: Number.isFinite(total) ? total : projects.length };
}

async function gitlabWebhookResult(
  config: SystemHealthConfig,
  signal: AbortSignal,
): Promise<SystemHealthProbeResult> {
  const projectResult = await gitlabProjects(config, signal);
  const expectedUrl = providerWebhookUrl(config, "gitlab");
  let checked = 0;
  let newest: { observedAt: Date; status: number } | null = null;
  let newestFailure: { observedAt: Date; status: number } | null = null;
  let rateLimited = false;
  let testedWithoutEvidence = 0;
  for (let offset = 0; offset < projectResult.projects.length; offset += 4) {
    const batch = projectResult.projects.slice(offset, offset + 4);
    const results = await Promise.all(
      batch.map((project, batchIndex) =>
        inspectGitLabWebhook(
          config,
          project,
          expectedUrl,
          signal,
          offset + batchIndex < MAX_ACTIVE_GITLAB_WEBHOOK_TESTS,
        ),
      ),
    );
    if (results.some((result) => result.permissionDenied)) {
      return {
        mode: "degraded",
        coverage: { checked, total: projectResult.total },
        message:
          "The GitLab token cannot inspect project webhooks; Maintainer access is required to verify them.",
      };
    }
    checked += results.length;
    for (const result of results) {
      rateLimited ||= Boolean(result.activeRateLimited);
      if (result.activeTested && result.activeEvidenceMissing) testedWithoutEvidence += 1;
      if (result.delivery && (!newest || result.delivery.observedAt > newest.observedAt)) {
        newest = result.delivery;
      }
      if (
        result.delivery?.status !== undefined &&
        (result.delivery.status < 200 || result.delivery.status >= 300) &&
        (!newestFailure || result.delivery.observedAt > newestFailure.observedAt)
      ) {
        newestFailure = result.delivery;
      }
    }
  }
  const coverage = { checked, total: projectResult.total };
  if (
    newestFailure &&
    Date.now() - newestFailure.observedAt.getTime() <= LOCAL_OBSERVATION_FRESH_MS
  ) {
    return {
      mode: "down",
      observedAt: newestFailure.observedAt.toISOString(),
      evidenceSource: "provider-delivery",
      coverage,
      message:
        newestFailure.status === 401
          ? "A GitLab webhook delivery was rejected with HTTP 401: the project's secret token differs from GITLAB_WEBHOOK_SECRET."
          : `A checked GitLab webhook's latest delivery failed with HTTP ${newestFailure.status}.`,
    };
  }
  if (rateLimited) {
    return {
      mode: "degraded",
      coverage,
      message: "GitLab rate-limited the test delivery; scan again in a minute.",
    };
  }
  if (newest && Date.now() - newest.observedAt.getTime() <= LOCAL_OBSERVATION_FRESH_MS) {
    return {
      mode: "live",
      observedAt: newest.observedAt.toISOString(),
      evidenceSource: "provider-delivery",
      coverage,
      message: `Webhook verified end to end; the test delivery returned ${newest.status}.`,
    };
  }
  const local = classifyObservations(
    await localObservations("gitlab", config.gitlabWebhookSecret),
  );
  if (local.mode !== "configured") return { ...local, coverage };
  return {
    mode: "degraded",
    coverage,
    message:
      testedWithoutEvidence > 0
        ? "GitLab accepted the test request, but no delivery result was recorded yet; scan again."
        : "Webhook configuration verified, but no delivery has been recorded in the last 7 days.",
  };
}

async function inspectGitLabWebhook(
  config: SystemHealthConfig,
  project: GitLabProject,
  expectedUrl: string,
  signal: AbortSignal,
  active: boolean,
): Promise<{
  permissionDenied?: true;
  activeEvidenceMissing?: true;
  activeRateLimited?: true;
  activeTested?: true;
  delivery?: { observedAt: Date; status: number };
}> {
  const hooksResponse = await gitlabFetch(config, `/projects/${project.id}/hooks`, signal);
  if (hooksResponse.status === 401) {
    throw new PublicHealthProbeError("GitLab webhook credentials were rejected.");
  }
  if (hooksResponse.status === 403) return { permissionDenied: true };
  if (!hooksResponse.ok) {
    throw new PublicHealthProbeError("GitLab webhook listing failed.");
  }
  const hooks = (await hooksResponse.json()) as Array<{
    id: number;
    url?: string;
    enable_ssl_verification?: boolean;
    merge_requests_events?: boolean;
    pipeline_events?: boolean;
    note_events?: boolean;
    token_present?: boolean;
  }>;
  const hook = hooks.find((candidate) => normalizeUrl(candidate.url ?? "") === expectedUrl);
  if (!hook) {
    throw new PublicHealthProbeError(
      `GitLab webhook is missing for ${project.path_with_namespace ?? project.id}.`,
    );
  }
  if (hook.enable_ssl_verification === false) {
    throw new PublicHealthProbeError("A GitLab webhook disables TLS verification.");
  }
  if (!hook.merge_requests_events || !hook.pipeline_events || !hook.note_events) {
    throw new PublicHealthProbeError("A GitLab webhook is missing required event subscriptions.");
  }
  if (hook.token_present === false) {
    throw new PublicHealthProbeError("A GitLab webhook has no secret token.");
  }
  const activeStartedAt = active ? Date.now() : null;
  if (active) {
    const testResponse = await gitlabFetch(
      config,
      `/projects/${project.id}/hooks/${hook.id}/test/push_events`,
      signal,
      { method: "POST" },
    );
    if (testResponse.status === 429) {
      return { activeTested: true, activeRateLimited: true };
    }
    if (!testResponse.ok) {
      throw new PublicHealthProbeError(
        `GitLab webhook test failed with HTTP ${testResponse.status}.`,
      );
    }
  }
  const eventsResponse = await gitlabFetch(
    config,
    `/projects/${project.id}/hooks/${hook.id}/events?per_page=1&page=1`,
    signal,
  );
  if (!eventsResponse.ok) {
    return active
      ? { activeTested: true, activeEvidenceMissing: true }
      : {};
  }
  const events = (await eventsResponse.json()) as Array<{
    created_at?: string;
    response_status?: string | number;
  }>;
  const event = events[0];
  const observedAt = event?.created_at ? new Date(event.created_at) : null;
  const status = Number(event?.response_status);
  if (!observedAt || !Number.isFinite(status)) {
    return active
      ? { activeTested: true, activeEvidenceMissing: true }
      : {};
  }
  if (
    activeStartedAt !== null &&
    observedAt.getTime() < activeStartedAt - 5_000
  ) {
    return { activeTested: true, activeEvidenceMissing: true };
  }
  return {
    ...(active ? { activeTested: true as const } : {}),
    delivery: { observedAt, status },
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

/** One Slack Web API call; null when Slack is unreachable or answers junk. */
async function slackApi(
  config: SystemHealthConfig,
  method: string,
  body: Record<string, string>,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slackToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
    signal,
  }).catch(() => null);
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Sixty days: far enough that a leaked probe is obvious in the scheduled
 * queue, well inside Slack's 120-day scheduling ceiling. */
const SLACK_PROBE_DELAY_SECONDS = 60 * 24 * 60 * 60;

/** Proves the bot can deliver to the configured channel the same way real
 * notifications do: schedule a message far in the future, then delete it
 * before it can ever post. `conversations.info` asked the wrong question,
 * needing read scopes and channel visibility that posting never requires, so
 * a Slack Connect channel showed "unavailable" while messages flowed fine. */
async function slackChannelDeliveryResult(
  config: SystemHealthConfig,
  signal: AbortSignal,
): Promise<SystemHealthProbeResult> {
  const channel = config.slackChannelId ?? "";
  const postAt = Math.floor(Date.now() / 1000) + SLACK_PROBE_DELAY_SECONDS;
  const scheduled = await slackApi(
    config,
    "chat.scheduleMessage",
    {
      channel,
      post_at: String(postAt),
      text: "System health delivery probe. Deleting this scheduled message failed; it is safe to ignore.",
    },
    signal,
  );
  if (scheduled?.ok !== true) {
    const reason =
      typeof scheduled?.error === "string" ? scheduled.error : "no response";
    throw new PublicHealthProbeError(
      `Slack bot cannot deliver to the configured channel (${reason}).`,
    );
  }
  const scheduledMessageId =
    typeof scheduled.scheduled_message_id === "string"
      ? scheduled.scheduled_message_id
      : null;
  if (scheduledMessageId) {
    await slackApi(
      config,
      "chat.deleteScheduledMessage",
      { channel, scheduled_message_id: scheduledMessageId },
      signal,
    );
  }
  return {
    mode: "live",
    message:
      "Delivery verified: a probe message was scheduled in the channel and deleted before sending.",
  };
}

async function customWebhookAggregate(): Promise<SystemHealthProbeResult> {
  const db = getDb();
  const endpoints = await db
    .select({ id: webhookTriggerEndpoints.id, revokedAt: webhookTriggerEndpoints.revokedAt })
    .from(webhookTriggerEndpoints);
  const active = endpoints.filter((endpoint) => !endpoint.revokedAt);
  if (active.length === 0) {
    return {
      mode: "not-configured",
      message: "No active custom webhook endpoint exists.",
      coverage: { checked: 0, total: endpoints.length },
    };
  }
  const latestDelivery = await db
    .select({ createdAt: webhookTriggerDeliveries.createdAt })
    .from(webhookTriggerDeliveries)
    .innerJoin(
      webhookTriggerEndpoints,
      eq(webhookTriggerDeliveries.endpointId, webhookTriggerEndpoints.id),
    )
    .where(isNull(webhookTriggerEndpoints.revokedAt))
    .orderBy(desc(webhookTriggerDeliveries.createdAt))
    .limit(1);
  const rejection = await db
    .select({ count: webhookTriggerRejectionCounters.count })
    .from(webhookTriggerRejectionCounters)
    .innerJoin(
      webhookTriggerEndpoints,
      eq(webhookTriggerRejectionCounters.endpointId, webhookTriggerEndpoints.id),
    )
    .where(
      and(
        isNull(webhookTriggerEndpoints.revokedAt),
        gte(webhookTriggerRejectionCounters.windowStart, utcDayStart()),
      ),
    )
    .limit(1)
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

function gitlabFetch(
  config: SystemHealthConfig,
  path: string,
  signal: AbortSignal,
  init: RequestInit = {},
): Promise<Response> {
  const host = (config.gitlabHost ?? "https://gitlab.com").replace(/\/+$/, "");
  return fetch(`${host}/api/v4${path}`, {
    ...init,
    headers: { ...init.headers, "PRIVATE-TOKEN": config.gitlabToken! },
    signal,
  });
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
  provider: "github" | "gitlab" | "resend" | "jira",
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
