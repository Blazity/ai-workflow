// apps/dashboard/lib/settings/overview.ts
//
// "What is this deployment actually set up to do", as a handful of rows.
// Everything here is derived from two reads the dashboard already makes: the
// settings the worker resolved, and the last stored system health scan.
import type {
  SettingsEntryView,
  SettingsGroup,
  SystemHealthIntegration,
  SystemHealthMode,
  SystemHealthResponse,
} from "@shared/contracts";

import { groupSettings, storedRowCount } from "./groups";
import { settingLabel } from "./format";

/** How a row reads at a glance. `unknown` means nothing was observed. */
export type SetupOverviewTone = "ok" | "off" | "warn" | "bad" | "unknown";

interface SetupOverviewRow {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly tone: SetupOverviewTone;
  readonly detail: string;
}

interface SetupOverviewStoredRow {
  readonly id: SettingsGroup;
  readonly label: string;
  readonly stored: number;
  readonly total: number;
}

export interface SetupOverview {
  readonly rows: readonly SetupOverviewRow[];
  readonly storedRows: readonly SetupOverviewStoredRow[];
  readonly storedTotal: number;
  /** False while nothing has ever been written from the dashboard. */
  readonly hasStoredRows: boolean;
}

const MODE_LABELS: Record<SystemHealthMode, string> = {
  live: "Connected",
  down: "Down",
  degraded: "Degraded",
  configured: "Configured",
  "not-configured": "Not configured",
  misconfigured: "Needs configuration",
  mock: "Mock mode",
};

const MODE_TONES: Record<SystemHealthMode, SetupOverviewTone> = {
  live: "ok",
  down: "bad",
  degraded: "warn",
  configured: "ok",
  "not-configured": "off",
  misconfigured: "warn",
  mock: "warn",
};

/** Which of two providers to report on: the one that is actually set up. */
const MODE_RANK: Record<SystemHealthMode, number> = {
  live: 6,
  configured: 5,
  degraded: 4,
  misconfigured: 3,
  down: 2,
  mock: 1,
  "not-configured": 0,
};

const MEMORY_KEY = "ENABLE_REPO_MEMORY";
const MEMORY_PROMOTION_KEY = "ENABLE_ORG_MEMORY_PROMOTION";
const MEMORY_ROUTING_KEY = "ENABLE_REPO_ROUTING_MEMORY";
const MCP_KEY = "MCP_ENABLED";
const MCP_PUBLIC_DCR_KEY = "MCP_ALLOW_PUBLIC_DCR";
const CATALOG_KEY = "catalog.activated";

function valueOf(
  settings: readonly SettingsEntryView[],
  key: string,
): SettingsEntryView | undefined {
  return settings.find((entry) => entry.key === key);
}

function isOn(settings: readonly SettingsEntryView[], key: string): boolean {
  return valueOf(settings, key)?.value === true;
}

function integrationRow(
  id: string,
  label: string,
  integrations: readonly SystemHealthIntegration[] | null,
  scanReadable: boolean,
): SetupOverviewRow {
  if (!scanReadable) {
    return {
      id,
      label,
      value: "Not available",
      tone: "unknown",
      detail: "The last system health scan is visible to owners and admins.",
    };
  }
  if (integrations === null) {
    return {
      id,
      label,
      value: "Unknown",
      tone: "unknown",
      detail: "No system health scan has been run yet. Run one on the Health page.",
    };
  }
  const best = [...integrations].sort(
    (a, b) => MODE_RANK[b.mode] - MODE_RANK[a.mode],
  )[0];
  if (!best) {
    return {
      id,
      label,
      value: "Not configured",
      tone: "off",
      detail: "The last scan found no integration of this kind.",
    };
  }
  const others = integrations.filter((entry) => entry !== best);
  const detail = others.length > 0
    ? `${best.label}. Also seen: ${others
        .map((entry) => `${entry.label} ${MODE_LABELS[entry.mode].toLowerCase()}`)
        .join(", ")}.`
    : `${best.label}.`;
  return {
    id,
    label,
    value: MODE_LABELS[best.mode],
    tone: MODE_TONES[best.mode],
    detail,
  };
}

function featureRow(settings: readonly SettingsEntryView[]): SetupOverviewRow {
  const features = settings.filter((entry) => entry.group === "features");
  const on = features.filter((entry) => entry.value === true);
  const off = features.filter((entry) => entry.value !== true);
  return {
    id: "features",
    label: "Features",
    value: `${on.length} of ${features.length} on`,
    tone: on.length > 0 ? "ok" : "off",
    detail:
      on.length === 0
        ? "Every feature switch is off, which is how a fresh deployment starts."
        : `On: ${on.map((entry) => settingLabel(entry.key)).join(", ")}.` +
          (off.length > 0 ? ` Off: ${off.map((entry) => settingLabel(entry.key)).join(", ")}.` : ""),
  };
}

function mcpRow(settings: readonly SettingsEntryView[]): SetupOverviewRow {
  const enabled = isOn(settings, MCP_KEY);
  const publicDcr = isOn(settings, MCP_PUBLIC_DCR_KEY);
  // Only the numeric ceilings are limits. MCP_ALLOW_PUBLIC_DCR sits in the same
  // group and is a switch, so counting it would overstate the count by one.
  const limits = settings.filter(
    (entry) => entry.group === "mcp" && typeof entry.value === "number",
  );
  return {
    id: "mcp",
    label: "Stored setting: Remote MCP",
    value: enabled ? "Serving" : "Off",
    tone: enabled ? "ok" : "off",
    detail: enabled
      ? `Dynamic client registration without a dashboard session is ${
          publicDcr ? "allowed" : "refused"
        }. ${limits.length} limits are in force.`
      : "The transport refuses every request.",
  };
}

function memoryRow(settings: readonly SettingsEntryView[]): SetupOverviewRow {
  const repo = isOn(settings, MEMORY_KEY);
  const promotion = isOn(settings, MEMORY_PROMOTION_KEY);
  const routing = isOn(settings, MEMORY_ROUTING_KEY);
  const extras = [
    promotion ? "organization promotion" : null,
    routing ? "routing memory" : null,
  ].filter((entry): entry is string => entry !== null);
  return {
    id: "memory",
    label: "Stored setting: Agent memory",
    value: repo ? "On" : "Off",
    tone: repo ? "ok" : "off",
    detail: repo
      ? extras.length > 0
        ? `Repository memory, with ${extras.join(" and ")}.`
        : "Repository memory only."
      : promotion || routing
        ? "Repository memory is off, so promotion and routing memory have no effect."
        : "Stored documents are kept, but nothing reads or writes them.",
  };
}

function catalogRow(settings: readonly SettingsEntryView[]): SetupOverviewRow {
  const activated = isOn(settings, CATALOG_KEY);
  return {
    id: "catalog",
    label: "Stored setting: Repository catalog",
    value: activated ? "Activated" : "Not activated",
    tone: activated ? "ok" : "warn",
    detail: activated
      ? "Only repositories enabled in the catalog are selected."
      : "The agent sees everything the installation sees. Activate the catalog on the Repositories page.",
  };
}

/**
 * Which declared environment variables this deployment actually has.
 *
 * The scan reports presence per check rather than per variable, and a check
 * that names three variables reports "misconfigured" when any one of them is
 * missing, so a grouped check counts every name it carries as missing. Variable
 * NAMES are all the worker ever sends; a value never leaves it.
 */
function secretsRow(
  scan: SystemHealthResponse | null,
  scanReadable: boolean,
): SetupOverviewRow {
  if (!scanReadable) {
    return {
      id: "secrets",
      label: "Secrets",
      value: "Not available",
      tone: "unknown",
      detail: "The last system health scan is visible to owners and admins.",
    };
  }
  if (scan === null) {
    return {
      id: "secrets",
      label: "Secrets",
      value: "Unknown",
      tone: "unknown",
      detail: "No system health scan has been run yet. Run one on the Health page.",
    };
  }
  const best = new Map<string, SystemHealthMode>();
  for (const integration of scan.integrations) {
    for (const check of integration.checks) {
      for (const name of check.envVars) {
        const current = best.get(name);
        if (current === undefined || MODE_RANK[check.mode] > MODE_RANK[current]) {
          best.set(name, check.mode);
        }
      }
    }
  }
  const missing = [...best]
    .filter(([, mode]) => mode === "misconfigured")
    .map(([name]) => name)
    .sort();
  const unset = [...best.values()].filter(
    (mode) => mode === "not-configured" || mode === "mock",
  ).length;
  const present = best.size - missing.length - unset;
  return {
    id: "secrets",
    label: "Secrets",
    value: `${present} present, ${missing.length} missing`,
    tone: missing.length > 0 ? "warn" : "ok",
    detail:
      (missing.length > 0
        ? `Missing: ${missing.join(", ")}. `
        : "Every variable a configured integration needs is set. ") +
      (unset > 0
        ? `${unset} more belong to integrations this deployment has not configured.`
        : "") +
      " Names only; a secret value never leaves the worker.",
  };
}

/**
 * The setup overview both the Settings page and the Health page show.
 *
 * `scan` is the last stored system health scan and is null when none has been
 * run; `scanReadable` is false for a member, whose role may not read it at all,
 * because "no scan yet" and "not yours to see" are different answers and a row
 * that conflates them sends the wrong person to run a scan.
 */
export function buildSetupOverview(input: {
  settings: readonly SettingsEntryView[];
  scan: SystemHealthResponse | null;
  scanReadable: boolean;
}): SetupOverview {
  const { settings, scan, scanReadable } = input;
  const byId = (...ids: string[]): SystemHealthIntegration[] | null =>
    scan ? scan.integrations.filter((entry) => ids.includes(entry.id)) : null;

  const groups = groupSettings(settings);
  const storedRows = groups.map((group) => ({
    id: group.id,
    label: group.label,
    stored: group.storedCount,
    total: group.entries.length,
  }));
  const storedTotal = storedRowCount(settings);

  return {
    rows: [
      integrationRow("issue-tracker", "Issue tracker", byId("jira"), scanReadable),
      integrationRow("vcs", "Version control", byId("github", "gitlab"), scanReadable),
      secretsRow(scan, scanReadable),
      catalogRow(settings),
      featureRow(settings),
      mcpRow(settings),
      memoryRow(settings),
    ],
    storedRows,
    storedTotal,
    hasStoredRows: storedTotal > 0,
  };
}
