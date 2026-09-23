"use client";

import React from "react";
import { BlazityLogo, NavItem } from "@/components/ui";
import {
  CORE_NAV_GROUPS,
  INTEGRATIONS_GROUP_LABEL,
  browserHandlesClick,
  integrationNavEntries,
  type CockpitIntegration,
  type NavEntry,
} from "@/lib/cockpit/navigation";

/**
 * The cockpit's own navigation.
 *
 * Three core groups, a separator, then Integrations: the line says which side
 * of the product you are reading. Above it is what we build; below it is what
 * this deployment was connected to, and an integration nobody connected is not
 * there at all. The Integrations page itself always is, because "nothing is
 * connected" is an answer somebody has to be able to go and read.
 *
 * Groups collapse, and the whole column scrolls if it ever has to. Both exist
 * for the same reason: the number of entries below the separator is not ours
 * to decide, and a sidebar that pushed Settings off the bottom of a laptop
 * screen the day somebody connected a fifth provider would be our fault, not
 * theirs.
 */

function SidebarEntry({
  entry,
  active,
  collapsed,
  onNav,
}: {
  entry: NavEntry;
  active: boolean;
  collapsed: boolean;
  onNav: (id: string) => void;
}) {
  // A real link, so the address bar, cmd-click and the browser's own back
  // button all behave; the handler is what keeps an in-cockpit move inside the
  // unsaved-work guard the shell owns.
  return (
    <NavItem
      href={entry.href}
      label={entry.label}
      active={active}
      collapsed={collapsed}
      title={collapsed ? entry.label : undefined}
      icon={
        <span
          className={
            entry.glyph.length > 1
              ? "flex h-[18px] w-[18px] items-center justify-center rounded-[3px] border border-current font-mono text-[9px] font-semibold leading-none"
              : "font-mono text-lg leading-none"
          }
        >
          {entry.glyph}
        </span>
      }
      onClick={(event) => {
        if (browserHandlesClick(event)) return;
        event.preventDefault();
        onNav(entry.id);
      }}
    />
  );
}

function GroupHeader({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="mx-2 flex items-center gap-1 rounded-[3px] border-none bg-transparent px-3 py-1 text-left appearance-none cursor-pointer text-neutral-500 hover:bg-app-bg hover:text-neutral-700 transition-colors duration-[var(--motion-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mariner focus-visible:ring-offset-1"
    >
      <span className="font-mono text-[9px] font-medium uppercase tracking-[0.06em]">{label}</span>
      <span aria-hidden="true" className="ml-auto font-mono text-[10px] leading-none">
        {open ? "⌄" : "›"}
      </span>
    </button>
  );
}

function NavSection({
  id,
  label,
  entries,
  active,
  collapsed,
  open,
  onToggle,
  onNav,
}: {
  id: string;
  label: string;
  entries: readonly NavEntry[];
  active: string;
  collapsed: boolean;
  open: boolean;
  onToggle: (id: string) => void;
  onNav: (id: string) => void;
}) {
  // In the rail there is no room for a heading and nothing to read it by, so
  // every group is open there: collapsing a nameless stack of glyphs would
  // hide entries with no way to tell what was hidden.
  const expanded = collapsed || open;
  return (
    <>
      {!collapsed && <GroupHeader label={label} open={open} onToggle={() => onToggle(id)} />}
      {expanded && (
        <nav aria-label={label} className="flex flex-col gap-px px-2 pb-1">
          {entries.map((entry) => (
            <SidebarEntry
              key={entry.id}
              entry={entry}
              active={active === entry.id}
              collapsed={collapsed}
              onNav={onNav}
            />
          ))}
        </nav>
      )}
    </>
  );
}

export function CkSidebar({
  active,
  onNav,
  collapsed = false,
  onToggleCollapse,
  integrations = [],
  collapsedGroups = [],
  onToggleGroup,
}: {
  active: string;
  onNav: (id: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Every integration this build ships; only the usable ones get an entry. */
  integrations?: readonly CockpitIntegration[];
  collapsedGroups?: readonly string[];
  onToggleGroup?: (id: string) => void;
}) {
  const isOpen = (id: string) => !collapsedGroups.includes(id);
  const toggleGroup = (id: string) => onToggleGroup?.(id);
  const integrationEntries = integrationNavEntries(integrations);
  // An integration's own area is below the separator; when it is one nobody
  // connected there is no entry for it, and the section it belongs to is the
  // honest thing to light instead of nothing.
  const activeEntry = active.startsWith("integration:")
    ? integrationEntries.some((entry) => entry.id === active)
      ? active
      : "integrations"
    : active;

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
        <BlazityLogo size={22} color="#FD6027" wordmarkColor="#181B20" showWord={!collapsed} />
        {!collapsed && (
          <span className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase ml-0.5 mt-1">/ AI Workflow</span>
        )}
      </div>

      {/* The one part of the column that scrolls, and it says when it does:
          five integrations plus every group open does not fit an 800 tall
          laptop, and an overlay scrollbar nobody has touched shows nothing. */}
      <div
        data-cockpit-nav-scroll=""
        className="ck-scroll-cue flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      >
        {CORE_NAV_GROUPS.map((group) => (
          <NavSection
            key={group.id}
            id={group.id}
            label={group.label}
            entries={group.entries}
            active={activeEntry}
            collapsed={collapsed}
            open={isOpen(group.id)}
            onToggle={toggleGroup}
            onNav={onNav}
          />
        ))}

        <div
          role="separator"
          className={`my-2 border-t border-neutral-200 ${collapsed ? "mx-3" : "mx-5"}`}
        />

        <NavSection
          id="integrations"
          label={INTEGRATIONS_GROUP_LABEL}
          entries={integrationEntries}
          active={activeEntry}
          collapsed={collapsed}
          open={isOpen("integrations")}
          onToggle={toggleGroup}
          onNav={onNav}
        />
      </div>
    </aside>
  );
}
