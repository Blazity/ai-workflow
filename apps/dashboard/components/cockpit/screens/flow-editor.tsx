"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { CkChip } from "@/components/ui";
import type { Flow, FlowNodeDef, FlowEdgeDef, FlowParamValue, RunStatusMap, NodeType } from "@/lib/flows";

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
const NODE_H = 84;

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
  onPortDown,
  onPortUp,
  runStatus,
}: {
  node: FlowNodeDef;
  selected: boolean;
  onSelect: (id: string) => void;
  onDragStart: (e: React.MouseEvent, node: FlowNodeDef) => void;
  onPortDown: (e: React.MouseEvent, nodeId: string, portIdx: number) => void;
  onPortUp: (e: React.MouseEvent, nodeId: string) => void;
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
        {node.locked && <span title="Anchor step — can't be removed" className="text-[9px] leading-none" aria-hidden>🔒</span>}
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
          onMouseUp={(e) => onPortUp(e, node.id)}
          title="Drop a connection here"
          className="absolute w-3.5 h-3.5 rounded-full bg-panel border-2 cursor-crosshair hover:scale-125 transition-transform"
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
              onMouseDown={(e) => onPortDown(e, node.id, i)}
              title="Drag to another node to connect"
              className="absolute w-3.5 h-3.5 rounded-full border-2 border-white cursor-crosshair hover:scale-125 transition-transform"
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

interface PaletteItem {
  type: NodeType;
  name: string;
  params: Record<string, FlowParamValue>;
}

const PALETTE_ITEMS: PaletteItem[] = [
  { type: "fetch", name: "Fetch data", params: { tool: "github.repos.get", timeout: "5s" } },
  { type: "llm", name: "LLM step", params: { prompt: "p_new@v1", model: "claude-sonnet-4", temperature: 0.2 } },
  { type: "tool", name: "Run command", params: { runner: "sandbox.exec", cmd: "echo hello", timeout: "60s" } },
  { type: "guard", name: "Guardrail", params: { evaluator: "arthur.scope_check" } },
  { type: "branch", name: "Branch", params: { condition: "result.ok == true" } },
  { type: "notify", name: "Notify", params: { channel: "#ai-workflow", template: "msg_v1" } },
];

function NodePalette({ onAdd }: { onAdd: (item: PaletteItem) => void }) {
  return (
    <aside className="w-52 flex-[0_0_208px] bg-panel border-r border-neutral-200 flex flex-col overflow-hidden">
      <div className="pt-[14px] px-[14px] pb-[10px] border-b border-neutral-200 flex flex-col gap-1">
        <div className="font-mono text-[9px] text-neutral-500 tracking-[0.06em] uppercase">Add step</div>
        <div className="font-mono text-[9px] text-neutral-500 tracking-[0.04em]">Drag onto canvas, or click to add</div>
      </div>
      <div className="flex-1 overflow-auto py-2 flex flex-col">
        {PALETTE_ITEMS.map((it) => {
          const cat = NODE_CATEGORIES[it.type] || NODE_CATEGORIES.tool;
          return (
            <button
              key={it.name}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-flow-node", JSON.stringify(it));
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onAdd(it)}
              className="appearance-none text-left mx-2 my-px py-2 px-2 border border-neutral-200 rounded-[3px] flex items-center gap-2 cursor-grab active:cursor-grabbing bg-panel transition-colors duration-[120ms]"
              onMouseEnter={(e) => (e.currentTarget.style.background = cat.soft)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}
            >
              <span
                className="w-[18px] h-[18px] rounded-xs text-white inline-flex items-center justify-center font-mono text-[11px] font-bold flex-[0_0_18px]"
                style={{ background: cat.color }}
              >{cat.glyph}</span>
              <span className="font-body text-xs text-coal overflow-hidden text-ellipsis whitespace-nowrap">{it.name}</span>
              <span className="ml-auto font-mono text-[12px] text-neutral-500 leading-none">+</span>
            </button>
          );
        })}
      </div>
      <div className="py-2.5 px-[14px] border-t border-neutral-200 font-mono text-[9px] text-neutral-500 tracking-[0.04em] leading-[1.5]">
        Drag a node&apos;s right port onto another node&apos;s left port to connect them.
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

/* Per-step code editor — dark textarea with a line-number gutter. */
function StepCodeEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const lineCount = value.split("\n").length;

  const onScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart, selectionEnd } = ta;
    const next = value.slice(0, selectionStart) + "  " + value.slice(selectionEnd);
    onChange(next);
    requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = selectionStart + 2; });
  };

  return (
    <div className="flex h-[200px] bg-[#0E1014] rounded-[3px] border border-[#2A2D33] overflow-hidden">
      <div
        ref={gutterRef}
        aria-hidden
        className="flex-[0_0_30px] overflow-hidden py-2 text-right select-none bg-[#0B0D10] font-mono text-[11px] leading-[18px] text-neutral-700"
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className="px-1.5">{i + 1}</div>
        ))}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        spellCheck={false}
        className="flex-1 min-w-0 resize-none outline-none py-2 px-2 bg-transparent font-mono text-[11px] leading-[18px] text-[#E6E8EB]"
        style={{ tabSize: 2 }}
      />
    </div>
  );
}

const defaultStepCode = (node: FlowNodeDef) =>
  `export default async (ctx) => {\n  // ${node.name}\n  return ctx;\n};\n`;

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
        <div className="py-2.5 px-[14px] border-y border-neutral-200 font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">Step code · JavaScript</div>
        <div className="p-[14px]">
          <StepCodeEditor
            value={node.code ?? defaultStepCode(node)}
            onChange={(v) => onChange("code", v)}
          />
        </div>
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

      <div className="border-t border-neutral-200 py-3 px-[14px] flex gap-2 items-center">
        {node.locked ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-neutral-700 tracking-[0.04em] uppercase">
            <span aria-hidden>🔒</span> Anchor step · can&apos;t be removed
          </span>
        ) : (
          <>
            <button
              onClick={onDelete}
              className="appearance-none cursor-pointer border border-neutral-200 bg-panel py-1.5 px-3 rounded-[3px] font-mono text-[11px] text-[#A2351C] tracking-[0.04em] uppercase"
            >Delete</button>
            <button className="appearance-none cursor-pointer border border-neutral-200 bg-panel py-1.5 px-3 rounded-[3px] font-mono text-[11px] text-coal tracking-[0.04em] uppercase">Duplicate</button>
          </>
        )}
        <button className="ml-auto appearance-none cursor-pointer border border-coal bg-coal text-white py-1.5 px-3 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase">Test step ▷</button>
      </div>
    </aside>
  );
}

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

interface ConnectState {
  from: string;
  fromPort: number;
  cursor: Point;
}

function FlowCanvas({
  flow,
  nodes,
  edges,
  onNodesChange,
  onAddEdge,
  onRemoveEdge,
  onDropNode,
  runStatuses,
  selectedId,
  setSelectedId,
}: {
  flow: Flow;
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
  onNodesChange: React.Dispatch<React.SetStateAction<FlowNodeDef[]>>;
  onAddEdge: (from: string, to: string, fromPort: number) => void;
  onRemoveEdge: (edge: FlowEdgeDef) => void;
  onDropNode: (item: PaletteItem, at: Point) => void;
  runStatuses?: RunStatusMap;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}) {
  const [pan, setPan] = useState({ x: 0, y: -40 });
  const [zoom, setZoom] = useState(0.85);
  const [drag, setDrag] = useState<DragState | null>(null);  // { kind: "node"|"pan", id, ox, oy }
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Convert a client point into canvas (unscaled) coordinates.
  const toCanvas = useCallback((clientX: number, clientY: number): Point => {
    const el = containerRef.current;
    const rect = el?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return { x: (clientX - left - pan.x) / zoom, y: (clientY - top - pan.y) / zoom };
  }, [pan.x, pan.y, zoom]);

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
    if (connect) {
      setConnect((c) => (c ? { ...c, cursor: toCanvas(e.clientX, e.clientY) } : c));
      return;
    }
    if (!drag) return;
    if (drag.kind === "node") {
      const dx = (e.clientX - drag.startX) / zoom;
      const dy = (e.clientY - drag.startY) / zoom;
      onNodesChange((prev) => prev.map(n => n.id === drag.id ? { ...n, x: drag.ox + dx, y: drag.oy + dy } : n));
    } else if (drag.kind === "pan") {
      setPan({ x: drag.ox + (e.clientX - drag.startX), y: drag.oy + (e.clientY - drag.startY) });
    }
  };
  // Drop on empty canvas cancels an in-progress connection.
  const onMouseUp = () => { setDrag(null); setConnect(null); };

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

  // Edge connecting: mousedown on an output port, mouseup on a target input port.
  const onPortDown = (e: React.MouseEvent, nodeId: string, portIdx: number) => {
    e.stopPropagation();
    setConnect({ from: nodeId, fromPort: portIdx, cursor: toCanvas(e.clientX, e.clientY) });
  };
  const onPortUp = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    if (connect && connect.from !== nodeId) onAddEdge(connect.from, nodeId, connect.fromPort);
    setConnect(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // Proportional, bounded zoom — clamp per-event delta so trackpad pinches
    // and large wheel notches don't jump.
    const d = Math.max(-40, Math.min(40, e.deltaY));
    const factor = Math.exp(-d * 0.0015);
    setZoom((z) => Math.max(0.4, Math.min(1.4, z * factor)));
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
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-flow-node")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData("application/x-flow-node");
        if (!raw) return;
        e.preventDefault();
        onDropNode(JSON.parse(raw) as PaletteItem, toCanvas(e.clientX, e.clientY));
      }}
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
        <svg width="2200" height="1000" className="absolute inset-0 overflow-visible">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#9EA3AA" />
            </marker>
            <marker id="arrowBlue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#3C43E7" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const a = nodeById[e.from], b = nodeById[e.to];
            if (!a || !b) return null;
            const p1 = portPos(a, "out", e.fromPort || 0);
            const p2 = portPos(b, "in", 0);
            const isActive = (selectedId === a.id || selectedId === b.id);
            const stroke = isActive ? "#3C43E7" : "#9EA3AA";
            const hovered = hoverEdge === i;
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            return (
              <g
                key={i}
                onMouseEnter={() => setHoverEdge(i)}
                onMouseLeave={() => setHoverEdge((h) => (h === i ? null : h))}
              >
                <path
                  d={bezier(p1, p2)}
                  stroke={hovered ? "#D14343" : stroke}
                  strokeWidth={isActive || hovered ? 2 : 1.5}
                  fill="none"
                  strokeDasharray={e.dashed ? "5 4" : "none"}
                  markerEnd={hovered ? undefined : isActive ? "url(#arrowBlue)" : "url(#arrow)"}
                  className="transition-[stroke] duration-[120ms] pointer-events-none"
                />
                {/* Fat transparent hit area so the thin edge is easy to hover */}
                <path d={bezier(p1, p2)} stroke="transparent" strokeWidth={18} fill="none" style={{ pointerEvents: "stroke" }} />
                {e.label && !hovered && (
                  <g transform={`translate(${mx}, ${my - 8})`} className="pointer-events-none">
                    <rect x={-22} y={-9} width={44} height={16} rx={2} fill="#fff" stroke={stroke} strokeWidth={1} />
                    <text x={0} y={3} fontFamily='"JetBrains Mono", monospace' fontSize={9} fontWeight={600}
                          textAnchor="middle" fill={stroke} style={{ letterSpacing: "0.04em", textTransform: "uppercase" }}>
                      {e.label}
                    </text>
                  </g>
                )}
                {/* Hover to delete: ✕ badge at the edge midpoint */}
                {hovered && (
                  <g
                    transform={`translate(${mx}, ${my})`}
                    style={{ cursor: "pointer", pointerEvents: "auto" }}
                    onMouseDown={(ev) => ev.stopPropagation()}
                    onClick={(ev) => { ev.stopPropagation(); onRemoveEdge(e); setHoverEdge(null); }}
                  >
                    <circle r={9} fill="#fff" stroke="#D14343" strokeWidth={1.5} />
                    <text x={0} y={3.5} textAnchor="middle" fontSize={12} fontWeight={700} fill="#D14343"
                          style={{ fontFamily: '"JetBrains Mono", monospace' }}>×</text>
                  </g>
                )}
              </g>
            );
          })}
          {/* Live connection being dragged from an output port */}
          {connect && (() => {
            const a = nodeById[connect.from];
            if (!a) return null;
            const p1 = portPos(a, "out", connect.fromPort);
            return (
              <path
                d={bezier(p1, connect.cursor)}
                stroke="#3C43E7"
                strokeWidth={2}
                strokeDasharray="5 4"
                fill="none"
                markerEnd="url(#arrowBlue)"
                className="pointer-events-none"
              />
            );
          })()}
        </svg>

        {/* Nodes */}
        {nodes.map(n => (
          <FlowNode
            key={n.id}
            node={n}
            selected={selectedId === n.id}
            onSelect={setSelectedId}
            onDragStart={startNodeDrag}
            onPortDown={onPortDown}
            onPortUp={onPortUp}
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
          {nodes.length} nodes · {edges.length} edges
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
  subtitle,
  flows,
  flowId,
  onSelectFlow,
}: {
  flow: Flow;
  runStatuses: RunStatusMap;
  subtitle?: string;
  flows: { id: string; label: string }[];
  flowId: string;
  onSelectFlow: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<FlowNodeDef[]>(flow.nodes);
  const [edges, setEdges] = useState<FlowEdgeDef[]>(flow.edges);
  useEffect(() => { setNodes(flow.nodes); setEdges(flow.edges); setSelectedId(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [flow.id]);

  const selected = selectedId ? nodes.find(n => n.id === selectedId) ?? null : null;

  const addNode = (item: PaletteItem, at?: Point) => {
    const num = (s: string) => parseInt(s.replace(/\D/g, ""), 10) || 0;
    const id = "n" + (Math.max(0, ...nodes.map(n => num(n.id))) + 1);
    let x: number, y: number;
    if (at) {
      // Dropped on the canvas — center the node under the cursor.
      x = Math.round(at.x - NODE_W / 2);
      y = Math.round(at.y - NODE_H / 2);
    } else {
      // Clicked — spawn just right of the rightmost node, at the flow's average height.
      x = (nodes.length ? Math.max(...nodes.map(n => n.x)) : 200) + 60;
      y = nodes.length ? Math.round(nodes.reduce((s, n) => s + n.y, 0) / nodes.length) : 280;
    }
    setNodes(prev => [...prev, { id, type: item.type, name: item.name, x, y, params: { ...item.params } }]);
    setSelectedId(id);
  };

  const addEdge = (from: string, to: string, fromPort: number) => {
    if (from === to) return;
    setEdges(prev =>
      prev.some(e => e.from === from && e.to === to && (e.fromPort || 0) === fromPort)
        ? prev
        : [...prev, { from, to, fromPort }],
    );
  };

  const removeEdge = (edge: FlowEdgeDef) => {
    setEdges(prev =>
      prev.filter(e => !(e.from === edge.from && e.to === edge.to && (e.fromPort || 0) === (edge.fromPort || 0))),
    );
  };

  const updateSelected = (path: string, value: FieldValue) => {
    setNodes((prev) => prev.map(n => {
      if (n.id !== selectedId) return n;
      if (path === "name") return { ...n, name: value as string };
      if (path === "code") return { ...n, code: value as string };
      if (path.startsWith("params.")) {
        const k = path.slice(7);
        return { ...n, params: { ...n.params, [k]: value } };
      }
      return n;
    }));
  };
  const deleteSelected = () => {
    // Anchor (locked) steps can't be removed.
    if (selected?.locked) return;
    setNodes(prev => prev.filter(n => n.id !== selectedId));
    setEdges(prev => prev.filter(e => e.from !== selectedId && e.to !== selectedId));
    setSelectedId(null);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Editor toolbar */}
      <div className="flex items-center gap-4 py-3 px-6 bg-panel border-b border-neutral-200">
        <div className="flex flex-col gap-0.5">
          <div className="font-mono text-[10px] text-neutral-500 tracking-[0.06em] uppercase">{subtitle}</div>
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <select
                value={flowId}
                onChange={(e) => onSelectFlow(e.target.value)}
                className="appearance-none cursor-pointer bg-transparent border border-neutral-200 rounded-[3px] pl-2.5 pr-7 py-0.5 font-display font-medium text-xl leading-[1.2] text-coal outline-none hover:bg-app-bg focus:border-mariner"
              >
                {flows.map((f) => (
                  <option key={f.id} value={f.id}>{f.label}</option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-neutral-500">▼</span>
            </div>
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
        <NodePalette onAdd={addNode} />
        <FlowCanvas
          flow={flow}
          nodes={nodes}
          edges={edges}
          onNodesChange={setNodes}
          onAddEdge={addEdge}
          onRemoveEdge={removeEdge}
          onDropNode={addNode}
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
