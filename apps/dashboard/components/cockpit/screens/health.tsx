"use client";

import { useRef, useState, useSyncExternalStore } from "react";
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
    description: "Optional integrations that add notifications, traces, and remote tools.",
  },
];

const DESCRIPTIONS: Record<string, string> = {
  database: "Stores workflow state, ownership, traces, and dashboard data.",
  jira: "Authenticates the account, checks the project, and verifies the webhook registration.",
  github: "Checks App auth, repository access, webhook configuration, and the latest delivery separately.",
  gitlab: "Checks API access, projects, and sends a real test delivery through the project webhook.",
  agent: "Authenticates the active provider and checks the configured model when possible.",
  "dashboard-auth": "Presence-checks auth settings; this request already proves session enforcement.",
  sso: "Checks OIDC discovery; client credentials are presence-checked.",
  email: "Checks Resend sender readiness and the delivery-status webhook registration.",
  slack: "Checks bot auth, channel access, and recent slash-command signatures.",
  arthur: "Reads the task API used by traces, evaluations, and guardrails.",
  mcp: "Checks that the enabled remote tool contract contains tools.",
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

const SCAN_TIMEOUT_MS = 15_000;

/**
 * Nothing is fetched on mount and nothing polls: the only request this screen
 * ever makes is the POST behind the Scan button, and the worker runs every
 * probe (including the GitLab test delivery) inside that one request.
 */
export function HealthScreen({
  initialData = null,
}: {
  initialData?: SystemHealthResponse | null;
}) {
  const [data, setData] = useState<SystemHealthResponse | null>(initialData);
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanInFlight = useRef(false);

  const scan = async () => {
    if (scanInFlight.current) return;
    scanInFlight.current = true;
    setScanning(true);
    setScanError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
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
      setData(body);
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
      scanInFlight.current = false;
      setScanning(false);
    }
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
            Shows the last scan; nothing runs in the background. Press Scan to verify every integration again. Secret values never appear here.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {data && (
            <div className="text-right font-mono text-[10px] leading-4 text-neutral-500">
              <time dateTime={data.generatedAt}>
                Scanned {hydrated ? formatScanTime(data.generatedAt) : ""}
              </time>
              <div>{summaryLine(data)}</div>
            </div>
          )}
          <button
            type="button"
            disabled={scanning}
            onClick={scan}
            className="appearance-none rounded-[3px] border border-neutral-300 bg-panel px-3 py-2 font-body text-[12px] font-semibold text-neutral-800 transition-colors duration-[120ms] hover:border-neutral-400 hover:bg-app-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mariner disabled:cursor-wait disabled:opacity-60"
          >
            {scanning ? "Scanning…" : data ? "Scan again" : "Scan"}
          </button>
        </div>
      </header>

      {scanError && (
        <div role="alert" className="mb-5 rounded-[4px] border border-[#F0B8AE] bg-fail-bg px-3 py-3 font-body text-[12px] text-fail-fg">
          {scanError}
        </div>
      )}

      {!data ? (
        <div className="rounded-[4px] border border-dashed border-neutral-300 bg-panel px-4 py-10 text-center font-body text-[13px] text-neutral-600">
          {scanning
            ? "Scanning every integration…"
            : "No scan has been recorded yet. Press Scan to verify every integration now."}
        </div>
      ) : (
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
      )}
    </div>
  );
}

function summaryLine(data: SystemHealthResponse): string {
  const parts = [
    [data.summary.checksLive, "live"],
    [data.summary.checksDown, "down"],
    [data.summary.checksDegraded, "degraded"],
  ] as const;
  return parts
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(" · ");
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
  // Variable names appear once: on the provider while collapsed, and on the
  // checks once expanded, unless every check needs the same set, in which case
  // the provider keeps them and the checks stay clean.
  const checksCarryDistinctVars = checks.some(
    (check) => !sameSet(check.envVars, integration.envVars),
  );
  const showProviderVars = !expanded || !checksCarryDistinctVars;
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
            {showProviderVars && <EnvVarChips names={integration.envVars} />}
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
              <HealthCheckRow
                key={check.id}
                check={check}
                showEnvVars={checksCarryDistinctVars}
              />
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

function HealthCheckRow({
  check,
  showEnvVars,
}: {
  check: SystemHealthCheck;
  showEnvVars: boolean;
}) {
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
        {showEnvVars && <EnvVarChips names={check.envVars} panel />}
      </div>
      <span className={`inline-flex w-fit rounded-pill border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] ${status.badge}`}>
        {status.label}
      </span>
    </li>
  );
}

function EnvVarChips({ names, panel = false }: { names: string[]; panel?: boolean }) {
  return (
    <>
      {names.map((name) => (
        <code
          key={name}
          className={`max-w-full break-all rounded-[3px] px-1.5 py-1 font-mono text-[9px] text-neutral-600 ${panel ? "bg-panel" : "bg-app-bg"}`}
        >
          {name}
        </code>
      ))}
    </>
  );
}

function sameSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((name) => rightSet.has(name));
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

/** Subscribes to nothing: the store only tells server and client renders apart. */
function subscribeNever(): () => void {
  return () => undefined;
}

/** Local date and time of the scan; formatted only after hydration so the
 * server (UTC) and the browser never disagree on the rendered text. */
function formatScanTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}
