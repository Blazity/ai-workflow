"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { CkChip } from "@/components/ui";
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
      className={`absolute rounded-sm cursor-grab select-none transition-[box-shadow,border-color] duration-[120ms] ${
        dark ? "bg-coal" : "bg-panel"
      } ${
        selected
          ? "border-2 border-mariner shadow-[0_0_0_4px_rgba(60,67,231,0.12),0_4px_12px_rgba(24,27,32,0.08)] z-[3]"
          : `border ${dark ? "border-coal" : "border-neutral-200"} shadow-[0_1px_2px_rgba(24,27,32,0.05)] z-[2]`
      }`}
      style={{
        left: node.x, top: node.y,
        width: NODE_W, height: NODE_H,
      }}
    >
      {/* Header strip */}
      <div
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-t-[3px] font-mono text-[9px] font-semibold tracking-[0.06em] uppercase ${
          dark ? "bg-[#0E1014] border-b border-[#2A2D33] text-white" : "border-b"
        }`}
        style={dark ? undefined : { background: cat.soft, borderBottomColor: cat.soft, color: cat.color }}
      >
        <span
          className="w-4 h-4 rounded-xs text-white inline-flex items-center justify-center text-[10px] font-bold"
          style={{ background: cat.color }}
        >{cat.glyph}</span>
        {cat.label}
        <span className="ml-auto font-mono text-[9px] text-neutral-500">{node.id}</span>
        {runStatus && (
          <span
            title={"last run: " + runStatus}
            className="w-1.5 h-1.5 rounded-full"
            style={{
              background: runStatus === "ok" ? "#5BB04A" : runStatus === "warn" ? "#FFC800" : runStatus === "fail" ? "#D14343" : "#9EA3AA",
            }}
          />
        )}
      </div>
      {/* Body */}
      <div className="px-2.5 py-2 flex flex-col gap-0.5">
        <div className={`font-body text-[13px] font-semibold leading-[1.2] overflow-hidden text-ellipsis whitespace-nowrap ${dark ? "text-white" : "text-coal"}`}>{node.name}</div>
        {summary && (
          <div className={`font-mono text-[10px] overflow-hidden text-ellipsis whitespace-nowrap ${dark ? "text-neutral-500" : "text-neutral-700"}`}>{String(summary)}</div>
        )}
      </div>

      {/* Input port — left edge */}
      {node.type !== "trigger" && (
        <span
          className="absolute w-3 h-3 rounded-full bg-panel border-2"
          style={{
            left: -7, top: NODE_H / 2 - 7,
            borderColor: dark ? "#fff" : cat.color,
          }}
        />
      )}
      {/* Output ports — right edge */}
      {node.type !== "output" && Array.from({ length: ports }, (_, i) => {
        const pos = portPos(node, "out", i);
        const lbl = node.portLabels && node.portLabels[i];
        return (
          <React.Fragment key={i}>
            <span
              className="absolute w-3 h-3 rounded-full border-2 border-white"
              style={{
                left: NODE_W - 5, top: (pos.y - node.y) - 7,
                background: cat.color,
              }}
            />
            {lbl && ports > 1 && (
              <span
                className="absolute font-mono text-[9px] font-semibold tracking-[0.04em] uppercase whitespace-nowrap"
                style={{
                  left: NODE_W + 10, top: (pos.y - node.y) - 8,
                  color: cat.color,
                }}
              >{lbl}</span>
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
    <aside className="w-60 flex-[0_0_240px] bg-panel border-r border-neutral-200 flex flex-col overflow-hidden">
      <div className="pt-[14px] px-[14px] pb-[10px] border-b border-neutral-200 flex flex-col gap-2">
        <div className="font-mono text-[9px] text-neutral-500 tracking-[0.06em] uppercase">Node palette</div>
        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search nodes…"
          className="h-7 px-2.5 bg-app-bg border border-neutral-200 rounded-[3px] font-body text-xs text-coal outline-none"
        />
        <div className="font-mono text-[9px] text-neutral-500 tracking-[0.04em]">Drag → canvas, or click +</div>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {PALETTE_GROUPS.map((g) => {
          const items = query
            ? g.items.filter(i => i.name.toLowerCase().includes(query.toLowerCase()))
            : g.items;
          if (query && items.length === 0) return null;
          const isOpen = query ? true : open.has(g.label);
          return (
            <div key={g.label}>
              <button
                onClick={() => toggle(g.label)}
                className="appearance-none border-none bg-transparent cursor-pointer w-full text-left pt-2.5 px-[14px] pb-1 font-mono text-[9px] text-neutral-700 tracking-[0.08em] uppercase flex items-center gap-1.5"
              >
                <span className="text-neutral-500 w-2">{isOpen ? "▾" : "▸"}</span>
                {g.label}
                <span className="ml-auto text-neutral-500">{items.length}</span>
              </button>
              {isOpen && (
                <div className="flex flex-col">
                  {items.map((it, i) => {
                    const cat = NODE_CATEGORIES[it.type] || NODE_CATEGORIES.tool;
                    return (
                      <div
                        key={i}
                        draggable
                        className="mx-2 my-px py-1.5 px-2 border border-neutral-200 rounded-[3px] flex items-center gap-2 cursor-grab bg-panel transition-colors duration-[120ms]"
                        onMouseEnter={(e) => e.currentTarget.style.background = cat.soft}
                        onMouseLeave={(e) => e.currentTarget.style.background = "#fff"}
                      >
                        <span
                          className="w-[18px] h-[18px] rounded-xs text-white inline-flex items-center justify-center font-mono text-[11px] font-bold flex-[0_0_18px]"
                          style={{ background: cat.color }}
                        >{cat.glyph}</span>
                        <span className="font-body text-xs text-coal overflow-hidden text-ellipsis whitespace-nowrap">{it.name}</span>
                        <span className="ml-auto font-mono text-[10px] text-neutral-500">+</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="py-3 px-[14px] border-t border-neutral-200 font-mono text-[10px] text-neutral-700">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="w-1.5 h-1.5 rounded-full bg-[#5BB04A]" /> 38 community nodes
        </div>
        <a className="text-mariner no-underline cursor-pointer">Browse marketplace →</a>
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
    <div className="flex flex-col gap-1 py-2.5 px-[14px] border-b border-neutral-200">
      <label className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">{label}</label>
      {isBool ? (
        <button
          onClick={() => onChange(k, !value)}
          className={`appearance-none cursor-pointer self-start py-1 px-2.5 rounded-full border font-mono text-[10px] font-semibold tracking-[0.04em] uppercase ${
            value ? "border-mariner bg-mariner text-white" : "border-neutral-200 bg-panel text-neutral-700"
          }`}
        >{value ? "on" : "off"}</button>
      ) : (
        <input
          value={String(display)}
          onChange={(e) => {
            const v: FieldValue = isNum ? Number(e.target.value) : isArr ? e.target.value.split(",").map(s => s.trim()).filter(Boolean) : e.target.value;
            onChange(k, v);
          }}
          className="h-[26px] px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-xs text-coal outline-none"
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
      <aside className="w-80 flex-[0_0_320px] bg-panel border-l border-neutral-200 flex flex-col overflow-hidden">
        <div className="py-4 px-[18px] border-b border-neutral-200">
          <div className="font-mono text-[9px] text-neutral-500 tracking-[0.06em] uppercase">Inspector</div>
          <h3 className="font-display font-medium text-[15px] leading-[1.3] mt-1 mb-0 text-coal">Nothing selected</h3>
        </div>
        <div className="py-4 px-[18px] flex-1 flex flex-col gap-3 text-neutral-700 font-body text-[13px]">
          <p className="m-0 leading-[1.55]">Click a node on the canvas to edit its parameters, or drag from the palette to add a new step.</p>
          <div className="mt-2 font-mono text-[10px] text-neutral-500 tracking-[0.06em] uppercase">Shortcuts</div>
          <div className="grid grid-cols-[auto_1fr] gap-y-1.5 gap-x-3 font-mono text-[11px]">
            <kbd className={kbdCls}>↑↓←→</kbd><span>Nudge selected node</span>
            <kbd className={kbdCls}>⌫</kbd><span>Delete node</span>
            <kbd className={kbdCls}>⌘D</kbd><span>Duplicate</span>
            <kbd className={kbdCls}>⌘E</kbd><span>Open prompt editor</span>
            <kbd className={kbdCls}>F</kbd><span>Fit flow to viewport</span>
            <kbd className={kbdCls}>R</kbd><span>Replay last run</span>
          </div>
        </div>
      </aside>
    );
  }
  const cat = NODE_CATEGORIES[node.type] || NODE_CATEGORIES.tool;
  return (
    <aside className="w-80 flex-[0_0_320px] bg-panel border-l border-neutral-200 flex flex-col overflow-hidden">
      <div className="pt-[14px] px-[18px] pb-[14px] border-b border-neutral-200 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span
            className="w-[22px] h-[22px] rounded-[3px] text-white inline-flex items-center justify-center font-mono text-[13px] font-bold"
            style={{ background: cat.color }}
          >{cat.glyph}</span>
          <span
            className="font-mono text-[9px] tracking-[0.06em] uppercase font-semibold"
            style={{ color: cat.color }}
          >{cat.label}</span>
          <span className="ml-auto font-mono text-[10px] text-neutral-500">{node.id}</span>
        </div>
        <input
          value={node.name}
          onChange={(e) => onChange("name", e.target.value)}
          className="border-none outline-none p-0 bg-transparent font-display font-medium text-[17px] leading-[1.3] text-coal"
        />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="py-2.5 px-[14px] border-b border-neutral-200 font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">Parameters</div>
        {Object.entries(node.params).map(([k, v]) => (
          <FieldRow key={k} k={k} value={v} onChange={(kk, vv) => onChange("params." + kk, vv)} />
        ))}
        <div className="py-2.5 px-[14px] border-y border-neutral-200 font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">Execution</div>
        <FieldRow k="retries" value={node.params.retries ?? 1} onChange={(_, value) => onChange("params.retries", value)} />
        <FieldRow k="timeout" value={node.params.timeout ?? "30s"} onChange={(_, value) => onChange("params.timeout", value)} />
        <div className="py-2.5 px-[14px] border-b border-neutral-200 font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">Observability</div>
        <div className="py-2.5 px-[14px] flex flex-col gap-2">
          <div className="flex items-center justify-between font-body text-xs text-neutral-800">
            <span>Emit OpenInference span</span>
            <span className={`${togglePillCls} bg-mariner text-white`}>on</span>
          </div>
          <div className="flex items-center justify-between font-body text-xs text-neutral-800">
            <span>Forward to Arthur</span>
            <span className={`${togglePillCls} bg-mariner text-white`}>on</span>
          </div>
          <div className="flex items-center justify-between font-body text-xs text-neutral-800">
            <span>Cost tracking</span>
            <span className={`${togglePillCls} bg-mariner text-white`}>on</span>
          </div>
          <div className="flex items-center justify-between font-body text-xs text-neutral-800">
            <span>Pause on error</span>
            <span className={`${togglePillCls} bg-panel text-neutral-700 border border-neutral-200`}>off</span>
          </div>
        </div>
      </div>

      <div className="border-t border-neutral-200 py-3 px-[14px] flex gap-2">
        <button
          onClick={onDelete}
          className="appearance-none cursor-pointer border border-neutral-200 bg-panel py-1.5 px-3 rounded-[3px] font-mono text-[11px] text-[#A2351C] tracking-[0.04em] uppercase"
        >Delete</button>
        <button className="appearance-none cursor-pointer border border-neutral-200 bg-panel py-1.5 px-3 rounded-[3px] font-mono text-[11px] text-coal tracking-[0.04em] uppercase">Duplicate</button>
        <button className="ml-auto appearance-none cursor-pointer border border-coal bg-coal text-white py-1.5 px-3 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase">Test step ▷</button>
      </div>
    </aside>
  );
}

const kbdCls = "font-mono text-[10px] py-px px-1.5 border border-neutral-200 rounded-xs bg-off-white text-neutral-800 text-center";
const togglePillCls = "py-0.5 px-2 rounded-full font-mono text-[10px] font-semibold tracking-[0.04em] uppercase";

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
  nodes,
  onNodesChange,
  runStatuses,
  selectedId,
  setSelectedId,
}: {
  flow: Flow;
  nodes: FlowNodeDef[];
  onNodesChange: React.Dispatch<React.SetStateAction<FlowNodeDef[]>>;
  runStatuses?: RunStatusMap;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}) {
  const [pan, setPan] = useState({ x: 0, y: -40 });
  const [zoom, setZoom] = useState(0.85);
  const [drag, setDrag] = useState<DragState | null>(null);  // { kind: "node"|"pan", id, ox, oy }
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-fit on flow change: compute bbox of all nodes and zoom/pan to fit.
  const fitNodes = useCallback((nodesToFit: FlowNodeDef[]) => {
    const el = containerRef.current;
    if (!el || !nodesToFit.length) return;
    const minX = Math.min(...nodesToFit.map(n => n.x));
    const minY = Math.min(...nodesToFit.map(n => n.y));
    const maxX = Math.max(...nodesToFit.map(n => n.x + NODE_W));
    const maxY = Math.max(...nodesToFit.map(n => n.y + NODE_H));
    const bw = maxX - minX, bh = maxY - minY;
    const cw = el.clientWidth - 40, ch = el.clientHeight - 80;
    const z = Math.max(0.45, Math.min(1.0, Math.min(cw / bw, ch / bh)));
    setZoom(z);
    setPan({ x: 20 - minX * z, y: 40 - minY * z });
  }, []);
  const fit = useCallback(() => fitNodes(nodes), [fitNodes, nodes]);

  useEffect(() => { const t = setTimeout(() => fitNodes(flow.nodes), 50); return () => clearTimeout(t); }, [fitNodes, flow.id, flow.nodes]);

  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    if (drag.kind === "node") {
      const dx = (e.clientX - drag.startX) / zoom;
      const dy = (e.clientY - drag.startY) / zoom;
      onNodesChange((prev) => prev.map(n => n.id === drag.id ? { ...n, x: drag.ox + dx, y: drag.oy + dy } : n));
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
      className={`flow-canvas-bg flex-1 relative overflow-hidden bg-[#FAFBFC] ${drag?.kind === "pan" ? "cursor-grabbing" : "cursor-grab"}`}
      style={{
        backgroundImage: "radial-gradient(circle, #D2D6DA 1px, transparent 1px)",
        backgroundSize: "20px 20px",
        backgroundPosition: pan.x + "px " + pan.y + "px",
      }}
    >
      {/* Inner scaled layer */}
      <div
        className="absolute origin-top-left w-[2200px] h-[1000px]"
        style={{
          left: pan.x, top: pan.y,
          transform: `scale(${zoom})`,
        }}
      >
        {/* Edges */}
        <svg width="2200" height="1000" className="absolute inset-0 pointer-events-none overflow-visible">
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
                  className="transition-[stroke] duration-[120ms]"
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
        className="absolute right-4 bottom-4 z-10 flex flex-col gap-1 bg-panel border border-neutral-200 rounded-[3px] p-1 shadow-[0_2px_6px_rgba(24,27,32,0.08)]"
      >
        {[
          { label: "+", onClick: () => setZoom(z => Math.min(1.4, z + 0.1)) },
          { label: "−", onClick: () => setZoom(z => Math.max(0.4, z - 0.1)) },
          { label: "⊡", onClick: () => fit() },
        ].map((b, i) => (
          <button
            key={i}
            onClick={(e) => { e.stopPropagation(); b.onClick(); }}
            className="appearance-none border-none bg-transparent cursor-pointer w-[26px] h-[26px] rounded-xs font-mono text-sm text-coal hover:bg-app-bg"
          >{b.label}</button>
        ))}
        <div className="font-mono text-[9px] text-neutral-500 text-center py-0.5 border-t border-neutral-200">
          {Math.round(zoom * 100)}%
        </div>
      </div>

      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute left-4 bottom-4 z-10 bg-panel border border-neutral-200 rounded-[3px] py-2 px-3 flex items-center gap-3 font-mono text-[11px] text-neutral-800 shadow-[0_2px_6px_rgba(24,27,32,0.08)]"
      >
        <span className="inline-flex items-center gap-1.5 text-neutral-700">
          <span className="w-1.5 h-1.5 rounded-full bg-[#5BB04A]" />
          {nodes.length} nodes · {flow.edges.length} edges
        </span>
        <span className="text-[#D2D6DA]">|</span>
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
    <div className="flex items-center gap-4 py-2.5 px-4 bg-coal text-white border-b border-[#2A2D33]">
      <span className="font-mono text-[9px] text-neutral-500 tracking-[0.06em] uppercase">Last run · 4m ago</span>
      <span className="font-mono text-[11px] text-white">{flow.id === "presandbox" ? "LIN-4527 · gift wrapping refactor" : "PR #2147 · multi-currency checkout"}</span>
      <span className="inline-flex items-center gap-3 ml-4 font-mono text-[11px]">
        <span className="text-[#5BB04A]">● {ok} ok</span>
        {warn > 0 && <span className="text-vibe-yellow">● {warn} warn</span>}
        {fail > 0 && <span className="text-[#D14343]">● {fail} fail</span>}
        {pend > 0 && <span className="text-neutral-500">● {pend} pending</span>}
        <span className="text-neutral-700">/ {total}</span>
      </span>
      <span className="ml-auto flex gap-2">
        <button className={darkBtnCls}>Open trace ↗</button>
        <button className={darkBtnCls}>Replay ▷</button>
      </span>
    </div>
  );
}
const darkBtnCls = "appearance-none cursor-pointer border border-[#2A2D33] bg-[#0E1014] text-white py-[5px] px-2.5 rounded-[3px] font-mono text-[10px] tracking-[0.04em] uppercase";

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
    <div className="flex flex-col h-full min-h-0">
      {/* Editor toolbar */}
      <div className="flex items-center gap-4 py-3 px-6 bg-panel border-b border-neutral-200">
        <div className="flex flex-col gap-0.5">
          <div className="font-mono text-[10px] text-neutral-500 tracking-[0.06em] uppercase">{subtitle}</div>
          <div className="flex items-center gap-2.5">
            <h2 className="font-display font-medium text-xl leading-[1.2] m-0 text-coal">{title}</h2>
            <CkChip tone="mariner">v{flow.version}</CkChip>
            <CkChip tone="success">deployed</CkChip>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <div className="font-mono text-[11px] text-neutral-700">
            <span className="text-neutral-500">workflow ·</span> {flow.workflow}
          </div>
          <span className="text-[#D2D6DA]">·</span>
          <div className="font-mono text-[11px] text-neutral-700">
            <span className="text-neutral-500">last deploy ·</span> {flow.lastDeployed} by {flow.lastDeployedBy}
          </div>
          <div className="w-px h-[22px] bg-neutral-200 mx-1.5" />
          <button className={ghostBtnCls}>Lint flow</button>
          <button className={ghostBtnCls}>Run dry ▷</button>
          <button className={ghostBtnCls}>History</button>
          <button className={darkBtnLightCls}>Deploy →</button>
        </div>
      </div>

      {/* Description strip */}
      <div className="py-2.5 px-6 bg-off-white border-b border-neutral-200 flex items-center gap-3 font-body text-[13px] text-neutral-800">
        <span className="font-mono text-[10px] text-neutral-700 tracking-[0.06em] uppercase">About</span>
        <span className="flex-1 max-w-[880px]">{flow.description}</span>
      </div>

      <LastRunHeader flow={flow} runStatuses={runStatuses} />

      {/* Editor body */}
      <div className="flex-1 flex min-h-0">
        <NodePalette />
        <FlowCanvas
          flow={flow}
          nodes={nodes}
          onNodesChange={setNodes}
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
const ghostBtnCls = "appearance-none cursor-pointer border border-neutral-200 bg-panel text-coal py-1.5 px-3 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase";
const darkBtnLightCls = "appearance-none cursor-pointer border border-coal bg-coal text-white py-1.5 px-3.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase";
