// apps/dashboard/lib/settings/overview.ts
//
// "What is this deployment actually set up to do", as a handful of rows.
// Everything here is derived from three reads the dashboard already makes: the
// settings the worker resolved, the last stored system health scan, and the
// repository catalog state.
import type {
  RepositoryCatalogState,
  SettingsEntryView,
  SettingsGroup,
  SystemHealthIntegration,
  SystemHealthMode,
  SystemHealthResponse,
} from "@shared/contracts";
import { capabilityLabel, integrationsProviding } from "@integrations/registry";

import { activationDetail, activationValue } from "@/lib/repository-catalog/activation";

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
  disabled: "Disabled",
};

const MODE_TONES: Record<SystemHealthMode, SetupOverviewTone> = {
  live: "ok",
  down: "bad",
  degraded: "warn",
  configured: "ok",
  "not-configured": "off",
  misconfigured: "warn",
  mock: "warn",
  // Turned off deliberately: the same tone as something nobody set up, because
  // neither is a problem to chase.
  disabled: "off",
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
  // Nothing about a provider somebody switched off says this deployment is set
  // up to use it, so it never wins the row over one that is.
  disabled: 0,
};

const MEMORY_KEY = "ENABLE_REPO_MEMORY";
const MEMORY_PROMOTION_KEY = "ENABLE_ORG_MEMORY_PROMOTION";
const MEMORY_ROUTING_KEY = "ENABLE_REPO_ROUTING_MEMORY";
const MCP_KEY = "MCP_ENABLED";
const MCP_PUBLIC_DCR_KEY = "MCP_ALLOW_PUBLIC_DCR";

function valueOf(
  settings: readonly SettingsEntryView[],
  key: string,
): SettingsEntryView | undefined {
  return settings.find((entry) => entry.key === key);
}

function isOn(settings: readonly SettingsEntryView[], key: string): boolean {
  return valueOf(settings, key)?.value === true;
}

/** The row's answer when the scan cannot say anything, or null when it can. */
function scanlessRow(
  id: string,
  label: string,
  integrations: readonly SystemHealthIntegration[] | null,
  scanReadable: boolean,
): SetupOverviewRow | null {
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
  return null;
}

function alsoSeen(others: readonly SystemHealthIntegration[]): string {
  return others.length > 0
    ? ` Also seen: ${others
        .map((entry) => `${entry.label} ${MODE_LABELS[entry.mode].toLowerCase()}`)
        .join(", ")}.`
    : "";
}

/**
 * A capability every connected provider serves at once (version control): the
 * row reports the one that is actually set up and names the rest.
 */
function manyProviderRow(
  id: string,
  label: string,
  integrations: readonly SystemHealthIntegration[] | null,
  scanReadable: boolean,
): SetupOverviewRow {
  const scanless = scanlessRow(id, label, integrations, scanReadable);
  if (scanless) return scanless;
  // Past that check the scan was read, so the list is there.
  const entries = integrations ?? [];
  const best = [...entries].sort(
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
  return {
    id,
    label,
    value: MODE_LABELS[best.mode],
    tone: MODE_TONES[best.mode],
    detail: `${best.label}.${alsoSeen(entries.filter((entry) => entry !== best))}`,
  };
}

/** A provider an admin switched on and connected, working or not. */
function countsAsChosen(entry: SystemHealthIntegration): boolean {
  return entry.mode !== "disabled" && entry.mode !== "not-configured";
}

/**
 * A capability with ONE provider (the issue tracker), by the worker's rule
 * (`oneProviderChoice` in apps/worker/src/engine/definition/
 * integration-availability.ts): every provider switched on and connected
 * counts, working or not. Two counted is a choice nobody made and the worker
 * uses neither, so the row says that rather than showing the healthier one,
 * which would describe a deployment that does not exist. One counted is that
 * one in whatever state it is, never a fallback to another.
 */
export function oneProviderRow(
  id: string,
  label: string,
  integrations: readonly SystemHealthIntegration[] | null,
  scanReadable: boolean,
): SetupOverviewRow {
  const scanless = scanlessRow(id, label, integrations, scanReadable);
  if (scanless) return scanless;
  // Past that check the scan was read, so the list is there.
  const entries = integrations ?? [];
  const chosen = entries.filter(countsAsChosen);
  const others = entries.filter((entry) => !countsAsChosen(entry));
  const [only] = chosen;
  if (!only) {
    return {
      id,
      label,
      value: "Not configured",
      tone: "off",
      detail:
        entries.length === 0
          ? "The last scan found no integration of this kind."
          : `The last scan found none switched on and connected.${alsoSeen(others)}`,
    };
  }
  if (chosen.length > 1) {
    const names = chosen.map((entry) => entry.label);
    const listed = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    return {
      id,
      label,
      value: "No provider chosen",
      tone: "bad",
      detail:
        `${listed} are all switched on, and only one can serve ${label.toLowerCase()}, ` +
        "so runs use none of them. Switch off the one you do not want on the Integrations page." +
        alsoSeen(others),
    };
  }
  return {
    id,
    label,
    value: MODE_LABELS[only.mode],
    tone: MODE_TONES[only.mode],
    detail: `${only.label}.${alsoSeen(others)}`,
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

/**
 * Whether the catalog decides what the agent may touch.
 *
 * Read from the catalog state row, the sole owner of activation. The label says
 * "Repository catalog", not "Stored setting", because this row is not a stored
 * setting.
 */
function catalogRow(state: RepositoryCatalogState | null): SetupOverviewRow {
  const value = activationValue(state);
  return {
    id: "catalog",
    label: "Repository catalog",
    value,
    tone: value === "Activated" ? "ok" : value === "Unknown" ? "unknown" : "warn",
    detail: activationDetail(state),
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
  /** The catalog state the worker returned, or null when it did not answer the
   *  catalog read. Activation lives in that row, not in the settings. */
  catalogState: RepositoryCatalogState | null;
}): SetupOverview {
  const { settings, scan, scanReadable, catalogState } = input;
  const byId = (...ids: string[]): SystemHealthIntegration[] | null =>
    scan ? scan.integrations.filter((entry) => ids.includes(entry.id)) : null;
  // Every version control provider this build ships, which since S11 is all of
  // them: the row is the health of whichever ones the scan reported.
  const vcsIntegrationIds = integrationsProviding("vcs").map((manifest) => manifest.id);
  const issueTrackerIntegrationIds = integrationsProviding("issue_tracker").map(
    (manifest) => manifest.id,
  );

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
      oneProviderRow(
        "issue-tracker",
        capabilityLabel("issue_tracker") ?? "Issue tracker",
        byId(...issueTrackerIntegrationIds),
        scanReadable,
      ),
      manyProviderRow(
        "vcs",
        capabilityLabel("vcs") ?? "Version control",
        byId(...vcsIntegrationIds),
        scanReadable,
      ),
      secretsRow(scan, scanReadable),
      catalogRow(catalogState),
      featureRow(settings),
      mcpRow(settings),
      memoryRow(settings),
    ],
    storedRows,
    storedTotal,
    hasStoredRows: storedTotal > 0,
  };
}
