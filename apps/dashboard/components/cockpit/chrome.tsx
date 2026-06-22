"use client";

import React from "react";
import { BlazityLogo } from "@/components/ui";

const NAV = [
  { id: "overview", label: "Overview", glyph: "◇", group: "obs" },
  { id: "runs", label: "Workflow runs", glyph: "≡", group: "obs" },
  { id: "prompts", label: "Prompts", glyph: "❡", group: "obs" },
  { id: "evals", label: "Arthur evals", glyph: "✓", group: "obs" },
  { id: "cost", label: "Cost & usage", glyph: "$", group: "obs" },
  { id: "editor", label: "Workflow editor", glyph: "▷", group: "flow" },
];

export function CkSidebar({
  active,
  onNav,
  collapsed = false,
  onToggleCollapse,
  live = false,
  onToggleLive,
}: {
  active: string;
  onNav: (id: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  live?: boolean;
  onToggleLive?: () => void;
}) {
  return (
    <aside
      className={`relative bg-panel border-r border-neutral-200 flex flex-col py-5 transition-[width,flex-basis] duration-[160ms] ease-[cubic-bezier(.2,0,0,1)] ${
        collapsed ? "w-[60px] flex-[0_0_60px]" : "w-[220px] flex-[0_0_220px]"
      }`}
    >
      <button
        onClick={onToggleCollapse}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        className="absolute top-[22px] right-0 translate-x-1/2 z-10 w-5 h-5 flex items-center justify-center rounded-full border border-neutral-200 bg-panel text-neutral-500 hover:bg-app-bg hover:text-neutral-800 cursor-pointer appearance-none transition-colors duration-[120ms]"
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

      {[
        { id: "obs", label: "Observability" },
        { id: "flow", label: "Workflow editor" },
      ].map((grp, gi) => (
        <React.Fragment key={grp.id}>
          <nav className={`flex flex-col gap-px px-2 ${gi === 0 ? "mt-2" : "mt-3"}`}>
            {NAV.filter((n) => n.group === grp.id).map((n) => {
              const on = active === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => onNav(n.id)}
                  title={collapsed ? n.label : undefined}
                  aria-label={n.label}
                  className={`appearance-none text-left border-none cursor-pointer flex items-center gap-[10px] py-[9px] rounded-[3px] font-body text-[13px] transition-all duration-[120ms] ease-[cubic-bezier(.2,0,0,1)] ${
                    collapsed ? "px-0 justify-center" : "px-3"
                  } ${
                    on
                      ? "bg-[#ECECFD] text-mariner font-semibold"
                      : "bg-transparent text-neutral-800 font-medium hover:bg-app-bg"
                  }`}
                >
                  <span className={`font-mono text-lg leading-none ${on ? "text-mariner" : "text-neutral-700"}`}>{n.glyph}</span>
                  {!collapsed && n.label}
                  {!collapsed && on && <span className="ml-auto w-1 h-4 bg-mariner rounded-full" />}
                </button>
              );
            })}
          </nav>
        </React.Fragment>
      ))}

      <div className="mt-auto px-2 pt-3">
        <button
          onClick={onToggleLive}
          title={
            live
              ? "Live updates on — click to pause"
              : "Live updates off — click to enable"
          }
          aria-label="Toggle live updates"
          aria-pressed={live}
          className={`w-full appearance-none border-none cursor-pointer flex items-center gap-[10px] py-[9px] rounded-[3px] font-body text-[13px] transition-all duration-[120ms] ease-[cubic-bezier(.2,0,0,1)] hover:bg-app-bg ${
            collapsed ? "px-0 justify-center" : "px-3"
          } ${live ? "text-emerald-700 font-semibold" : "text-neutral-700 font-medium"}`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              live ? "bg-emerald-500 animate-pulse" : "bg-neutral-400"
            }`}
          />
          {!collapsed && (live ? "Live" : "Live off")}
        </button>
      </div>
    </aside>
  );
}

export function CkTopbar({
  persona,
  setPersona,
  range,
  setRange,
  env,
  setEnv,
}: {
  persona: string;
  setPersona: (v: string) => void;
  range: string;
  setRange: (v: string) => void;
  env: string;
  setEnv: (v: string) => void;
}) {
  return (
    <div className="h-14 flex-[0_0_56px] border-b border-neutral-200 bg-panel flex items-center px-6 gap-4">
    </div>
  );
}
