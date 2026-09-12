// apps/dashboard/lib/settings/groups.ts
//
// The registry decides which settings exist and what order they come in; this
// module only decides how the dashboard panels them. Keeping the order derived
// from SETTINGS_REGISTRY rather than repeated here means a key added to the
// contracts package appears on the Settings page without a second edit.
import {
  SETTINGS_REGISTRY,
  type SettingsEntryView,
  type SettingsGroup,
} from "@shared/contracts";

/** Every group the registry declares, in the order its keys first appear. */
export const SETTINGS_GROUP_ORDER: readonly SettingsGroup[] = (() => {
  const order: SettingsGroup[] = [];
  for (const definition of SETTINGS_REGISTRY) {
    if (!order.includes(definition.group)) order.push(definition.group);
  }
  return order;
})();

const GROUP_LABELS: Record<SettingsGroup, string> = {
  general: "General",
  capacity: "Capacity",
  attachments: "Attachments",
  features: "Features",
  mcp: "MCP",
  checks: "Checks",
  harness: "Harness defaults",
  "issue-tracker": "Issue tracker",
  triggers: "Triggers",
  repositories: "Repositories",
};

const GROUP_DESCRIPTIONS: Record<SettingsGroup, string> = {
  general: "Names this deployment goes by, and the branch new work is cut from.",
  capacity: "How much work runs at once, and how long one phase may take.",
  attachments: "What the agent is willing to download from a ticket.",
  features:
    "Product behaviour switches. A change reaches the next run, never one already in flight.",
  mcp: "What the remote MCP transport allows one client per minute, per call and per body.",
  checks:
    "What repository checks fall back to when a repository names none of its own.",
  harness:
    "The agent and the models a run uses when no harness profile pins one.",
  "issue-tracker":
    "The board columns the tracker integration watches and moves tickets between.",
  triggers: "The start budget a trigger node falls back to when it declares none.",
  repositories:
    "What the agent may touch at all. Activation happens on the Repositories page.",
};

/** One panel of the Settings page: a registry group and its resolved keys. */
export interface SettingsGroupView {
  readonly id: SettingsGroup;
  readonly label: string;
  readonly description: string;
  readonly entries: readonly SettingsEntryView[];
  /** How many of these keys the store actually holds a row for. */
  readonly storedCount: number;
}

/** How many of these entries the worker resolved from a stored row. */
export function storedRowCount(entries: readonly SettingsEntryView[]): number {
  return entries.filter((entry) => entry.source === "stored").length;
}

/**
 * Split the read response into panels, in registry order.
 *
 * A group with no entries is dropped rather than rendered empty: that only
 * happens when the worker answers with a registry older than this build, and an
 * empty card would read as a missing feature.
 */
export function groupSettings(
  entries: readonly SettingsEntryView[],
): SettingsGroupView[] {
  return SETTINGS_GROUP_ORDER.map((id) => {
    const groupEntries = entries.filter((entry) => entry.group === id);
    return {
      id,
      label: GROUP_LABELS[id],
      description: GROUP_DESCRIPTIONS[id],
      entries: groupEntries,
      storedCount: storedRowCount(groupEntries),
    };
  }).filter((group) => group.entries.length > 0);
}

/**
 * The entries for one group, filtered to a fixed key list and kept in registry
 * order. This is what the Memory and Checks panels render: the same group form,
 * showing only the keys that page is about.
 */
export function selectGroupKeys(
  group: SettingsGroupView,
  keys: readonly string[] | undefined,
): readonly SettingsEntryView[] {
  if (!keys) return group.entries;
  return group.entries.filter((entry) => keys.includes(entry.key));
}
