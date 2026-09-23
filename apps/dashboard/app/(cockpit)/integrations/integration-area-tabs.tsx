"use client";

import { usePathname } from "next/navigation";

import { AreaTabs, type AreaTab } from "@/components/cockpit/area-tabs";
import { CONNECTION_PAGE, integrationHref } from "@/lib/cockpit/navigation";

/**
 * One integration's tabs: the pages it contributes, then Connection.
 *
 * Connection last because it is the setup, not the work. Somebody who opened
 * an integration from the sidebar came to read what it is doing; the tab where
 * a credential is typed is the one they need on the first afternoon and rarely
 * again, and putting it first would make every visit start at the form.
 *
 * The order is the manifest's, so an integration decides what its own area
 * opens on. A manifest that declares no page has Connection alone, and
 * `AreaTabs` draws no strip for a single tab.
 */
export function IntegrationAreaTabs({
  id,
  name,
  pages,
}: {
  id: string;
  name: string;
  pages: readonly { readonly id: string; readonly label: string }[];
}) {
  const pathname = usePathname();
  const tabs: AreaTab[] = [
    ...pages.map((page) => ({
      id: page.id,
      label: page.label,
      href: integrationHref(id, page.id),
    })),
    {
      id: CONNECTION_PAGE.id,
      label: CONNECTION_PAGE.label,
      href: integrationHref(id, CONNECTION_PAGE.id),
    },
  ];

  const segment = pathname.replace(/^\/+/u, "").split("/")[2];
  const activeId = tabs.some((tab) => tab.id === segment) ? segment! : tabs[0]!.id;

  return <AreaTabs tabs={tabs} activeId={activeId} label={name} />;
}
