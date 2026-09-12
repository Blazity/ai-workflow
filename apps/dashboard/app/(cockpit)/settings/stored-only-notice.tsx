"use client";

import { STORED_ONLY_NOTICE } from "@/lib/settings/format";

/**
 * The standing caveat, shown wherever a settings value is on screen.
 *
 * It is not an error and not dismissible: until the consumers stages rewire the
 * worker's readers, saving here changes the store and nothing else, and the one
 * failure this whole surface could cause is somebody believing otherwise.
 */
export function StoredOnlyNotice() {
  return (
    <div
      role="note"
      className="rounded-[3px] border border-orange-300 bg-orange-100 px-3 py-2 font-body text-[11px] leading-4 text-[#A23E18]"
    >
      {STORED_ONLY_NOTICE}
    </div>
  );
}
