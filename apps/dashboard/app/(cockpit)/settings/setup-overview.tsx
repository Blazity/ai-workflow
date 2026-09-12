"use client";

import type {
  RepositoryCatalogState,
  SettingsEntryView,
  SystemHealthResponse,
} from "@shared/contracts";

import { CkChip, type ChipTone } from "@/components/ui";
import {
  buildSetupOverview,
  type SetupOverviewTone,
} from "@/lib/settings/overview";

const TONES: Record<SetupOverviewTone, ChipTone> = {
  ok: "success",
  off: "blocked",
  warn: "warn",
  bad: "failed",
  unknown: "neutral",
};

/**
 * What this deployment is actually set up to do, in one card.
 *
 * The Settings page and the Health page both mount it: on Health it sits above
 * the probes and is recomputed from whatever the last Scan returned, which is
 * why the health scan arrives as a prop rather than being read here.
 */
export function SetupOverview({
  settings,
  scan,
  scanReadable,
  catalogState,
  emptyStoredNote = "No stored rows yet. Every value below comes from this deployment's environment or from the built-in default.",
}: {
  settings: readonly SettingsEntryView[];
  /** The last stored system health scan, or null when none has been run. */
  scan: SystemHealthResponse | null;
  /** False for a role that may not read the scan at all. */
  scanReadable: boolean;
  /** The repository catalog state row, or null when the worker did not answer
   *  the catalog read. Activation is read from it and from nothing else. */
  catalogState: RepositoryCatalogState | null;
  /** What to say when nothing has been stored. The default points at the forms
   *  under it, which only exist on the Settings page. */
  emptyStoredNote?: string;
}) {
  const overview = buildSetupOverview({ settings, scan, scanReadable, catalogState });

  return (
    <section className="rounded-[4px] border border-neutral-200 bg-panel">
      <header className="px-4 pt-3 pb-[10px] border-b border-neutral-200">
        <h3 className="m-0 font-display text-[15px] font-medium text-coal">
          Setup overview
        </h3>
        <p className="m-0 mt-1 font-body text-[11px] text-neutral-600">
          What this deployment is connected to and which behaviour is switched on.
        </p>
      </header>

      <ul className="list-none m-0 px-4 py-2">
        {overview.rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-col gap-[2px] py-2 border-b border-neutral-200 last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-body text-[12px] font-semibold text-neutral-800">
                {row.label}
              </span>
              <CkChip tone={TONES[row.tone]}>{row.value}</CkChip>
            </div>
            <span className="font-body text-[11px] text-neutral-600">{row.detail}</span>
          </li>
        ))}
      </ul>

      <div className="px-4 py-3 border-t border-neutral-200">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500 mb-[6px]">
          Stored rows per group
        </div>
        {overview.hasStoredRows ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {overview.storedRows.map((row) => (
              <span
                key={row.id}
                className="font-body text-[11px] text-neutral-700"
              >
                {row.label}{" "}
                <span
                  className={
                    row.stored > 0
                      ? "font-mono text-neutral-800"
                      : "font-mono text-neutral-500"
                  }
                >
                  {row.stored}/{row.total}
                </span>
              </span>
            ))}
          </div>
        ) : (
          <p className="m-0 font-body text-[11px] text-neutral-600">
            {emptyStoredNote}
          </p>
        )}
      </div>
    </section>
  );
}
