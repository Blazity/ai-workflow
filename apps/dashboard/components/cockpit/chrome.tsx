"use client";

import React from "react";
import { BlazityLogo } from "@/components/ui";
import { ckBorder, ckMono, ckBody } from "@/lib/theme";

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
    <aside
      style={{
        width: 220,
        flex: "0 0 220px",
        background: "#fff",
        borderRight: ckBorder,
        display: "flex",
        flexDirection: "column",
        padding: "20px 0",
      }}
    >
      <div style={{ padding: "0 20px 18px", display: "flex", alignItems: "center", gap: 8 }}>
        <BlazityLogo size={22} color="#FD6027" wordmarkColor="#181B20" />
        <span style={{ fontFamily: ckMono, fontSize: 9, color: "#5F666F", letterSpacing: "0.06em", textTransform: "uppercase", marginLeft: 2, marginTop: 4 }}>/ AI Workflow</span>
      </div>

      {[
        { id: "obs", label: "Observability" },
        { id: "flow", label: "Workflow editor" },
      ].map((grp, gi) => (
        <React.Fragment key={grp.id}>
          <nav style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px", marginTop: gi === 0 ? 8 : 12 }}>
            {NAV.filter((n) => n.group === grp.id).map((n) => {
              const on = active === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => onNav(n.id)}
                  style={{
                    appearance: "none",
                    textAlign: "left",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 12px",
                    borderRadius: 3,
                    background: on ? "#ECECFD" : "transparent",
                    color: on ? "#3C43E7" : "#3E444C",
                    fontFamily: ckBody,
                    fontSize: 13,
                    fontWeight: on ? 600 : 500,
                    transition: "all 120ms cubic-bezier(.2,0,0,1)",
                  }}
                  onMouseEnter={(e) => {
                    if (!on) e.currentTarget.style.background = "#F2F4F6";
                  }}
                  onMouseLeave={(e) => {
                    if (!on) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span style={{ fontFamily: ckMono, fontSize: 12, width: 14, textAlign: "center", color: on ? "#3C43E7" : "#9EA3AA" }}>{n.glyph}</span>
                  {n.label}
                  {on && <span style={{ marginLeft: "auto", width: 4, height: 16, background: "#3C43E7", borderRadius: 999 }} />}
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
    <div
      style={{
        height: 56,
        flex: "0 0 56px",
        borderBottom: ckBorder,
        background: "#fff",
        display: "flex",
        alignItems: "center",
        padding: "0 24px",
        gap: 16,
      }}
    >
      <div style={{ flex: 1, maxWidth: 380, position: "relative" }}>
        <input
          placeholder="Search runs, traces, span IDs, tickets…"
          style={{
            width: "100%",
            height: 34,
            background: "#F2F4F6",
            border: ckBorder,
            borderRadius: 3,
            padding: "0 12px 0 32px",
            fontFamily: ckBody,
            fontSize: 13,
            color: "#181B20",
            outline: "none",
          }}
        />
        <span style={{ position: "absolute", left: 10, top: 9, color: "#9EA3AA", fontFamily: ckMono, fontSize: 14 }}>⌕</span>
        <span style={{ position: "absolute", right: 10, top: 9, fontFamily: ckMono, fontSize: 10, color: "#9EA3AA", border: "1px solid #D2D6DA", borderRadius: 2, padding: "1px 5px" }}>⌘K</span>
      </div>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={onToggleActivity}
          title="Activity stream"
          style={{
            appearance: "none",
            border: ckBorder,
            background: activityOpen ? "#181B20" : "#fff",
            color: activityOpen ? "#fff" : "#181B20",
            width: 34,
            height: 34,
            borderRadius: 3,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: ckMono,
            fontSize: 14,
            position: "relative",
          }}
        >
          ≣
          <span style={{ position: "absolute", top: 4, right: 4, width: 6, height: 6, borderRadius: 999, background: "#FD6027" }} />
        </button>
        <div style={{ width: 28, height: 28, borderRadius: 999, background: "#3C43E7", color: "#fff", fontFamily: ckMono, fontWeight: 500, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>SK</div>
      </div>
    </div>
  );
}
