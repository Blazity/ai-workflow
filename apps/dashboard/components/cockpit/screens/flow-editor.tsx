"use client";

// components/cockpit/screens/flow-editor.tsx — n8n-style flow editor shared by
// the pre-sandbox and post-PR-review screens. Canvas + node palette + config
// panel. Ported from variations/cockpit-flow.jsx (visual source of truth).
// Flow/status DATA + TYPES live in @/lib/flows; UI-only constants stay local.

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { CkChip } from "@/components/ui";
import { ckBorder, ckMono, ckDisp, ckBody } from "@/lib/theme";
import type { Flow, FlowNodeDef, RunStatusMap, NodeType } from "@/lib/flows";

/* ────────────────────────────────────────────────────────────────────────
   Node category styling — drives header color, icon, palette grouping.
   ──────────────────────────────────────────────────────────────────────── */

const NODE_CATEGORIES: Record<NodeType, { color: string; soft: string; label: string; glyph: string }> = {
  trigger:   { color: "#181B20", soft: "#F2F4F6", label: "Trigger",    glyph: "▶" },
  fetch:     { color: "#3C43E7", soft: "#ECECFD", label: "Fetch",      glyph: "↓" },
  llm:       { color: "#3C43E7", soft: "#ECECFD", label: "LLM",        glyph: "✦" },
  guard:     { color: "#FFC800", soft: "#FFF4CC", label: "Guardrail",  glyph: "△" },
  tool:      { color: "#FD6027", soft: "#FFEFE9", label: "Tool",       glyph: "⚙" },
  branch:    { color: "#5BB04A", soft: "#EAF7E0", label: "Branch",     glyph: "⌥" },
  human:     { color: "#FD6027", soft: "#FFEFE9", label: "Human",      glyph: "@" },
  check:     { color: "#3C43E7", soft: "#ECECFD", label: "GitHub check", glyph: "✓" },
  notify:    { color: "#181B20", soft: "#F2F4F6", label: "Notify",     glyph: "✉" },
  output:    { color: "#181B20", soft: "#181B20", label: "Output",     glyph: "■" },
};

/* ────────────────────────────────────────────────────────────────────────
   Node sizing + helpers
   ──────────────────────────────────────────────────────────────────────── */

const NODE_W = 168;
const NODE_H = 68;

interface Point { x: number; y: number; }

function portPos(node: FlowNodeDef, kind: "in" | "out", idx = 0): Point {
  // kind: "in" | "out". For multi-port outputs, stack vertically.
  const ports = node.ports || 1;
  if (kind === "in") return { x: node.x, y: node.y + NODE_H / 2 };
  if (ports === 1)   return { x: node.x + NODE_W, y: node.y + NODE_H / 2 };
  const gap = (NODE_H - 16) / (ports + 1);
  return { x: node.x + NODE_W, y: node.y + 8 + gap * (idx + 1) };
}

function bezier(p1: Point, p2: Point): string {
  const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.45);
  return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
}

/* ────────────────────────────────────────────────────────────────────────
   Flow node — draggable card.
   ──────────────────────────────────────────────────────────────────────── */

function FlowNode({
  node,
  selected,
  onSelect,
  onDragStart,
  runStatus,
}: {
  node: FlowNodeDef;
  selected: boolean;
  onSelect: (id: string) => void;
  onDragStart: (e: React.MouseEvent, node: FlowNodeDef) => void;
  runStatus?: string;
}) {
  const cat = NODE_CATEGORIES[node.type] || NODE_CATEGORIES.tool;
  const dark = node.type === "output";
  const ports = node.ports || 1;

  // Tiny param summary inline on the card — the 2 most useful keys per category.
  const summaryKey = (
    {
      trigger: "event", fetch: "tool", llm: "prompt", guard: "evaluator",
      tool: "cmd", branch: "condition", human: "channel", check: "check", notify: "tool",
      output: "handoff",
    } as Record<NodeType, string>
  )[node.type];
  const summary = summaryKey ? node.params[summaryKey] : null;

  return (
    <div
      onMouseDown={(e) => onDragStart(e, node)}
      onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
      style={{
        position: "absolute", left: node.x, top: node.y,
        width: NODE_W, height: NODE_H,
        background: dark ? "#181B20" : "#fff",
        border: selected ? "2px solid #3C43E7" : "1px solid " + (dark ? "#181B20" : "#E6E8EB"),
        borderRadius: 4,
        boxShadow: selected ? "0 0 0 4px rgba(60,67,231,0.12), 0 4px 12px rgba(24,27,32,0.08)" : "0 1px 2px rgba(24,27,32,0.05)",
        cursor: "grab", userSelect: "none",
        transition: "box-shadow 120ms, border-color 120ms",
        zIndex: selected ? 3 : 2,
      }}
    >
      {/* Header strip */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 10px",
        background: dark ? "#0E1014" : cat.soft,
        borderBottom: dark ? "1px solid #2A2D33" : "1px solid " + cat.soft,
        borderTopLeftRadius: 3, borderTopRightRadius: 3,
        fontFamily: ckMono, fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase",
        color: dark ? "#fff" : cat.color,
      }}>
        <span style={{
          width: 16, height: 16, borderRadius: 2, background: cat.color, color: "#fff",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, fontWeight: 700,
        }}>{cat.glyph}</span>
        {cat.label}
        <span style={{ marginLeft: "auto", fontFamily: ckMono, fontSize: 9, color: dark ? "#9EA3AA" : "#9EA3AA" }}>{node.id}</span>
        {runStatus && (
          <span title={"last run: " + runStatus} style={{
            width: 6, height: 6, borderRadius: 999,
            background: runStatus === "ok" ? "#5BB04A" : runStatus === "warn" ? "#FFC800" : runStatus === "fail" ? "#D14343" : "#9EA3AA",
          }} />
        )}
      </div>
      {/* Body */}
      <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{
          fontFamily: ckBody, fontSize: 13, fontWeight: 600,
          color: dark ? "#fff" : "#181B20", lineHeight: 1.2,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{node.name}</div>
        {summary && (
          <div style={{
            fontFamily: ckMono, fontSize: 10, color: dark ? "#9EA3AA" : "#5F666F",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{String(summary)}</div>
        )}
      </div>

      {/* Input port — left edge */}
      {node.type !== "trigger" && (
        <span style={{
          position: "absolute", left: -7, top: NODE_H / 2 - 7,
          width: 12, height: 12, borderRadius: 999,
          background: "#fff", border: "2px solid " + (dark ? "#fff" : cat.color),
        }} />
      )}
      {/* Output ports — right edge */}
      {node.type !== "output" && Array.from({ length: ports }, (_, i) => {
        const pos = portPos(node, "out", i);
        const lbl = node.portLabels && node.portLabels[i];
        return (
          <React.Fragment key={i}>
            <span style={{
              position: "absolute",
              left: NODE_W - 5, top: (pos.y - node.y) - 7,
              width: 12, height: 12, borderRadius: 999,
              background: cat.color, border: "2px solid #fff",
            }} />
            {lbl && ports > 1 && (
              <span style={{
                position: "absolute",
                left: NODE_W + 10, top: (pos.y - node.y) - 8,
                fontFamily: ckMono, fontSize: 9, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase",
                color: cat.color, whiteSpace: "nowrap",
              }}>{lbl}</span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Node palette (left rail) — categories you can add to the flow.
   ──────────────────────────────────────────────────────────────────────── */

const PALETTE_GROUPS: { label: string; items: { type: NodeType; name: string }[] }[] = [
  { label: "Triggers", items: [
    { type: "trigger", name: "Linear · issue assigned" },
    { type: "trigger", name: "GitHub · PR opened" },
    { type: "trigger", name: "Slack · slash command" },
    { type: "trigger", name: "Cron · schedule" },
  ]},
  { label: "Data", items: [
    { type: "fetch", name: "Fetch · Linear issue" },
    { type: "fetch", name: "Fetch · GitHub PR" },
    { type: "fetch", name: "Fetch · repo tree" },
    { type: "fetch", name: "Search · code" },
  ]},
  { label: "LLM", items: [
    { type: "llm", name: "LLM · single completion" },
    { type: "llm", name: "LLM · structured output" },
    { type: "llm", name: "LLM · multi-turn agent" },
  ]},
  { label: "Tools (sandbox)", items: [
    { type: "tool", name: "Run · shell command" },
    { type: "tool", name: "Run · pnpm test" },
    { type: "tool", name: "Run · lint" },
    { type: "tool", name: "Run · typecheck" },
  ]},
  { label: "Arthur evals", items: [
    { type: "guard", name: "Guard · prompt injection" },
    { type: "guard", name: "Guard · scope check" },
    { type: "guard", name: "Guard · cost ceiling" },
    { type: "guard", name: "Aggregator · weighted" },
  ]},
  { label: "Logic", items: [
    { type: "branch", name: "Branch · if/else" },
    { type: "branch", name: "Branch · 3-way switch" },
    { type: "human", name: "Human · ask for input" },
  ]},
  { label: "GitHub / Notify", items: [
    { type: "check", name: "GitHub · post check" },
    { type: "notify", name: "GitHub · PR comment" },
    { type: "notify", name: "Linear · update ticket" },
    { type: "notify", name: "Slack · post message" },
  ]},
];

function NodePalette() {
  const [open, setOpen] = useState(new Set(["Triggers", "Data", "LLM"]));
  const toggle = (k: string) => {
    const n = new Set(open);
    if (n.has(k)) n.delete(k); else n.add(k);
    setOpen(n);
  };
  const [query, setQuery] = useState("");

  return (
    <aside style={{
      width: 240, flex: "0 0 240px",
      background: "#fff", borderRight: ckBorder,
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      <div style={{ padding: "14px 14px 10px", borderBottom: ckBorder, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontFamily: ckMono, fontSize: 9, color: "#9EA3AA", letterSpacing: "0.06em", textTransform: "uppercase" }}>Node palette</div>
        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search nodes…"
          style={{
            height: 28, padding: "0 10px",
            background: "#F2F4F6", border: ckBorder, borderRadius: 3,
            fontFamily: ckBody, fontSize: 12, color: "#181B20", outline: "none",
          }}
        />
        <div style={{ fontFamily: ckMono, fontSize: 9, color: "#9EA3AA", letterSpacing: "0.04em" }}>Drag → canvas, or click +</div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {PALETTE_GROUPS.map((g) => {
          const items = query
            ? g.items.filter(i => i.name.toLowerCase().includes(query.toLowerCase()))
            : g.items;
          if (query && items.length === 0) return null;
          const isOpen = query ? true : open.has(g.label);
          return (
            <div key={g.label}>
              <button onClick={() => toggle(g.label)} style={{
                appearance: "none", border: "none", background: "transparent",
                cursor: "pointer", width: "100%", textAlign: "left",
                padding: "10px 14px 4px",
                fontFamily: ckMono, fontSize: 9, color: "#5F666F", letterSpacing: "0.08em", textTransform: "uppercase",
                display: "flex", alignItems: "center", gap: 6,
              }}>
                <span style={{ color: "#9EA3AA", width: 8 }}>{isOpen ? "▾" : "▸"}</span>
                {g.label}
                <span style={{ marginLeft: "auto", color: "#9EA3AA" }}>{items.length}</span>
              </button>
              {isOpen && (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {items.map((it, i) => {
                    const cat = NODE_CATEGORIES[it.type] || NODE_CATEGORIES.tool;
                    return (
                      <div key={i} draggable style={{
                        margin: "1px 8px", padding: "6px 8px",
                        border: ckBorder, borderRadius: 3,
                        display: "flex", alignItems: "center", gap: 8,
                        cursor: "grab", background: "#fff",
                        transition: "background 120ms",
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = cat.soft}
                      onMouseLeave={(e) => e.currentTarget.style.background = "#fff"}>
                        <span style={{
                          width: 18, height: 18, borderRadius: 2, background: cat.color, color: "#fff",
                          display: "inline-flex", alignItems: "center", justifyContent: "center",
                          fontFamily: ckMono, fontSize: 11, fontWeight: 700, flex: "0 0 18px",
                        }}>{cat.glyph}</span>
                        <span style={{ fontFamily: ckBody, fontSize: 12, color: "#181B20", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                        <span style={{ marginLeft: "auto", fontFamily: ckMono, fontSize: 10, color: "#9EA3AA" }}>+</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ padding: "12px 14px", borderTop: ckBorder, fontFamily: ckMono, fontSize: 10, color: "#5F666F" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: "#5BB04A" }} /> 38 community nodes
        </div>
        <a style={{ color: "#3C43E7", textDecoration: "none", cursor: "pointer" }}>Browse marketplace →</a>
      </div>
    </aside>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Config panel (right rail) — form for the selected node.
   ──────────────────────────────────────────────────────────────────────── */

const FIELD_LABELS: Record<string, string> = {
  source: "Source", event: "Event", filter: "Filter (DSL)", debounce: "Debounce",
  tool: "Tool", include: "Include", timeout: "Timeout", retries: "Retries",
  branch: "Branch", depth: "Clone depth", query: "Query", limit: "Limit",
  evaluator: "Evaluator", maxFiles: "Max files", maxLOC: "Max LOC changed", blocklistGlobs: "Blocklist globs",
  prompt: "Prompt version", model: "Model", temperature: "Temperature", maxTokens: "Max tokens",
  tools: "Tools available", condition: "Condition (JS)", branchA: "Output A", branchB: "Output B",
  channel: "Channel", template: "Template", fallback: "Fallback", autoSuggest: "Auto-suggested answers",
  returns: "Returns", maxCost: "Max cost ($)", ceiling: "Ceiling ($)", action: "On exceed", notify: "Notify",
  handoff: "Handoff", payload: "Payload",
  check: "Check name", state: "State", description: "Description", requiredForMerge: "Required for merge", blockMerge: "Block merge",
  refresh: "Refresh on", scan: "Scanners", severity: "Severity floor", reviewStyle: "Review style", maxComments: "Max comments",
  inputs: "Inputs", threshold: "Pass threshold", runner: "Runner", cmd: "Command", coverage: "Coverage",
  inline: "Inline comments", maxDiffKb: "Max diff (KB)", mention: "Mention", transition: "Linear transition",
};

type FieldValue = string | number | boolean | string[];

function FieldRow({ k, value, onChange }: { k: string; value: FieldValue; onChange: (k: string, v: FieldValue) => void }) {
  const label = FIELD_LABELS[k] || k;
  const isBool = typeof value === "boolean";
  const isArr = Array.isArray(value);
  const isNum = typeof value === "number";
  const display = isArr ? value.join(", ") : isBool ? value : value;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "10px 14px", borderBottom: ckBorder }}>
      <label style={{ fontFamily: ckMono, fontSize: 9, color: "#5F666F", letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</label>
      {isBool ? (
        <button onClick={() => onChange(k, !value)} style={{
          appearance: "none", cursor: "pointer", alignSelf: "flex-start",
          padding: "4px 10px", borderRadius: 999,
          border: "1px solid " + (value ? "#3C43E7" : "#E6E8EB"),
          background: value ? "#3C43E7" : "#fff",
          color: value ? "#fff" : "#5F666F",
          fontFamily: ckMono, fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase",
        }}>{value ? "on" : "off"}</button>
      ) : (
        <input
          value={String(display)}
          onChange={(e) => {
            const v: FieldValue = isNum ? Number(e.target.value) : isArr ? e.target.value.split(",").map(s => s.trim()).filter(Boolean) : e.target.value;
            onChange(k, v);
          }}
          style={{
            height: 26, padding: "0 8px",
            background: "#F9FAFB", border: ckBorder, borderRadius: 2,
            fontFamily: ckMono, fontSize: 12, color: "#181B20", outline: "none",
          }}
        />
      )}
    </div>
  );
}

function NodeConfig({
  node,
  onChange,
  onDelete,
}: {
  node: FlowNodeDef | null;
  onChange: (path: string, value: FieldValue) => void;
  onDelete: () => void;
}) {
  if (!node) {
    return (
      <aside style={{
        width: 320, flex: "0 0 320px",
        background: "#fff", borderLeft: ckBorder,
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ padding: "16px 18px", borderBottom: ckBorder }}>
          <div style={{ fontFamily: ckMono, fontSize: 9, color: "#9EA3AA", letterSpacing: "0.06em", textTransform: "uppercase" }}>Inspector</div>
          <h3 style={{ font: '500 15px/1.3 ' + ckDisp, margin: "4px 0 0", color: "#181B20" }}>Nothing selected</h3>
        </div>
        <div style={{ padding: "16px 18px", flex: 1, display: "flex", flexDirection: "column", gap: 12, color: "#5F666F", fontFamily: ckBody, fontSize: 13 }}>
          <p style={{ margin: 0, lineHeight: 1.55 }}>Click a node on the canvas to edit its parameters, or drag from the palette to add a new step.</p>
          <div style={{ marginTop: 8, fontFamily: ckMono, fontSize: 10, color: "#9EA3AA", letterSpacing: "0.06em", textTransform: "uppercase" }}>Shortcuts</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 6, columnGap: 12, fontFamily: ckMono, fontSize: 11 }}>
            <kbd style={kbdStyle}>↑↓←→</kbd><span>Nudge selected node</span>
            <kbd style={kbdStyle}>⌫</kbd><span>Delete node</span>
            <kbd style={kbdStyle}>⌘D</kbd><span>Duplicate</span>
            <kbd style={kbdStyle}>⌘E</kbd><span>Open prompt editor</span>
            <kbd style={kbdStyle}>F</kbd><span>Fit flow to viewport</span>
            <kbd style={kbdStyle}>R</kbd><span>Replay last run</span>
          </div>
        </div>
      </aside>
    );
  }
  const cat = NODE_CATEGORIES[node.type] || NODE_CATEGORIES.tool;
  return (
    <aside style={{
      width: 320, flex: "0 0 320px",
      background: "#fff", borderLeft: ckBorder,
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      <div style={{ padding: "14px 18px", borderBottom: ckBorder, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            width: 22, height: 22, borderRadius: 3, background: cat.color, color: "#fff",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontFamily: ckMono, fontSize: 13, fontWeight: 700,
          }}>{cat.glyph}</span>
          <span style={{ fontFamily: ckMono, fontSize: 9, color: cat.color, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 600 }}>{cat.label}</span>
          <span style={{ marginLeft: "auto", fontFamily: ckMono, fontSize: 10, color: "#9EA3AA" }}>{node.id}</span>
        </div>
        <input
          value={node.name}
          onChange={(e) => onChange("name", e.target.value)}
          style={{
            border: "none", outline: "none", padding: 0, background: "transparent",
            font: '500 17px/1.3 ' + ckDisp, color: "#181B20",
          }}
        />
      </div>

      <div style={{ flex: 1, overflow: "auto" }}>
        <div style={{ padding: "10px 14px", borderBottom: ckBorder, fontFamily: ckMono, fontSize: 9, color: "#5F666F", letterSpacing: "0.06em", textTransform: "uppercase" }}>Parameters</div>
        {Object.entries(node.params).map(([k, v]) => (
          <FieldRow key={k} k={k} value={v} onChange={(kk, vv) => onChange("params." + kk, vv)} />
        ))}
        <div style={{ padding: "10px 14px", borderBottom: ckBorder, borderTop: ckBorder, fontFamily: ckMono, fontSize: 9, color: "#5F666F", letterSpacing: "0.06em", textTransform: "uppercase" }}>Execution</div>
        <FieldRow k="retries" value={node.params.retries ?? 1} onChange={() => {}} />
        <FieldRow k="timeout" value={node.params.timeout ?? "30s"} onChange={() => {}} />
        <div style={{ padding: "10px 14px", borderBottom: ckBorder, fontFamily: ckMono, fontSize: 9, color: "#5F666F", letterSpacing: "0.06em", textTransform: "uppercase" }}>Observability</div>
        <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: ckBody, fontSize: 12, color: "#3E444C" }}>
            <span>Emit OpenInference span</span>
            <span style={{ ...togglePill, background: "#3C43E7", color: "#fff" }}>on</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: ckBody, fontSize: 12, color: "#3E444C" }}>
            <span>Forward to Arthur</span>
            <span style={{ ...togglePill, background: "#3C43E7", color: "#fff" }}>on</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: ckBody, fontSize: 12, color: "#3E444C" }}>
            <span>Cost tracking</span>
            <span style={{ ...togglePill, background: "#3C43E7", color: "#fff" }}>on</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: ckBody, fontSize: 12, color: "#3E444C" }}>
            <span>Pause on error</span>
            <span style={{ ...togglePill, background: "#fff", color: "#5F666F", border: ckBorder }}>off</span>
          </div>
        </div>
      </div>

      <div style={{ borderTop: ckBorder, padding: "12px 14px", display: "flex", gap: 8 }}>
        <button onClick={onDelete} style={{
          appearance: "none", cursor: "pointer", border: ckBorder, background: "#fff",
          padding: "6px 12px", borderRadius: 3,
          fontFamily: ckMono, fontSize: 11, color: "#A2351C", letterSpacing: "0.04em", textTransform: "uppercase",
        }}>Delete</button>
        <button style={{
          appearance: "none", cursor: "pointer", border: ckBorder, background: "#fff",
          padding: "6px 12px", borderRadius: 3,
          fontFamily: ckMono, fontSize: 11, color: "#181B20", letterSpacing: "0.04em", textTransform: "uppercase",
        }}>Duplicate</button>
        <button style={{
          marginLeft: "auto",
          appearance: "none", cursor: "pointer", border: "1px solid #181B20", background: "#181B20", color: "#fff",
          padding: "6px 12px", borderRadius: 3,
          fontFamily: ckMono, fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase",
        }}>Test step ▷</button>
      </div>
    </aside>
  );
}

const kbdStyle: React.CSSProperties = {
  fontFamily: '"JetBrains Mono", monospace', fontSize: 10,
  padding: "1px 6px", border: "1px solid #E6E8EB", borderRadius: 2,
  background: "#F9FAFB", color: "#3E444C", textAlign: "center",
};
const togglePill: React.CSSProperties = {
  padding: "2px 8px", borderRadius: 999,
  fontFamily: '"JetBrains Mono", monospace', fontSize: 10, fontWeight: 600,
  letterSpacing: "0.04em", textTransform: "uppercase",
};

/* ────────────────────────────────────────────────────────────────────────
   The flow canvas itself.
   ──────────────────────────────────────────────────────────────────────── */

interface DragState {
  kind: "node" | "pan";
  id?: string;
  ox: number;
  oy: number;
  startX: number;
  startY: number;
}

function FlowCanvas({
  flow,
  runStatuses,
  selectedId,
  setSelectedId,
}: {
  flow: Flow;
  runStatuses?: RunStatusMap;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}) {
  const [nodes, setNodes] = useState<FlowNodeDef[]>(flow.nodes);
  const [pan, setPan] = useState({ x: 0, y: -40 });
  const [zoom, setZoom] = useState(0.85);
  const [drag, setDrag] = useState<DragState | null>(null);  // { kind: "node"|"pan", id, ox, oy }
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-fit on flow change: compute bbox of all nodes and zoom/pan to fit.
  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || !flow.nodes.length) return;
    const minX = Math.min(...flow.nodes.map(n => n.x));
    const minY = Math.min(...flow.nodes.map(n => n.y));
    const maxX = Math.max(...flow.nodes.map(n => n.x + NODE_W));
    const maxY = Math.max(...flow.nodes.map(n => n.y + NODE_H));
    const bw = maxX - minX, bh = maxY - minY;
    const cw = el.clientWidth - 40, ch = el.clientHeight - 80;
    const z = Math.max(0.45, Math.min(1.0, Math.min(cw / bw, ch / bh)));
    setZoom(z);
    setPan({ x: 20 - minX * z, y: 40 - minY * z });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.id]);

  // Reset when switching flows
  useEffect(() => { setNodes(flow.nodes); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [flow.id]);
  useEffect(() => { const t = setTimeout(fit, 50); return () => clearTimeout(t); }, [fit]);

  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    if (drag.kind === "node") {
      const dx = (e.clientX - drag.startX) / zoom;
      const dy = (e.clientY - drag.startY) / zoom;
      setNodes((prev) => prev.map(n => n.id === drag.id ? { ...n, x: drag.ox + dx, y: drag.oy + dy } : n));
    } else if (drag.kind === "pan") {
      setPan({ x: drag.ox + (e.clientX - drag.startX), y: drag.oy + (e.clientY - drag.startY) });
    }
  };
  const onMouseUp = () => setDrag(null);

  const startNodeDrag = (e: React.MouseEvent, node: FlowNodeDef) => {
    e.stopPropagation();
    setDrag({ kind: "node", id: node.id, ox: node.x, oy: node.y, startX: e.clientX, startY: e.clientY });
  };
  const startPanDrag = (e: React.MouseEvent) => {
    // Node mousedown stops propagation, so this only fires for empty canvas hits.
    // Bottom-corner control overlays also stopPropagation in their handlers.
    setSelectedId(null);
    setDrag({ kind: "pan", ox: pan.x, oy: pan.y, startX: e.clientX, startY: e.clientY });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => Math.max(0.4, Math.min(1.4, z + (e.deltaY > 0 ? -0.06 : 0.06))));
  };

  // For edges
  const nodeById = useMemo(() => Object.fromEntries(nodes.map(n => [n.id, n])), [nodes]);

  return (
    <div
      ref={containerRef}
      onMouseDown={startPanDrag}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onWheel={onWheel}
      className="flow-canvas-bg"
      style={{
        flex: 1, position: "relative", overflow: "hidden",
        background: "#FAFBFC",
        backgroundImage: "radial-gradient(circle, #D2D6DA 1px, transparent 1px)",
        backgroundSize: 20 + "px " + 20 + "px",
        backgroundPosition: pan.x + "px " + pan.y + "px",
        cursor: drag?.kind === "pan" ? "grabbing" : "grab",
      }}
    >
      {/* Inner scaled layer */}
      <div style={{
        position: "absolute", left: pan.x, top: pan.y,
        transform: `scale(${zoom})`, transformOrigin: "0 0",
        width: 2200, height: 1000,
      }}>
        {/* Edges */}
        <svg width="2200" height="1000" style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#9EA3AA" />
            </marker>
            <marker id="arrowBlue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#3C43E7" />
            </marker>
          </defs>
          {flow.edges.map((e, i) => {
            const a = nodeById[e.from], b = nodeById[e.to];
            if (!a || !b) return null;
            const p1 = portPos(a, "out", e.fromPort || 0);
            const p2 = portPos(b, "in", 0);
            const isActive = (selectedId === a.id || selectedId === b.id);
            const stroke = isActive ? "#3C43E7" : "#9EA3AA";
            return (
              <g key={i}>
                <path
                  d={bezier(p1, p2)}
                  stroke={stroke}
                  strokeWidth={isActive ? 2 : 1.5}
                  fill="none"
                  strokeDasharray={e.dashed ? "5 4" : "none"}
                  markerEnd={isActive ? "url(#arrowBlue)" : "url(#arrow)"}
                  style={{ transition: "stroke 120ms" }}
                />
                {e.label && (
                  <g transform={`translate(${(p1.x + p2.x) / 2}, ${(p1.y + p2.y) / 2 - 8})`}>
                    <rect x={-22} y={-9} width={44} height={16} rx={2} fill="#fff" stroke={stroke} strokeWidth={1} />
                    <text x={0} y={3} fontFamily='"JetBrains Mono", monospace' fontSize={9} fontWeight={600}
                          textAnchor="middle" fill={stroke} style={{ letterSpacing: "0.04em", textTransform: "uppercase" }}>
                      {e.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {/* Nodes */}
        {nodes.map(n => (
          <FlowNode
            key={n.id}
            node={n}
            selected={selectedId === n.id}
            onSelect={setSelectedId}
            onDragStart={startNodeDrag}
            runStatus={runStatuses?.[n.id]}
          />
        ))}
      </div>

      {/* Canvas overlays: zoom controls, mini status */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
        position: "absolute", right: 16, bottom: 16, zIndex: 10,
        display: "flex", flexDirection: "column", gap: 4,
        background: "#fff", border: ckBorder, borderRadius: 3, padding: 4,
        boxShadow: "0 2px 6px rgba(24,27,32,0.08)",
      }}>
        {[
          { label: "+", onClick: () => setZoom(z => Math.min(1.4, z + 0.1)) },
          { label: "−", onClick: () => setZoom(z => Math.max(0.4, z - 0.1)) },
          { label: "⊡", onClick: () => fit() },
        ].map((b, i) => (
          <button key={i} onClick={(e) => { e.stopPropagation(); b.onClick(); }} style={{
            appearance: "none", border: "none", background: "transparent", cursor: "pointer",
            width: 26, height: 26, borderRadius: 2,
            fontFamily: ckMono, fontSize: 14, color: "#181B20",
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = "#F2F4F6"}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>{b.label}</button>
        ))}
        <div style={{ fontFamily: ckMono, fontSize: 9, color: "#9EA3AA", textAlign: "center", padding: "2px 0", borderTop: ckBorder }}>
          {Math.round(zoom * 100)}%
        </div>
      </div>

      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
        position: "absolute", left: 16, bottom: 16, zIndex: 10,
        background: "#fff", border: ckBorder, borderRadius: 3,
        padding: "8px 12px", display: "flex", alignItems: "center", gap: 12,
        fontFamily: ckMono, fontSize: 11, color: "#3E444C",
        boxShadow: "0 2px 6px rgba(24,27,32,0.08)",
      }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#5F666F" }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: "#5BB04A" }} />
          {nodes.length} nodes · {flow.edges.length} edges
        </span>
        <span style={{ color: "#D2D6DA" }}>|</span>
        <span>Valid · last lint clean</span>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Last-run rail: shows latest invocation of this flow with per-node status.
   ──────────────────────────────────────────────────────────────────────── */

function LastRunHeader({ flow, runStatuses }: { flow: Flow; runStatuses: RunStatusMap }) {
  const total = Object.keys(runStatuses).length;
  const ok    = Object.values(runStatuses).filter(s => s === "ok").length;
  const warn  = Object.values(runStatuses).filter(s => s === "warn").length;
  const fail  = Object.values(runStatuses).filter(s => s === "fail").length;
  const pend  = Object.values(runStatuses).filter(s => s === "pending").length;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 16,
      padding: "10px 16px",
      background: "#181B20", color: "#fff",
      borderBottom: "1px solid #2A2D33",
    }}>
      <span style={{ fontFamily: ckMono, fontSize: 9, color: "#9EA3AA", letterSpacing: "0.06em", textTransform: "uppercase" }}>Last run · 4m ago</span>
      <span style={{ fontFamily: ckMono, fontSize: 11, color: "#fff" }}>{flow.id === "presandbox" ? "LIN-4527 · gift wrapping refactor" : "PR #2147 · multi-currency checkout"}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 12, marginLeft: 16, fontFamily: ckMono, fontSize: 11 }}>
        <span style={{ color: "#5BB04A" }}>● {ok} ok</span>
        {warn > 0 && <span style={{ color: "#FFC800" }}>● {warn} warn</span>}
        {fail > 0 && <span style={{ color: "#D14343" }}>● {fail} fail</span>}
        {pend > 0 && <span style={{ color: "#9EA3AA" }}>● {pend} pending</span>}
        <span style={{ color: "#5F666F" }}>/ {total}</span>
      </span>
      <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
        <button style={darkBtn}>Open trace ↗</button>
        <button style={darkBtn}>Replay ▷</button>
      </span>
    </div>
  );
}
const darkBtn: React.CSSProperties = {
  appearance: "none", cursor: "pointer",
  border: "1px solid #2A2D33", background: "#0E1014", color: "#fff",
  padding: "5px 10px", borderRadius: 3,
  fontFamily: '"JetBrains Mono", monospace', fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase",
};

/* ────────────────────────────────────────────────────────────────────────
   Flow editor — wraps everything: header bar, palette, canvas, config.
   ──────────────────────────────────────────────────────────────────────── */

export function FlowEditor({
  flow,
  runStatuses,
  title,
  subtitle,
}: {
  flow: Flow;
  runStatuses: RunStatusMap;
  title: string;
  subtitle?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<FlowNodeDef[]>(flow.nodes);
  useEffect(() => { setNodes(flow.nodes); setSelectedId(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [flow.id]);

  const selected = selectedId ? nodes.find(n => n.id === selectedId) ?? null : null;

  const updateSelected = (path: string, value: FieldValue) => {
    setNodes((prev) => prev.map(n => {
      if (n.id !== selectedId) return n;
      if (path === "name") return { ...n, name: value as string };
      if (path.startsWith("params.")) {
        const k = path.slice(7);
        return { ...n, params: { ...n.params, [k]: value } };
      }
      return n;
    }));
  };
  const deleteSelected = () => {
    setNodes(prev => prev.filter(n => n.id !== selectedId));
    setSelectedId(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Editor toolbar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 16,
        padding: "12px 24px",
        background: "#fff", borderBottom: ckBorder,
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontFamily: ckMono, fontSize: 10, color: "#9EA3AA", letterSpacing: "0.06em", textTransform: "uppercase" }}>{subtitle}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h2 style={{ font: '500 20px/1.2 ' + ckDisp, margin: 0, color: "#181B20" }}>{title}</h2>
            <CkChip tone="mariner">v{flow.version}</CkChip>
            <CkChip tone="success">deployed</CkChip>
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: ckMono, fontSize: 11, color: "#5F666F" }}>
            <span style={{ color: "#9EA3AA" }}>workflow ·</span> {flow.workflow}
          </div>
          <span style={{ color: "#D2D6DA" }}>·</span>
          <div style={{ fontFamily: ckMono, fontSize: 11, color: "#5F666F" }}>
            <span style={{ color: "#9EA3AA" }}>last deploy ·</span> {flow.lastDeployed} by {flow.lastDeployedBy}
          </div>
          <div style={{ width: 1, height: 22, background: "#E6E8EB", margin: "0 6px" }} />
          <button style={ghostBtn}>Lint flow</button>
          <button style={ghostBtn}>Run dry ▷</button>
          <button style={ghostBtn}>History</button>
          <button style={darkBtnLight}>Deploy →</button>
        </div>
      </div>

      {/* Description strip */}
      <div style={{
        padding: "10px 24px",
        background: "#F9FAFB", borderBottom: ckBorder,
        display: "flex", alignItems: "center", gap: 12,
        fontFamily: ckBody, fontSize: 13, color: "#3E444C",
      }}>
        <span style={{ fontFamily: ckMono, fontSize: 10, color: "#5F666F", letterSpacing: "0.06em", textTransform: "uppercase" }}>About</span>
        <span style={{ flex: 1, maxWidth: 880 }}>{flow.description}</span>
      </div>

      <LastRunHeader flow={flow} runStatuses={runStatuses} />

      {/* Editor body */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <NodePalette />
        <FlowCanvas
          flow={{ ...flow, nodes }}
          runStatuses={runStatuses}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
        />
        <NodeConfig
          node={selected}
          onChange={updateSelected}
          onDelete={deleteSelected}
        />
      </div>
    </div>
  );
}
const ghostBtn: React.CSSProperties = {
  appearance: "none", cursor: "pointer",
  border: "1px solid #E6E8EB", background: "#fff", color: "#181B20",
  padding: "6px 12px", borderRadius: 3,
  fontFamily: '"JetBrains Mono", monospace', fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase",
};
const darkBtnLight: React.CSSProperties = {
  appearance: "none", cursor: "pointer",
  border: "1px solid #181B20", background: "#181B20", color: "#fff",
  padding: "6px 14px", borderRadius: 3,
  fontFamily: '"JetBrains Mono", monospace', fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase",
};
