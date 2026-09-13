// apps/dashboard/components/cockpit/mobile/bottom-tab-bar.tsx
"use client";

import { ArticleIcon } from "@phosphor-icons/react/dist/csr/Article";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { NavItem } from "@/components/ui/nav-item";

const TABS = [
  { id: "overview", label: "Overview", icon: ArticleIcon },
  { id: "runs", label: "Runs", icon: ListBulletsIcon },
  { id: "editor", label: "Editor", icon: GitBranchIcon },
] as const;

export function BottomTabBar({
  active,
  onNav,
  onOpenMore,
  moreActive,
}: {
  active: string;
  onNav: (id: string) => void;
  onOpenMore: () => void;
  moreActive: boolean;
}) {
  return (
    <nav className="flex-[0_0_auto] bg-panel border-t border-neutral-200 flex items-stretch pb-[env(safe-area-inset-bottom)]">
      {TABS.map((tHere) => {
        const on = active === tHere.id;
        const TabIcon = tHere.icon;
        return (
          <NavItem
            key={tHere.id}
            onClick={() => onNav(tHere.id)}
            label={tHere.label}
            icon={<TabIcon size={16} />}
            active={on}
            stacked
            className="flex-1 rounded-none py-2"
          />
        );
      })}
      <NavItem
        onClick={onOpenMore}
        label="More"
        icon={<span className="font-mono text-lg leading-none">⋯</span>}
        active={moreActive}
        stacked
        className="flex-1 rounded-none py-2"
      />
    </nav>
  );
}
