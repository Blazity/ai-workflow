"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
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
  github: "Checks the App installation; the webhook secret is presence-checked.",
  gitlab: "Authenticates the API token; the webhook secret is presence-checked.",
  agent: "Authenticates the active provider and checks the configured model when possible.",
  "dashboard-auth": "Presence-checks auth settings; this request already proves session enforcement.",
  sso: "Checks OIDC discovery; client credentials remain presence-checked.",
  email: "Authenticates Resend; sender configuration remains presence-checked.",
  slack: "Authenticates the bot token; the channel ID remains presence-checked.",
  arthur: "Reads the task API used by traces, evaluations, and guardrails.",
  mcp: "Checks that the enabled remote tool contract contains tools.",
  vercel: "Reads the configured project when explicit credentials are available.",
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

export function HealthScreen({ data }: { data: SystemHealthResponse }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const criticalAlerts = data.alerts.filter((alert) => alert.severity === "critical");
  const overall = criticalAlerts.length > 0
    ? {
        label: "Action required",
        text:
          data.summary.criticalDown > 0
            ? `${data.summary.criticalDown} critical ${data.summary.criticalDown === 1 ? "service is" : "services are"} down.`
            : "Critical deployment configuration is incomplete.",
        className: "border-[#F0B8AE] bg-fail-bg text-fail-fg",
      }
    : data.alerts.length > 0
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
            dateTime={data.generatedAt}
            className="font-mono text-[10px] leading-4 text-neutral-500"
          >
            Scanned {formatTime(data.generatedAt)}
          </time>
          <button
            type="button"
            disabled={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
            className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-3 py-2 font-body text-[12px] font-semibold text-neutral-800 transition-colors duration-[120ms] hover:border-neutral-400 hover:bg-app-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mariner disabled:cursor-wait disabled:opacity-60"
          >
            {refreshing ? "Scanning…" : "Scan again"}
          </button>
        </div>
      </header>

      <section
        aria-label="Health summary"
        className="mb-5 grid overflow-hidden rounded-[4px] border border-neutral-200 bg-panel sm:grid-cols-[minmax(280px,1.7fr)_repeat(3,minmax(110px,0.7fr))]"
      >
        <div className={`border-b px-4 py-4 sm:border-b-0 sm:border-r ${overall.className}`}>
          <div className="font-display text-[18px] font-semibold tracking-[-0.02em]">
            {overall.label}
          </div>
          <p className="mt-1 font-body text-[12px] leading-4 opacity-85">{overall.text}</p>
        </div>
        <SummaryCell label="Live checks" value={data.summary.live} />
        <SummaryCell label="Down" value={data.summary.down} danger={data.summary.down > 0} />
        <SummaryCell label="Not configured" value={data.summary.notConfigured} />
      </section>

      {data.alerts.length > 0 && (
        <section aria-labelledby="health-alerts" className="mb-5">
          <h2
            id="health-alerts"
            className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-600"
          >
            Needs attention
          </h2>
          <div className="grid gap-2">
            {data.alerts.map((alert) => (
              <div
                key={`${alert.integrationId}:${alert.message}`}
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
          const integrations = data.integrations.filter(
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
  const status = STATUS[integration.mode];
  return (
    <li className={`grid grid-cols-[30px_minmax(0,1fr)] px-4 ${last ? "" : "border-b border-neutral-200"}`}>
      <div className="relative flex justify-center" aria-hidden="true">
        {!first && <span className="absolute top-0 h-1/2 w-px bg-neutral-300" />}
        {!last && <span className="absolute bottom-0 h-1/2 w-px bg-neutral-300" />}
        <span className={`relative z-10 mt-[22px] h-2.5 w-2.5 rounded-full ring-4 ring-white ${status.dot}`} />
      </div>
      <div className="grid min-w-0 gap-3 py-4 sm:grid-cols-[minmax(180px,1fr)_minmax(220px,1.2fr)_auto] sm:items-center">
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
        <div className="sm:justify-self-end">
          <span
            className={`inline-flex rounded-pill border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] ${status.badge}`}
          >
            {status.label}
          </span>
        </div>
      </div>
    </li>
  );
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
