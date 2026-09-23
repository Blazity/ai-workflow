"use client";

import { RouteTabs } from "@/components/ui";
import { useCockpit } from "@/components/cockpit/context";

export interface AreaTab {
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

/**
 * The horizontal tabs of an area: Settings, and every integration's own.
 *
 * One component for both, because they are one idea: a sidebar entry that
 * opens onto several screens.
 *
 * Each tab is a real anchor, like every sidebar entry, so the address bar is
 * right and cmd-click opens a tab. A plain click is handled here instead and
 * goes through the cockpit's own `navigate`: clicking Users while half a token
 * is typed into the Connection form has to ask before it throws the typing
 * away, and a bare link never would.
 */
export function AreaTabs({
  tabs,
  activeId,
  label,
}: {
  tabs: readonly AreaTab[];
  activeId: string;
  /** Names the tab list for a screen reader: "Settings", "Demo". */
  label: string;
}) {
  const { navigate } = useCockpit();
  // One tab is not a choice, and a strip that offers no choice is furniture.
  if (tabs.length < 2) return null;
  return (
    <div className="px-4 lg:px-6 pt-4">
      <RouteTabs
        tabs={tabs.map((tab) => ({ id: tab.id, label: tab.label, href: tab.href }))}
        active={activeId}
        aria-label={`${label} pages`}
        onChange={(id) => {
          const tab = tabs.find((candidate) => candidate.id === id);
          if (tab) navigate(tab.href);
        }}
      />
    </div>
  );
}
