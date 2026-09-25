"use client";

import Link from "next/link";

import type {
  RepositoryCatalogState,
  SettingsEntryView,
  SystemHealthResponse,
} from "@shared/contracts";
import { settingDefinition } from "@integrations/registry";

import { displaySettingValue, settingLabel } from "@/lib/settings/format";
import { groupSettings } from "@/lib/settings/groups";

import { SettingsGroupForm } from "./settings-group-form";
import { SetupOverview } from "./setup-overview";
import { SettingsCadenceNotice } from "./settings-cadence-notice";

/**
 * Deployment-owned settings are values to inspect here, never form controls.
 * Their consumers read the environment directly, so storing a dashboard edit
 * would record a decision the running worker ignores.
 */
function DeploymentVariables({
  entries,
}: {
  entries: readonly SettingsEntryView[];
}) {
  if (entries.length === 0) return null;
  return (
    <section className="rounded-[4px] border border-neutral-200 bg-panel px-4 py-3">
      <h3 className="m-0 font-display text-[15px] font-medium text-coal">
        Deployment variables
      </h3>
      <p className="m-0 mt-1 font-body text-[11px] text-neutral-600">
        Set in the deployment environment. Changes need a redeploy; see{" "}
        <code>SETUP.md</code>.
      </p>
      <ul className="list-none m-0 mt-3 p-0 flex flex-col gap-3">
        {entries.map((entry) => (
          <li key={entry.key} className="flex flex-col gap-1">
            <span className="font-body text-[12px] font-semibold text-neutral-800">
              {settingLabel(entry.key)}{" "}
              <span className="font-mono text-[10px] font-normal text-neutral-500">
                {entry.key}
              </span>
            </span>
            <span className="font-body text-[11px] text-neutral-600">
              Value in force:{" "}
              <span className="font-mono text-neutral-800">
                {displaySettingValue(entry.value)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SettingsScreen({
  settings,
  scan,
  scanReadable,
  catalogState,
  canEdit,
  canReset = false,
  available,
}: {
  settings: readonly SettingsEntryView[];
  scan: SystemHealthResponse | null;
  /** False for a role whose session may not read the system health scan. */
  scanReadable: boolean;
  /** The repository catalog state row, or null when the worker did not answer
   *  the catalog read. The only thing this page reads activation from. */
  catalogState: RepositoryCatalogState | null;
  /** canEditSettings(role): owners and admins. */
  canEdit: boolean;
  /** canResetSettings(role): who may remove a stored value. */
  canReset?: boolean;
  /** False when the worker did not answer the settings read. */
  available: boolean;
}) {
  const deploymentVariables = settings.filter(
    (entry) => settingDefinition(entry.key)?.requiresRedeploy === true,
  );
  const editableSettings = settings.filter(
    (entry) => settingDefinition(entry.key)?.requiresRedeploy !== true,
  );
  const groups = groupSettings(editableSettings);

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
          {groups.map((group) => (
            <SettingsGroupForm
              key={group.id}
              group={group}
              canEdit={canEdit}
              canReset={canReset}
            />
          ))}
          <DeploymentVariables entries={deploymentVariables} />
        </>
      )}
    </div>
  );
}
