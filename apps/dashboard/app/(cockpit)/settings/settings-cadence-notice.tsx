"use client";

import { SETTINGS_CADENCE_NOTICE } from "@/lib/settings/format";

/**
 * The standing caveat, shown wherever a settings value is on screen.
 *
 * It is not an error and not dismissible. It no longer says the worker ignores
 * the store, because it does not: it says when a saved value reaches work that
 * is already running, which is the only part a form cannot show by itself.
 *
 * Neutral, not orange: orange is the colour of something awaiting attention
 * (DESIGN.md), and on System health, which saves nothing, an orange box about
 * saved values read as a warning about the page itself.
 */
export function SettingsCadenceNotice() {
  return (
    <div
      role="note"
      className="rounded-[3px] border border-neutral-200 bg-app-bg px-3 py-2 font-body text-[11px] leading-4 text-neutral-700"
    >
      {SETTINGS_CADENCE_NOTICE}
    </div>
  );
}
