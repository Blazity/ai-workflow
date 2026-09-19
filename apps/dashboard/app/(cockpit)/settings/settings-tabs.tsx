"use client";

import { usePathname } from "next/navigation";

import { AreaTabs, type AreaTab } from "@/components/cockpit/area-tabs";
import { useCockpit } from "@/components/cockpit/context";

/**
 * The Settings area's tabs.
 *
 * System health and Users used to be sidebar entries of their own. They are
 * things an administrator does to this deployment rather than places the
 * product's work happens, and a flat sidebar of thirteen left no room for the
 * integrations that now sit below the separator. Their old URLs redirect, so
 * nothing anybody bookmarked or wrote in a runbook stops working.
 *
 * The two administrative tabs are hidden from a member for the same reason
 * their sidebar entries were: offering a screen that answers 403 is rude. It is
 * not the rule. The worker refuses the reads behind them, as it did before.
 */
export function SettingsTabs() {
  const pathname = usePathname();
  const { canManageUsers } = useCockpit();

  const tabs: AreaTab[] = [
    { id: "settings", label: "Settings", href: "/settings" },
    ...(canManageUsers
      ? [
          { id: "health", label: "System health", href: "/settings/health" },
          { id: "users", label: "Users", href: "/settings/users" },
        ]
      : []),
  ];

  const segment = pathname.replace(/^\/+/u, "").split("/")[1];
  const activeId = tabs.some((tab) => tab.id === segment) ? segment! : "settings";

  return <AreaTabs tabs={tabs} activeId={activeId} label="Settings" />;
}
