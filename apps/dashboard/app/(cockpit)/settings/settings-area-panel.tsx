"use client";

import type { SettingsEntryView, SettingsGroup } from "@shared/contracts";

import { groupSettings, selectGroupKeys } from "@/lib/settings/groups";

import { SettingsGroupForm } from "./settings-group-form";
import { StoredOnlyNotice } from "./stored-only-notice";

/**
 * A few keys of one group, on the page they belong to.
 *
 * The area a switch belongs to is where an operator is already standing when
 * they want it, and sending them to a separate Settings page to find it is the
 * reason those switches went unseen in the environment for so long. It is the
 * same form the Settings page mounts, with the same PATCH and the same
 * refusals, so nothing behaves differently here, including the standing caveat
 * that saving stores a value rather than changing what the worker reads.
 * Renders nothing at all when the worker did not answer the settings read.
 */
export function SettingsAreaPanel({
  settings,
  group,
  keys,
  heading,
  description,
  canEdit,
}: {
  settings: readonly SettingsEntryView[];
  group: SettingsGroup;
  keys: readonly string[];
  heading: string;
  description: string;
  canEdit: boolean;
}) {
  const found = groupSettings(settings).find((entry) => entry.id === group);
  if (!found || selectGroupKeys(found, keys).length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <StoredOnlyNotice />
      <SettingsGroupForm
        group={found}
        keys={keys}
        heading={heading}
        description={description}
        canEdit={canEdit}
      />
    </div>
  );
}
