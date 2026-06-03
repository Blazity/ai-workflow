"use client";

import React from "react";
import { BlazityLogo } from "@/components/ui";

const NAV = [
  { id: "overview", label: "Overview", glyph: "◇", group: "obs" },
  { id: "runs", label: "Workflow runs", glyph: "≡", group: "obs" },
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
