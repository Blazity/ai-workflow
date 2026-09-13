// apps/dashboard/components/cockpit/mobile/bottom-tab-bar.tsx
"use client";

import { ArticleIcon } from "@phosphor-icons/react/dist/csr/Article";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { Button } from "@/components/ui/button";

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
          <Button key={tHere.id} onClick={() => onNav(tHere.id)} aria-label={tHere.label} aria-current={on ? "page" : undefined} variant="ghost" className={`h-auto flex-1 rounded-none py-2 ${on ? "text-mariner" : "text-neutral-600"}`}>
            <span className="flex flex-col items-center gap-0.5">
              <TabIcon size={16} aria-hidden="true" />
              <span className="font-mono text-[9px] tracking-[0.02em]">{tHere.label}</span>
            </span>
          </Button>
        );
      })}
      <Button onClick={onOpenMore} aria-label="More" aria-current={moreActive ? "page" : undefined} variant="ghost" className={`h-auto flex-1 rounded-none py-2 ${moreActive ? "text-mariner" : "text-neutral-600"}`}>
        <span className="flex flex-col items-center gap-0.5">
          <span className="font-mono text-lg leading-none">⋯</span>
          <span className="font-mono text-[9px] tracking-[0.02em]">More</span>
        </span>
      </Button>
    </nav>
  );
}
