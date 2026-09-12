"use client";

import Link from "next/link";

import type {
  RepositoryCatalogState,
  SettingsEntryView,
  SystemHealthResponse,
} from "@shared/contracts";

import {
  activationDetail,
  activationValue,
} from "@/lib/repository-catalog/activation";
import { displaySettingValue, settingLabel, sourceLabel } from "@/lib/settings/format";
import { groupSettings, type SettingsGroupView } from "@/lib/settings/groups";

import { SettingsGroupForm } from "./settings-group-form";
import { SetupOverview } from "./setup-overview";
import { SettingsCadenceNotice } from "./settings-cadence-notice";

/** Activation is one explicit action with its own dialog, which lives on the
 *  Repositories page. Said here, linked there. */
const REPOSITORIES_NOTE =
  "Not editable here. Activating the catalog decides what the agent may touch at all, so it happens on the Repositories page, where the dialog names every repository that holds an active run claim and is not enabled.";

/**
 * The repositories group, as a summary rather than a form.
 *
 * Rendering it as a form with every control disabled invites the click that
 * does nothing; one line that states the value and says where the action lives
 * does not.
 */
function RepositoriesSummary({
  group,
  catalogState,
}: {
  group: SettingsGroupView;
  catalogState: RepositoryCatalogState | null;
}) {
  return (
    <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 font-display text-[15px] font-medium text-coal">
          {group.label}
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          {group.storedCount} of {group.entries.length} stored
        </span>
      </div>
      {/* Activation first, and from the catalog state row rather than from any
          settings key below it: the key nothing writes used to contradict the
          worker on a deployment whose catalog was activated by the seed. */}
      <p className="m-0 mt-2 font-body text-[12px] text-neutral-800">
        <span className="font-semibold">Activation:</span>{" "}
        {activationValue(catalogState)}{" "}
        <span className="text-neutral-600">{activationDetail(catalogState)}</span>
      </p>
      <ul className="list-none m-0 mt-2 p-0 flex flex-col gap-1">
        {group.entries.map((entry) => (
          <li key={entry.key} className="font-body text-[11px] text-neutral-700">
            {settingLabel(entry.key)}:{" "}
            <span className="font-mono text-neutral-800">
              {displaySettingValue(entry.value)}
            </span>{" "}
            <span className="text-neutral-500">
              ({sourceLabel(entry.source).toLowerCase()})
            </span>
          </li>
        ))}
      </ul>
      <p className="m-0 mt-2 font-body text-[11px] text-neutral-600">
        {REPOSITORIES_NOTE}{" "}
        <Link href="/repositories" className="text-mariner underline">
          Open the Repositories page
        </Link>
        .
      </p>
    </section>
  );
}

/**
 * The variables this deployment has yet to delete.
 *
 * Named, not counted: the operator's next action is to open the hosting
 * dashboard and remove exactly these, and "4 variables" cannot be acted on.
 * Values never appear here; the worker publishes names alone.
 */
function MigratedVariablesNotice({ variables }: { variables: readonly string[] }) {
  return (
    <div
      role="note"
      className="rounded-[3px] border border-orange-300 bg-orange-100 px-3 py-2 font-body text-[12px] leading-4 text-[#A23E18]"
    >
      {variables.length === 1
        ? "1 environment variable is still set on this deployment: "
        : `${variables.length} environment variables are still set on this deployment: `}
      <span className="font-mono text-[11px]">{variables.join(", ")}</span>
      {". Every value is stored; remove them from the deployment before the next cleanup release."}
    </div>
  );
}

export function SettingsScreen({
  settings,
  migratedVariablesSet,
  scan,
  scanReadable,
  catalogState,
  canEdit,
  available,
}: {
  settings: readonly SettingsEntryView[];
  /** The migrated environment variables the worker still sees set, by name. */
  migratedVariablesSet: readonly string[];
  scan: SystemHealthResponse | null;
  /** False for a role whose session may not read the system health scan. */
  scanReadable: boolean;
  /** The repository catalog state row, or null when the worker did not answer
   *  the catalog read. The only thing this page reads activation from. */
  catalogState: RepositoryCatalogState | null;
  /** canEditSettings(role): owners and admins. */
  canEdit: boolean;
  /** False when the worker did not answer the settings read. */
  available: boolean;
}) {
  const groups = groupSettings(settings);

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
      <div className="flex flex-col gap-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">
          Settings
        </div>
        <h2 className="m-0 font-display text-2xl font-medium leading-[1.2] text-neutral-900">
          Deployment settings
        </h2>
        <p className="m-0 font-body text-[13px] text-neutral-600">
          Every product behaviour switch this deployment has. Credentials,
          provider identity and deployment wiring stay in the environment and are
          deliberately absent.
        </p>
      </div>

      {!available && (
        <div className="rounded-[3px] border border-[#F0B8AE] bg-fail-bg px-3 py-2 font-body text-[12px] text-fail-fg">
          {canEdit
            ? "The worker did not answer, so nothing can be shown or changed here. Check the worker on the System health page and reload."
            : "The worker did not answer, so nothing can be shown here. Ask an owner or admin to check the worker, then reload."}
        </div>
      )}

      {available && <SettingsCadenceNotice />}

      {available && migratedVariablesSet.length > 0 && (
        <MigratedVariablesNotice variables={migratedVariablesSet} />
      )}

      {available && catalogState !== null && !catalogState.activated && (
        <div className="rounded-[3px] border border-orange-300 bg-orange-100 px-3 py-2 font-body text-[12px] text-[#A23E18]">
          Repository catalog not activated: the agent sees everything the
          installation sees.{" "}
          <Link href="/repositories" className="underline">
            Activate it on the Repositories page
          </Link>
          .
        </div>
      )}

      {available && !canEdit && (
        <div className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[12px] text-neutral-600">
          Read-only: every setting is shown, and changing one needs the owner or
          admin role.
        </div>
      )}

      {available && (
        <>
          <SetupOverview
            settings={settings}
            scan={scan}
            scanReadable={scanReadable}
            catalogState={catalogState}
          />
          {groups.map((group) =>
            group.id === "repositories" ? (
              <RepositoriesSummary
                key={group.id}
                group={group}
                catalogState={catalogState}
              />
            ) : (
              <SettingsGroupForm
                key={group.id}
                group={group}
                canEdit={canEdit}
              />
            ),
          )}
        </>
      )}
    </div>
  );
}
