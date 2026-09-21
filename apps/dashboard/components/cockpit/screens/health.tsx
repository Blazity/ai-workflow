"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import type {
  RepositoryCatalogState,
  SettingsEntryView,
  SystemHealthCheck,
  SystemHealthGroup,
  SystemHealthIntegration,
  SystemHealthMode,
  SystemHealthResponse,
} from "@shared/contracts";
import { integrationManifest } from "@integrations/registry";
import { apiClient } from "@/lib/api/client";
import { SetupOverview } from "@/app/(cockpit)/settings/setup-overview";
import { SettingsCadenceNotice } from "@/app/(cockpit)/settings/settings-cadence-notice";
import { Button } from "@/components/ui/button";
import { formatDateTime, isOlderThanHours } from "@/lib/date-time";

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
  {
    id: "integrations",
    label: "Integrations",
    description:
      "Providers connected on this deployment. Each brings its own connection and its own checks.",
  },
];

/**
 * The sections to draw, in this order, from the scan alone.
 *
 * A group with nothing in it is left out: a deployment that connected no
 * integration should read exactly as it did before there were any. A group this
 * build does not know still gets a section, because a stored scan may come from
 * a build that shipped one, and a row nobody drew is a row nobody can fix.
 */
function sectionsOf(integrations: SystemHealthIntegration[]): Array<{
  id: string;
  label: string;
  description: string;
  rows: SystemHealthIntegration[];
}> {
  const known = GROUPS.map((group) => ({
    ...group,
    rows: integrations.filter((integration) => integration.group === group.id),
  }));
  const knownIds = new Set(GROUPS.map((group) => group.id));
  const unknown = [
    ...new Set(
      integrations
        .map((integration) => integration.group)
        .filter((group) => !knownIds.has(group)),
    ),
  ].map((group) => ({
    id: group,
    label: titleCase(group),
    description: "Reported by the build that ran this scan.",
    rows: integrations.filter((integration) => integration.group === group),
  }));
  return [...known, ...unknown].filter((section) => section.rows.length > 0);
}

function titleCase(value: string): string {
  const words = value.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a CORE section is, in core's own words.
 *
 * An integration is not in here and cannot be: it describes itself in its
 * manifest, and a line written here would be core's opinion of a package it
 * knows nothing about, kept up to date by nobody.
 */
const DESCRIPTIONS: Record<string, string> = {
  database: "Stores workflow state, ownership, traces, and dashboard data.",
  jira: "Authenticates the account, checks the project, and verifies the webhook registration.",
  agent: "Authenticates the active provider and checks the configured model when possible.",
  "dashboard-auth": "Presence-checks auth settings; this request already proves session enforcement.",
  sso: "Checks OIDC discovery; client credentials are presence-checked.",
  email: "Checks Resend sender readiness and the delivery-status webhook registration.",
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
  // Somebody turned this off on purpose. It is not an outage and not a gap in
  // the configuration, so it carries no warning colour.
  disabled: {
    label: "Disabled",
    dot: "bg-neutral-400",
    badge: "border-neutral-300 bg-neutral-100 text-neutral-600",
  },
};

/** A scan from another build may carry a word this one has no entry for. The
 *  screen says so instead of throwing while somebody reads it mid-incident. */
const UNKNOWN_STATUS = {
  label: "Unknown",
  dot: "bg-neutral-400",
  badge: "border-neutral-300 bg-neutral-100 text-neutral-600",
};

function statusOf(mode: SystemHealthMode): { label: string; dot: string; badge: string } {
  return STATUS[mode] ?? UNKNOWN_STATUS;
}

const SCAN_TIMEOUT_MS = 15_000;
const STALE_SCAN_AFTER_HOURS = 24;

/**
 * Nothing is fetched on mount and nothing polls: the only request this screen
 * ever makes is the POST behind the Scan button, and the worker runs every
 * probe inside that one request.
 */
export function HealthScreen({
  initialData = null,
  settings = [],
  catalogState = null,
}: {
  initialData?: SystemHealthResponse | null;
  /** Every resolved setting; empty when the settings read failed. The setup
   *  overview is computed from these and from the scan below it, so a fresh
   *  Scan moves the overview as well as the probes. */
  settings?: readonly SettingsEntryView[];
  /** The repository catalog state row, or null when the catalog read failed.
   *  The overview's catalog line is read from it and never from a setting. */
  catalogState?: RepositoryCatalogState | null;
}) {
  const [data, setData] = useState<SystemHealthResponse | null>(initialData);
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanInFlight = useRef(false);
  const scanIsStale =
    hydrated && data !== null && isOlderThanHours(data.generatedAt, STALE_SCAN_AFTER_HOURS);

  const scan = async () => {
    if (scanInFlight.current) return;
    scanInFlight.current = true;
    setScanning(true);
    setScanError(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
    try {
      const response = await apiClient.systemHealth.scan(controller.signal);
      const body = response.ok ? response.data : response.error;
      if (
        !response.ok ||
        body === null ||
        typeof body !== "object" ||
        !("integrations" in body)
      ) {
        throw new Error(
          body !== null &&
            typeof body === "object" &&
            "error" in body &&
            typeof body.error === "string"
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
                Scanned {hydrated ? formatDateTime(data.generatedAt) : ""}
              </time>
              <div>{summaryLine(data)}</div>
            </div>
          )}
          <Button
            type="button"
            variant="text"
            disabled={scanning}
            onClick={scan}
            className="rounded-[3px] border border-neutral-300 bg-panel px-3 py-2 font-body text-[12px] font-semibold text-neutral-800 transition-colors duration-[var(--motion-fast)] hover:border-neutral-400 hover:bg-app-bg disabled:cursor-wait disabled:opacity-60"
          >
            {scanning ? "Scanning…" : data ? "Scan again" : "Scan"}
          </Button>
        </div>
      </header>

      {scanError && (
        <div role="alert" className="mb-5 rounded-[4px] border border-[#F0B8AE] bg-fail-bg px-3 py-3 font-body text-[12px] text-fail-fg">
          {scanError}
        </div>
      )}

      {scanIsStale && data ? (
        <div role="note" className="mb-5 rounded-sm border border-orange-300 bg-orange-100 px-3 py-2 font-body text-[12px] text-neutral-800">
          This scan is older than 24 hours. Run a new scan before treating these results as current.
        </div>
      ) : null}

      {settings.length > 0 && (
        <div className="mb-5 flex flex-col gap-2">
          <SettingsCadenceNotice />
          <SetupOverview
            settings={settings}
            scan={data}
            scanReadable
            catalogState={catalogState}
            emptyStoredNote="No setting has been changed from this dashboard yet."
          />
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
          {sectionsOf(data.integrations).map((group) => (
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
                {group.rows.map((integration, index) => (
                  <HealthRow
                    // Group and id: an integration owns its id, and a build that
                    // shipped one called `github` would otherwise collide with
                    // core's own row.
                    key={`${integration.group}:${integration.id}`}
                    integration={integration}
                    first={index === 0}
                    last={index === group.rows.length - 1}
                  />
                ))}
              </ol>
            </section>
          ))}
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
  const status = statusOf(integration.mode);
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
            {/* An integration describes itself in its manifest, and the scan
                carries that line: core knows nothing about it to write here.
                The registry answers for a scan that predates the manifest, so
                a section stored by an older build reads as itself rather than
                as "Deployment integration." the day its provider moved out of
                core. Only then a core section's own line. */}
            {integration.description ??
              integrationManifest(integration.id)?.description ??
              DESCRIPTIONS[integration.id] ??
              "Deployment integration."}
          </p>
          {reasonOf(integration) && (
            <p className="mt-1 font-body text-[11px] leading-4 text-neutral-800">
              {reasonOf(integration)}
            </p>
          )}
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
            <Button
              type="button"
              variant="text"
              aria-expanded={expanded}
              aria-controls={`health-checks-${integration.id}`}
              onClick={() => setExpanded((value) => !value)}
              className="rounded-[3px] border border-neutral-200 bg-panel px-2 py-1 font-mono text-[9px] text-neutral-700 hover:bg-app-bg"
            >
              {expanded
                ? "Hide checks"
                : `${checks.length} ${checks.length === 1 ? "check" : "checks"}`}
            </Button>
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
  const status = statusOf(check.mode);
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

/**
 * The one sentence a row that is not healthy owes the person reading it: what
 * happened, or what to do about it. It is the first check that carries one, so
 * the reason comes from the scan and never from a rule written here.
 */
function reasonOf(integration: SystemHealthIntegration): string | undefined {
  if (integration.mode === "live" || integration.mode === "configured") return undefined;
  // The check that decided the row, which is not always one in the row's own
  // mode: a Degraded integration is usually degraded because one of its checks
  // is Down, and "Degraded" with no sentence leaves an operator nothing to do.
  const worst = [...(integration.checks ?? [])]
    .filter((check) => check.message && SEVERITY[check.mode] > 0)
    .sort((left, right) => SEVERITY[right.mode] - SEVERITY[left.mode])[0];
  return worst?.message;
}

/** How much a check's state asks of the person reading it. Zero means nothing
 *  is wrong, so those checks never speak for a row. */
const SEVERITY: Record<SystemHealthMode, number> = {
  down: 5,
  misconfigured: 4,
  degraded: 3,
  disabled: 2,
  "not-configured": 1,
  mock: 1,
  live: 0,
  configured: 0,
};

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
  return () => {};
}
