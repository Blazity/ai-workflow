"use client";

import React from "react";
import { BlazityLogo } from "@/components/ui";

const NAV = [
  { id: "overview", label: "Overview", glyph: "◇", group: "obs" },
  { id: "runs", label: "Workflow runs", glyph: "≡", group: "obs" },
  { id: "trace", label: "Run trace", glyph: "⟐", group: "obs" },
  { id: "prompts", label: "Prompts", glyph: "❡", group: "obs" },
  { id: "evals", label: "Arthur evals", glyph: "✓", group: "obs" },
  { id: "cost", label: "Cost & usage", glyph: "$", group: "obs" },
  { id: "presandbox", label: "Pre-sandbox", glyph: "▷", group: "flow" },
  { id: "postpr", label: "Post-PR review", glyph: "◈", group: "flow" },
];

export function CkSidebar({ active, onNav }: { active: string; onNav: (id: string) => void }) {
  return (
    <aside className="w-[220px] flex-[0_0_220px] bg-panel border-r border-neutral-200 flex flex-col py-5">
      <div className="px-5 pb-[18px] flex items-center gap-2">
        <BlazityLogo size={22} color="#FD6027" wordmarkColor="#181B20" />
        <span className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase ml-0.5 mt-1">/ AI Workflow</span>
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
                  className={`appearance-none text-left border-none cursor-pointer flex items-center gap-[10px] px-3 py-[9px] rounded-[3px] font-body text-[13px] transition-all duration-[120ms] ease-[cubic-bezier(.2,0,0,1)] ${
                    on
                      ? "bg-[#ECECFD] text-mariner font-semibold"
                      : "bg-transparent text-neutral-800 font-medium hover:bg-app-bg"
                  }`}
                >
                  <span className={`font-mono text-xs w-[14px] text-center ${on ? "text-mariner" : "text-neutral-500"}`}>{n.glyph}</span>
                  {n.label}
                  {on && <span className="ml-auto w-1 h-4 bg-mariner rounded-full" />}
                </button>
              );
            })}
          </nav>
        </React.Fragment>
      ))}
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
  activityOpen,
  onToggleActivity,
}: {
  persona: string;
  setPersona: (v: string) => void;
  range: string;
  setRange: (v: string) => void;
  env: string;
  setEnv: (v: string) => void;
  activityOpen: boolean;
  onToggleActivity: () => void;
}) {
  return (
    <div className="h-14 flex-[0_0_56px] border-b border-neutral-200 bg-panel flex items-center px-6 gap-4">
      <div className="flex-1 max-w-[380px] relative">
        <input
          placeholder="Search runs, traces, span IDs, tickets…"
          className="w-full h-[34px] bg-app-bg border border-neutral-200 rounded-[3px] pl-8 pr-3 font-body text-[13px] text-neutral-900 outline-none"
        />
        <span className="absolute left-[10px] top-[9px] text-neutral-500 font-mono text-sm">⌕</span>
        <span className="absolute right-[10px] top-[9px] font-mono text-[10px] text-neutral-500 border border-[#D2D6DA] rounded-xs px-[5px] py-px">⌘K</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onToggleActivity}
          title="Activity stream"
          className={`appearance-none border border-neutral-200 w-[34px] h-[34px] rounded-[3px] cursor-pointer inline-flex items-center justify-center font-mono text-sm relative ${
            activityOpen ? "bg-neutral-900 text-white" : "bg-panel text-neutral-900"
          }`}
        >
          ≣
          <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-burnt-orange" />
        </button>
        <div className="w-7 h-7 rounded-full bg-mariner text-white font-mono font-medium text-[11px] flex items-center justify-center">SK</div>
      </div>
    </div>
  );
}
