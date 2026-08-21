"use client";

import { useEffect, useRef, useState } from "react";
import type {
  SystemHealthCheck,
  SystemHealthGroup,
  SystemHealthIntegration,
  SystemHealthMode,
  SystemHealthResponse,
} from "@shared/contracts";

const GROUPS: Array<{
  id: SystemHealthGroup;
  label: string;
  description: string;
}> = [
  {
    id: "core",
    label: "Execution path",
    description: "Services every workflow depends on while it researches and publishes changes.",
  },
  {
    id: "auth-email",
    label: "Access & email",
    description: "Human access to the dashboard and optional account delivery channels.",
  },
  {
    id: "platform",
    label: "Platform extensions",
    description: "Optional integrations that add notifications, traces, remote tools, and hosting context.",
  },
];

const DESCRIPTIONS: Record<string, string> = {
  database: "Stores workflow state, ownership, traces, and dashboard data.",
  jira: "Authenticates the account and checks access to the configured project.",
  github: "Checks App auth, repository access, webhook configuration, and recent deliveries separately.",
  gitlab: "Checks API access, projects, webhook configuration, and delivery responses separately.",
  agent: "Authenticates the active provider and checks the configured model when possible.",
  "dashboard-auth": "Presence-checks auth settings; this request already proves session enforcement.",
  sso: "Checks OIDC discovery; client credentials remain presence-checked.",
  email: "Checks Resend sender readiness and delivery-status webhooks independently.",
  slack: "Checks bot auth, channel access, and signed slash commands independently.",
  arthur: "Reads the task API used by traces, evaluations, and guardrails.",
  mcp: "Checks that the enabled remote tool contract contains tools.",
  vercel: "Reads the configured project when explicit credentials are available.",
  "custom-webhooks": "Aggregates active custom endpoints, deliveries, and rejection counters.",
};

const STATUS: Record<
  SystemHealthMode,
  { label: string; dot: string; badge: string }
> = {
  live: {
    label: "Live",
    dot: "bg-success",
    badge: "border-[#B8DDAA] bg-success-bg text-success-fg",
  },
  down: {
    label: "Down",
    dot: "bg-fail",
    badge: "border-[#F0B8AE] bg-fail-bg text-fail-fg",
  },
  degraded: {
    label: "Degraded",
    dot: "bg-burnt-orange",
    badge: "border-orange-300 bg-orange-100 text-[#A23E18]",
  },
  unverified: {
    label: "Unverified",
    dot: "bg-[#D6A84B]",
    badge: "border-[#E7D3A1] bg-[#FFF8E7] text-[#7A5714]",
  },
  configured: {
    label: "Configured",
    dot: "bg-mariner",
    badge: "border-mariner-300 bg-mariner-100 text-mariner",
  },
  "not-configured": {
    label: "Not configured",
    dot: "bg-neutral-400",
    badge: "border-neutral-200 bg-app-bg text-neutral-600",
  },
  misconfigured: {
    label: "Needs configuration",
    dot: "bg-burnt-orange",
    badge: "border-orange-300 bg-orange-100 text-[#A23E18]",
  },
  mock: {
    label: "Mock mode",
    dot: "bg-neutral-500",
    badge: "border-neutral-300 bg-neutral-100 text-neutral-700",
  },
};

const REFRESH_TIMEOUT_MS = 15_000;

export function HealthScreen({ data }: { data: SystemHealthResponse }) {
  const [currentData, setCurrentData] = useState(data);
  const [refreshing, setRefreshing] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const refreshInFlight = useRef(false);

  useEffect(() => {
    setCurrentData(data);
  }, [data]);

  const refresh = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    setScanError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    try {
      const response = await fetch("/api/system-health", {
        method: "POST",
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as
        | SystemHealthResponse
        | { error?: unknown }
        | null;
      if (!response.ok || !body || !("integrations" in body)) {
        throw new Error(
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : "System health scan failed",
        );
      }
      setCurrentData(body);
    } catch (error) {
      setScanError(
        error instanceof DOMException && error.name === "AbortError"
          ? "System health scan timed out."
          : error instanceof Error
            ? error.message
            : "System health scan failed.",
      );
    } finally {
      clearTimeout(timeout);
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  };
  const criticalAlerts = currentData.alerts.filter((alert) => alert.severity === "critical");
  const capabilityChecks = currentData.integrations.flatMap(
    (integration) => integration.checks ?? [],
  );
  const criticalVerificationIncomplete = currentData.integrations.some(
    (integration) => {
      if (!integration.critical) return false;
      const checks = integration.checks ?? [];
      if (checks.length === 0) {
        return integration.mode === "unverified" || integration.mode === "degraded";
      }
      return checks.some(
        (check) =>
          check.critical &&
          (check.mode === "unverified" || check.mode === "degraded"),
      );
    },
  );
  const overall = criticalAlerts.length > 0
    ? {
        label: "Action required",
        text:
          currentData.summary.criticalDown > 0
            ? `${currentData.summary.criticalDown} critical ${currentData.summary.criticalDown === 1 ? "service is" : "services are"} down.`
            : "Critical deployment configuration is incomplete.",
        className: "border-[#F0B8AE] bg-fail-bg text-fail-fg",
      }
    : criticalVerificationIncomplete
      ? {
          label: "Verification incomplete",
          text: "A critical capability needs fresh successful evidence before this deployment is ready.",
          className: "border-[#E7D3A1] bg-[#FFF8E7] text-[#7A5714]",
        }
      : currentData.alerts.length > 0
      ? {
          label: "Check configuration",
          text: "The execution path is available, but optional setup needs attention.",
          className: "border-orange-300 bg-orange-100 text-[#A23E18]",
        }
      : {
          label: "Operational",
          text: "No critical issue was detected in this scan.",
          className: "border-[#B8DDAA] bg-success-bg text-success-fg",
        };

  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 pb-10 pt-5 lg:px-6 lg:pt-6">
      <header className="mb-5 flex flex-col gap-4 border-b border-neutral-300 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.09em] text-neutral-500">
            Deployment diagnostic
          </div>
          <h1 className="font-display text-[25px] font-semibold leading-tight tracking-[-0.025em] text-neutral-900">
            System health
          </h1>
          <p className="mt-1 max-w-[650px] font-body text-[13px] leading-5 text-neutral-600">
            Live connectivity for the execution path, plus configuration readiness for optional services. Secret values never appear here.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <time
            dateTime={currentData.generatedAt}
            className="font-mono text-[10px] leading-4 text-neutral-500"
          >
            Scanned {formatTime(currentData.generatedAt)}
          </time>
          <button
            type="button"
            disabled={refreshing}
            onClick={refresh}
            className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-3 py-2 font-body text-[12px] font-semibold text-neutral-800 transition-colors duration-[120ms] hover:border-neutral-400 hover:bg-app-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mariner disabled:cursor-wait disabled:opacity-60"
          >
            {refreshing ? "Scanning…" : "Scan again"}
          </button>
        </div>
      </header>

      <section
        aria-label="Health summary"
        className="mb-5 grid overflow-hidden rounded-[4px] border border-neutral-200 bg-panel sm:grid-cols-[minmax(260px,1.5fr)_repeat(4,minmax(90px,0.65fr))]"
      >
        <div className={`border-b px-4 py-4 sm:border-b-0 sm:border-r ${overall.className}`}>
          <div className="font-display text-[18px] font-semibold tracking-[-0.02em]">
            {overall.label}
          </div>
          <p className="mt-1 font-body text-[12px] leading-4 opacity-85">{overall.text}</p>
        </div>
        <SummaryCell
          label="Live checks"
          value={
            currentData.summary.checksLive ??
            capabilityChecks.filter((check) => check.mode === "live").length
          }
        />
        <SummaryCell
          label="Down"
          value={
            currentData.summary.checksDown ??
            capabilityChecks.filter((check) => check.mode === "down").length
          }
          danger={
            (currentData.summary.checksDown ??
              capabilityChecks.filter((check) => check.mode === "down").length) > 0
          }
        />
        <SummaryCell
          label="Degraded"
          value={
            currentData.summary.checksDegraded ??
            capabilityChecks.filter((check) => check.mode === "degraded").length
          }
        />
        <SummaryCell
          label="Unverified"
          value={
            currentData.summary.checksUnverified ??
            capabilityChecks.filter((check) => check.mode === "unverified").length
          }
        />
      </section>

      {scanError && (
        <div role="alert" className="mb-5 rounded-[4px] border border-[#F0B8AE] bg-fail-bg px-3 py-3 font-body text-[12px] text-fail-fg">
          {scanError}
        </div>
      )}

      {currentData.alerts.length > 0 && (
        <section aria-labelledby="health-alerts" className="mb-5">
          <h2
            id="health-alerts"
            className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-600"
          >
            Needs attention
          </h2>
          <div className="grid gap-2">
            {currentData.alerts.map((alert) => (
              <div
                key={`${alert.integrationId}:${alert.checkId ?? "integration"}:${alert.message}`}
                role={alert.severity === "critical" ? "alert" : undefined}
                className={`rounded-[4px] border px-3 py-3 ${
                  alert.severity === "critical"
                    ? "border-[#F0B8AE] bg-fail-bg"
                    : "border-orange-300 bg-orange-100"
                }`}
              >
                <div className="font-body text-[12px] font-semibold text-neutral-900">
                  {alert.message}
                </div>
                <div className="mt-1 font-mono text-[10px] leading-4 text-neutral-700">
                  {alert.fixHint}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4">
        {GROUPS.map((group) => {
          const integrations = currentData.integrations.filter(
            (integration) => integration.group === group.id,
          );
          return (
            <section
              key={group.id}
              aria-labelledby={`health-group-${group.id}`}
              className="overflow-hidden rounded-[4px] border border-neutral-200 bg-panel"
            >
              <div className="border-b border-neutral-200 bg-neutral-100 px-4 py-3">
                <h2
                  id={`health-group-${group.id}`}
                  className="font-display text-[15px] font-semibold tracking-[-0.01em] text-neutral-900"
                >
                  {group.label}
                </h2>
                <p className="mt-0.5 font-body text-[11px] leading-4 text-neutral-600">
                  {group.description}
                </p>
              </div>
              <ol className="m-0 list-none p-0">
                {integrations.map((integration, index) => (
                  <HealthRow
                    key={integration.id}
                    integration={integration}
                    first={index === 0}
                    last={index === integrations.length - 1}
                  />
                ))}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 last:border-b-0 sm:block sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="font-mono text-[9px] uppercase tracking-[0.07em] text-neutral-500">
        {label}
      </div>
      <div
        className={`font-display text-[20px] font-semibold tracking-[-0.02em] ${danger ? "text-fail" : "text-neutral-900"}`}
      >
        {value}
      </div>
    </div>
  );
}

function HealthRow({
  integration,
  first,
  last,
}: {
  integration: SystemHealthIntegration;
  first: boolean;
  last: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = STATUS[integration.mode];
  const checks = integration.checks ?? [];
  return (
    <li className={`grid grid-cols-[30px_minmax(0,1fr)] px-4 ${last ? "" : "border-b border-neutral-200"}`}>
      <div className="relative flex justify-center" aria-hidden="true">
        {!first && <span className="absolute top-0 h-1/2 w-px bg-neutral-300" />}
        {!last && <span className="absolute bottom-0 h-1/2 w-px bg-neutral-300" />}
        <span className={`relative z-10 mt-[22px] h-2.5 w-2.5 rounded-full ring-4 ring-white ${status.dot}`} />
      </div>
      <div className="min-w-0 py-4">
        <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(180px,1fr)_minmax(220px,1.2fr)_auto] sm:items-center">
          <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-body text-[13px] font-semibold text-neutral-900">
              {integration.label}
            </h3>
            {integration.critical && (
              <span className="font-mono text-[8px] uppercase tracking-[0.07em] text-neutral-500">
                Critical
              </span>
            )}
          </div>
          <p className="mt-0.5 font-body text-[11px] leading-4 text-neutral-600">
            {DESCRIPTIONS[integration.id] ?? "Deployment integration."}
          </p>
          {integration.ping && (
            <div className="mt-1 font-mono text-[9px] text-neutral-500">
              {integration.ping.latencyMs} ms
            </div>
          )}
          </div>
          <div className="flex min-w-0 flex-wrap gap-1.5">
          {integration.envVars.map((name) => (
            <code
              key={name}
              className="max-w-full break-all rounded-[3px] bg-app-bg px-1.5 py-1 font-mono text-[9px] text-neutral-600"
            >
              {name}
            </code>
          ))}
          </div>
          <div className="flex items-center gap-2 sm:justify-self-end">
            <span
              className={`inline-flex rounded-pill border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] ${status.badge}`}
            >
              {status.label}
            </span>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={`health-checks-${integration.id}`}
              onClick={() => setExpanded((value) => !value)}
              className="rounded-[3px] border border-neutral-200 bg-panel px-2 py-1 font-mono text-[9px] text-neutral-700 hover:bg-app-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mariner"
            >
              {expanded ? "Hide checks" : `${checks.length} checks`}
            </button>
          </div>
        </div>
        {expanded && (
          <ol
            id={`health-checks-${integration.id}`}
            className="mt-3 grid list-none gap-2 border-t border-neutral-200 pt-3"
          >
            {checks.map((check) => (
              <HealthCheckRow key={check.id} check={check} />
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

function HealthCheckRow({ check }: { check: SystemHealthCheck }) {
  const status = STATUS[check.mode];
  return (
    <li className="grid gap-2 rounded-[3px] bg-app-bg px-3 py-2 sm:grid-cols-[minmax(180px,0.9fr)_minmax(220px,1.2fr)_auto] sm:items-start">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-body text-[11px] font-semibold text-neutral-900">
            {check.label}
          </span>
          {check.critical && (
            <span className="font-mono text-[8px] uppercase tracking-[0.07em] text-neutral-500">
              Required
            </span>
          )}
        </div>
        <p className="mt-0.5 font-body text-[10px] leading-4 text-neutral-600">
          {check.message ?? check.description}
        </p>
        <div className="mt-1 font-mono text-[9px] text-neutral-500">
          {evidenceLabel(check)}
          {check.latencyMs !== undefined ? ` · ${check.latencyMs} ms` : ""}
          {check.coverage ? ` · ${check.coverage.checked}/${check.coverage.total} checked` : ""}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {check.envVars.map((name) => (
          <code
            key={name}
            className="max-w-full break-all rounded-[3px] bg-panel px-1.5 py-1 font-mono text-[9px] text-neutral-600"
          >
            {name}
          </code>
        ))}
      </div>
      <span className={`inline-flex w-fit rounded-pill border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] ${status.badge}`}>
        {status.label}
      </span>
    </li>
  );
}

function evidenceLabel(check: SystemHealthCheck): string {
  const source: Record<SystemHealthCheck["evidenceSource"], string> = {
    "live-probe": "Live probe",
    "provider-config": "Provider config",
    "provider-delivery": "Provider delivery",
    "local-observation": "Observed request",
    configuration: "Configuration",
  };
  const timestamp = check.observedAt ?? check.checkedAt;
  return timestamp
    ? `${source[check.evidenceSource]} · ${formatTime(timestamp)}`
    : source[check.evidenceSource];
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
