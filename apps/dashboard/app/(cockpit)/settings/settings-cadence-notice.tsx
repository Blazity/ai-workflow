"use client";

import { SETTINGS_CADENCE_NOTICE } from "@/lib/settings/format";

/**
 * The standing caveat, shown wherever a settings value is on screen.
 *
 * It is not an error and not dismissible. It no longer says the worker ignores
 * the store, because it does not: it says when a saved value reaches work that
 * is already running, which is the only part a form cannot show by itself.
 */
export function SettingsCadenceNotice() {
  return (
    <div
      role="note"
      className="rounded-[3px] border border-orange-300 bg-orange-100 px-3 py-2 font-body text-[11px] leading-4 text-[#A23E18]"
    >
      {SETTINGS_CADENCE_NOTICE}
    </div>
  );
}
