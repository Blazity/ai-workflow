"use client";

import React from "react";
import { BlazityLogo } from "@/components/ui";
import { NavItem } from "@/components/ui/nav-item";
import { ArticleIcon } from "@phosphor-icons/react/dist/csr/Article";
import { BrainIcon } from "@phosphor-icons/react/dist/csr/Brain";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CommandIcon } from "@phosphor-icons/react/dist/csr/Command";
import { CurrencyDollarIcon } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { GitForkIcon } from "@phosphor-icons/react/dist/csr/GitFork";
import { HeartbeatIcon } from "@phosphor-icons/react/dist/csr/Heartbeat";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { ScalesIcon } from "@phosphor-icons/react/dist/csr/Scales";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";

const NAV = [
  { id: "overview", label: "Overview", icon: SquaresFourIcon, group: "obs" },
  { id: "runs", label: "Workflow runs", icon: ListBulletsIcon, group: "obs" },
  { id: "approvals", label: "Approvals", icon: ScalesIcon, group: "obs" },
  { id: "prompts", label: "Prompts", icon: ArticleIcon, group: "obs" },
  { id: "memory", label: "Memory", icon: BrainIcon, group: "obs" },
  { id: "evals", label: "Arthur evals", icon: CheckCircleIcon, group: "obs" },
  { id: "cost", label: "Cost & usage", icon: CurrencyDollarIcon, group: "obs" },
  { id: "editor", label: "Workflow editor", icon: GitBranchIcon, group: "flow" },
  { id: "profiles", label: "Harness profiles", icon: CommandIcon, group: "flow" },
  { id: "repositories", label: "Repositories", icon: GitForkIcon, group: "flow" },
  { id: "health", label: "System health", icon: HeartbeatIcon, group: "team" },
  { id: "users", label: "Users", icon: UsersIcon, group: "team" },
  // Last, and never role gated: reading what the deployment is configured to do
  // is open to every role, and only the forms on it are owner and admin only.
  { id: "settings", label: "Settings", icon: GearIcon, group: "team" },
];

const NAV_GROUPS = [
  { id: "obs", label: "Observability" },
  { id: "flow", label: "Workflow" },
  { id: "team", label: "Administration" },
];

const MOBILE_MORE_NAV_IDS = [
  "approvals",
  "prompts",
  "memory",
  "evals",
  "cost",
  "profiles",
  "repositories",
  "health",
  "users",
  "settings",
] as const;

export function isMobileMoreNavItem(id: string): boolean {
  return (MOBILE_MORE_NAV_IDS as readonly string[]).includes(id);
}

export function cockpitNavItems({
  canManageUsers,
}: {
  canManageUsers: boolean;
}) {
  return NAV.filter(
    (item) =>
      (item.id !== "users" && item.id !== "health") || canManageUsers,
  );
}

export function CkSidebar({
  active,
  onNav,
  collapsed = false,
  onToggleCollapse,
  canManageUsers,
}: {
  active: string;
  onNav: (id: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  canManageUsers: boolean;
}) {
  const nav = cockpitNavItems({ canManageUsers });

  return (
    <aside
      className={`relative bg-panel border-r border-neutral-200 flex flex-col py-5 transition-[width,flex-basis] duration-[var(--motion-base)] ease-standard ${
        collapsed ? "w-[60px] flex-[0_0_60px]" : "w-[220px] flex-[0_0_220px]"
      }`}
    >
      <button
        type="button"
        onClick={onToggleCollapse}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        className="absolute top-[22px] right-0 translate-x-1/2 z-10 w-5 h-5 flex items-center justify-center rounded-full border border-neutral-200 bg-panel text-neutral-500 hover:bg-app-bg hover:text-neutral-800 cursor-pointer appearance-none transition-colors duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1"
      >
        <span className="font-mono text-[11px] leading-none">{collapsed ? "›" : "‹"}</span>
      </button>

      <div
        className={`pb-[18px] flex items-center gap-2 ${
          collapsed ? "px-0 justify-center" : "px-5"
        }`}
      >
        <BlazityLogo size={22} color="var(--color-burnt-orange)" wordmarkColor="var(--color-coal)" showWord={!collapsed} />
        {!collapsed && (
          <span className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase ml-0.5 mt-1">/ AI Workflow</span>
        )}
      </div>

      {NAV_GROUPS.filter((grp) =>
        nav.some((item) => item.group === grp.id),
      ).map((grp, gi) => (
        <React.Fragment key={grp.id}>
          <nav className={`flex flex-col gap-px px-2 ${gi === 0 ? "mt-2" : "mt-3"}`}>
            {nav.filter((n) => n.group === grp.id).map((n) => {
              const on = active === n.id;
              const NavIcon = n.icon;
              return (
                <NavItem
                  key={n.id}
                  onClick={() => onNav(n.id)}
                  title={collapsed ? n.label : undefined}
                  label={n.label}
                  icon={<NavIcon size={16} />}
                  active={on}
                  collapsed={collapsed}
                  className="w-full"
                />
              );
            })}
          </nav>
        </React.Fragment>
      ))}
    </aside>
  );
}
