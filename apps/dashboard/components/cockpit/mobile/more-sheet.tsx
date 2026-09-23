// apps/dashboard/components/cockpit/mobile/more-sheet.tsx
"use client";

import { MobileSheet } from "./mobile-sheet";
import { Button } from "@/components/ui/button";
import { LogoutButton } from "@/components/cockpit/logout-button";
import { IntegrationIcon } from "@/components/cockpit/integration-icon";
import {
  CORE_NAV_GROUPS,
  INTEGRATIONS_GROUP_LABEL,
  integrationNavEntries,
  isMobileMoreNavItem,
  type CockpitIntegration,
  type NavEntry,
} from "@/lib/cockpit/navigation";

/**
 * Everything the phone's bottom bar has no room for.
 *
 * Grouped the way the sidebar is grouped, Integrations last and under its own
 * heading, so somebody who learned where a screen lives on a laptop finds it in
 * the same place here.
 */
export function MoreSheet({
  open,
  onClose,
  active,
  onNav,
  integrations = [],
}: {
  open: boolean;
  onClose: () => void;
  active: string;
  onNav: (id: string) => void;
  integrations?: readonly CockpitIntegration[];
}) {
  const sections: Array<{ label: string; entries: readonly NavEntry[] }> = [
    ...CORE_NAV_GROUPS.map((group) => ({
      label: group.label,
      entries: group.entries.filter((entry) => isMobileMoreNavItem(entry.id)),
    })),
    { label: INTEGRATIONS_GROUP_LABEL, entries: integrationNavEntries(integrations) },
  ].filter((section) => section.entries.length > 0);

  return (
    <MobileSheet open={open} onClose={onClose} title="More" heightClass="max-h-[70vh]">
      <div className="flex flex-col py-1">
        {sections.map((section) => (
          <div key={section.label} className="flex flex-col">
            <div className="px-[18px] pb-1 pt-3 font-mono text-[9px] font-medium uppercase tracking-[0.06em] text-neutral-500">
              {section.label}
            </div>
            {section.entries.map((entry) => {
              const on = active === entry.id;
              return (
                <Button
                  key={entry.id}
                  type="button"
                  variant="text"
                  aria-pressed={on}
                  onClick={() => {
                    onNav(entry.id);
                    onClose();
                  }}
                  className={`appearance-none text-left border-none cursor-pointer flex items-center gap-3 px-[18px] py-3.5 font-body text-[15px] [&>span]:gap-3 ${
                    on ? "bg-mariner-100 text-mariner font-semibold" : "bg-transparent text-neutral-900"
                  }`}
                >
                  {entry.integrationId ? (
                    <IntegrationIcon
                      id={entry.integrationId}
                      name={entry.label}
                      size={20}
                      muted={entry.note === "Off"}
                    />
                  ) : (
                    <span
                      className={`${
                        entry.glyph.length > 1
                          ? "flex h-[20px] w-[20px] items-center justify-center rounded-[3px] border border-current font-mono text-[10px] font-semibold"
                          : "font-mono text-lg"
                      } leading-none ${on ? "text-mariner" : "text-neutral-700"}`}
                    >
                      {entry.glyph}
                    </span>
                  )}
                  {entry.label}
                  {entry.note && (
                    <span className="font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-neutral-500">
                      {entry.note}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
        ))}
        {/* The top bar that holds Sign out on a laptop is not shown on a
            phone, so this is where a phone signs out. */}
        <div className="mt-1 border-t border-neutral-200 px-[18px] py-3">
          <LogoutButton />
        </div>
      </div>
    </MobileSheet>
  );
}
