"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { CkChip } from "@/components/ui";
import type { Flow, FlowNodeDef, FlowEdgeDef, FlowParamValue, RunStatusMap, NodeType } from "@/lib/flows";
import { useIsMobileViewport } from "@/lib/use-media-query";
import { MobileSheet } from "@/components/cockpit/mobile/mobile-sheet";

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

const FlowNode = React.memo(function FlowNode({
  node,
  selected,
  onSelect,
  onDragStart,
  onPortDown,
  onPortUp,
  runStatus,
  connectingPort,
}: {
  node: FlowNodeDef;
  selected: boolean;
  onSelect: (id: string) => void;
  onDragStart: (e: React.PointerEvent, node: FlowNodeDef) => void;
  onPortDown: (e: React.PointerEvent, nodeId: string, portIdx: number) => void;
  onPortUp: (e: React.PointerEvent, nodeId: string) => void;
  runStatus?: string;
  connectingPort?: number | null;
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
      onPointerDown={(e) => onDragStart(e, node)}
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
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => onPortUp(e, node.id)}
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
              onPointerDown={(e) => onPortDown(e, node.id, i)}
              title="Drag to another node to connect"
              className={`absolute w-3.5 h-3.5 rounded-full border-2 border-white cursor-crosshair hover:scale-125 transition-transform ${connectingPort === i ? "ring-2 ring-mariner ring-offset-1 scale-125" : ""}`}
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
});

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
  onClose,
  embedded,
}: {
  node: FlowNodeDef;
  onChange: (path: string, value: FieldValue) => void;
  onDelete: () => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  const cat = NODE_CATEGORIES[node.type] || NODE_CATEGORIES.tool;
  const inner = (
    <>
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
          <button
            onClick={onClose}
            title="Close inspector"
            aria-label="Close inspector"
            className="appearance-none border-none bg-transparent cursor-pointer w-[22px] h-[22px] -mr-1 rounded-xs inline-flex items-center justify-center font-mono text-sm text-neutral-500 hover:bg-app-bg hover:text-coal"
          >×</button>
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
    </>
  );
  return embedded ? (
    <div className="flex flex-col">{inner}</div>
  ) : (
    <aside className="w-80 flex-[0_0_320px] bg-panel border-l border-neutral-200 flex flex-col overflow-hidden">{inner}</aside>
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
  pointerId?: number;
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
  fullView,
  onToggleFullView,
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
  fullView: boolean;
  onToggleFullView: () => void;
}) {
  const [pan, setPan] = useState({ x: 0, y: -40 });
  const [zoom, setZoom] = useState(0.85);
  const [drag, setDrag] = useState<DragState | null>(null);  // { kind: "node"|"pan", id, ox, oy }
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pointers = useRef<Map<number, Point>>(new Map());
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  // A node press only becomes a drag once the pointer travels past this many
  // screen px. Below it, the press stays a tap — so touch jitter neither nudges
  // the node nor suppresses the synthetic click that selects it.
  const movedRef = useRef(false);
  // Mirror latest pan/zoom for the native wheel listener (attached once).
  const viewRef = useRef({ pan, zoom });
  viewRef.current = { pan, zoom };

  // Convert a client point into canvas (unscaled) coordinates.
  const toCanvas = useCallback((clientX: number, clientY: number): Point => {
    const el = containerRef.current;
    const rect = el?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    // Read live pan/zoom from the ref so this stays identity-stable across
    // pan/zoom — lets the port handlers be memoized without breaking on pan.
    const { pan, zoom } = viewRef.current;
    return { x: (clientX - left - pan.x) / zoom, y: (clientY - top - pan.y) / zoom };
  }, []);

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

  // Pan so a node sits in the middle of the viewport, keeping the current zoom.
  const centerNode = useCallback((node: FlowNodeDef) => {
    const el = containerRef.current;
    if (!el) return;
    const { zoom: z } = viewRef.current;
    setPan({
      x: el.clientWidth / 2 - (node.x + NODE_W / 2) * z,
      y: el.clientHeight / 2 - (node.y + NODE_H / 2) * z,
    });
  }, []);

  // On mobile a palette-added node spawns to the right of the rightmost node —
  // off the narrow viewport, so it looks like nothing happened. When the node
  // count grows, relocate the canvas to center the freshly spawned step.
  const isMobileCanvas = useIsMobileViewport();
  const nodeCountRef = useRef(nodes.length);
  useEffect(() => {
    if (isMobileCanvas && nodes.length > nodeCountRef.current) {
      centerNode(nodes[nodes.length - 1]);
    }
    nodeCountRef.current = nodes.length;
  }, [nodes, isMobileCanvas, centerNode]);

  // Native, non-passive wheel listener. React's onWheel is passive, so its
  // preventDefault() is ignored and a trackpad pinch (ctrl+wheel) zooms the
  // whole page. Attaching here lets us own the gesture: pinch zooms the canvas
  // (anchored at the cursor) and two-finger scroll pans it.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { pan, zoom } = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const d = Math.max(-50, Math.min(50, e.deltaY));
        const nz = Math.max(0.4, Math.min(1.4, zoom * Math.exp(-d * 0.004)));
        const ratio = nz / zoom;
        // Keep the point under the cursor fixed while scaling.
        setPan({ x: cx - (cx - pan.x) * ratio, y: cy - (cy - pan.y) * ratio });
        setZoom(nz);
      } else {
        setPan({ x: pan.x - e.deltaX, y: pan.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const rect = containerRef.current?.getBoundingClientRect();
      const lx = cx - (rect?.left ?? 0);
      const ly = cy - (rect?.top ?? 0);
      if (pinch.current) {
        const { pan: vpan, zoom: vzoom } = viewRef.current;
        const ratio = dist / (pinch.current.dist || dist);
        const nz = Math.max(0.4, Math.min(1.4, vzoom * ratio));
        const scale = nz / vzoom;
        // Anchored scale at the gesture centroid, plus pan by the centroid delta.
        setPan({
          x: lx - (lx - vpan.x) * scale + (cx - pinch.current.cx),
          y: ly - (ly - vpan.y) * scale + (cy - pinch.current.cy),
        });
        setZoom(nz);
      }
      pinch.current = { dist, cx, cy };
      return; // don't also run node/pan drag this frame
    }
    if (connect) {
      setConnect((c) => (c ? { ...c, cursor: toCanvas(e.clientX, e.clientY) } : c));
      return;
    }
    if (!drag) return;
    if (drag.kind === "node") {
      const dxPx = e.clientX - drag.startX;
      const dyPx = e.clientY - drag.startY;
      // Ignore sub-threshold jitter so a tap stays a tap (no nudge, no re-render).
      if (!movedRef.current && Math.hypot(dxPx, dyPx) < 5) return;
      movedRef.current = true;
      const dx = dxPx / zoom;
      const dy = dyPx / zoom;
      onNodesChange((prev) => prev.map(n => n.id === drag.id ? { ...n, x: drag.ox + dx, y: drag.oy + dy } : n));
    } else if (drag.kind === "pan") {
      setPan({ x: drag.ox + (e.clientX - drag.startX), y: drag.oy + (e.clientY - drag.startY) });
    }
  };
  // Drop on empty canvas cancels an in-progress connection.
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    pinch.current = null;
    setDrag(null);
    // On touch, keep an armed connection alive until the user taps a target
    // input port (completes) or empty canvas (cancels); mouse release ends drag-connect.
    if (e.pointerType !== "touch") setConnect(null);
  };

  const startNodeDrag = useCallback((e: React.PointerEvent, node: FlowNodeDef) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    movedRef.current = false;
    setDrag({ kind: "node", id: node.id, ox: node.x, oy: node.y, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId });
  }, []);
  const startPanDrag = (e: React.PointerEvent) => {
    // Node pointerdown stops propagation, so this only fires for empty canvas hits.
    // Bottom-corner control overlays also stopPropagation in their handlers.
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === "touch" && connect) {
      pointers.current.delete(e.pointerId);
      setConnect(null);
      return;
    }
    setSelectedId(null);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ kind: "pan", ox: pan.x, oy: pan.y, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId });
  };

  // Edge connecting: pointerdown on an output port, pointerup on a target input port.
  const onPortDown = useCallback((e: React.PointerEvent, nodeId: string, portIdx: number) => {
    e.stopPropagation();
    setConnect({ from: nodeId, fromPort: portIdx, cursor: toCanvas(e.clientX, e.clientY) });
  }, [toCanvas]);
  const onPortUp = useCallback((e: React.PointerEvent, nodeId: string) => {
    e.stopPropagation();
    if (connect && connect.from !== nodeId) onAddEdge(connect.from, nodeId, connect.fromPort);
    setConnect(null);
  }, [connect, onAddEdge]);

  // For edges
  const nodeById = useMemo(() => Object.fromEntries(nodes.map(n => [n.id, n])), [nodes]);

  return (
    <div
      ref={containerRef}
      onPointerDown={startPanDrag}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onPointerCancel={onPointerUp}
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
      className={`flow-canvas-bg flex-1 relative overflow-hidden touch-none bg-[#FAFBFC] ${drag?.kind === "pan" ? "cursor-grabbing" : "cursor-grab"}`}
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
                    onPointerDown={(ev) => ev.stopPropagation()}
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
            connectingPort={connect?.from === n.id ? connect.fromPort : null}
          />
        ))}
      </div>

      {/* Canvas overlays: zoom controls, mini status */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute right-4 bottom-4 z-10 flex flex-col gap-1 bg-panel border border-neutral-200 rounded-[3px] p-1 shadow-[0_2px_6px_rgba(24,27,32,0.08)]"
      >
        <button
          onClick={(e) => { e.stopPropagation(); onToggleFullView(); }}
          title={fullView ? "Exit full view (Esc)" : "Full view"}
          aria-label={fullView ? "Exit full view" : "Full view"}
          className="appearance-none border-none bg-transparent cursor-pointer w-[26px] h-[26px] rounded-xs font-mono text-sm text-coal hover:bg-app-bg"
        >{fullView ? "⤡" : "⤢"}</button>
        <div className="h-px bg-neutral-200 mx-1" />
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

    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Last-run rail: shows latest invocation of this flow with per-node status.
   ──────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────
   FlowSelect — custom listbox for the flow picker. Native <option> can't be
   themed, so this is a button + popup that matches the cockpit design system.
   ──────────────────────────────────────────────────────────────────────── */

function FlowSelect({
  flows,
  flowId,
  onSelectFlow,
}: {
  flows: { id: string; label: string }[];
  flowId: string;
  onSelectFlow: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const current = flows.find((f) => f.id === flowId) ?? flows[0];

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Point the active row at the current selection whenever the popup opens.
  useEffect(() => {
    if (open) setActiveIdx(Math.max(0, flows.findIndex((f) => f.id === flowId)));
  }, [open, flowId, flows]);

  // Keep the active row in view while arrow-keying.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx]);

  const commit = (idx: number) => {
    const f = flows[idx];
    if (f) onSelectFlow(f.id);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) setOpen(true);
        else setActiveIdx((i) => Math.min(flows.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) setOpen(true);
        else setActiveIdx((i) => Math.max(0, i - 1));
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (open) commit(activeIdx);
        else setOpen(true);
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      case "Tab":
        if (open) setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-open={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className="group/sel appearance-none cursor-pointer inline-flex items-center gap-2 bg-transparent border border-neutral-200 rounded-[3px] px-2.5 py-1 font-display font-semibold text-sm leading-[1.2] text-coal outline-none transition-[color,background-color,border-color,box-shadow] duration-[120ms] ease-standard hover:border-neutral-300 hover:bg-app-bg focus-visible:border-mariner focus-visible:bg-panel focus-visible:ring-2 focus-visible:ring-mariner-100 data-[open=true]:border-mariner data-[open=true]:bg-panel data-[open=true]:ring-2 data-[open=true]:ring-mariner-100"
      >
        <span className="truncate max-w-[42ch]">{current?.label}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3 -mr-0.5 text-neutral-400 transition-[transform,color] duration-[160ms] ease-standard group-hover/sel:text-neutral-600 group-data-[open=true]/sel:rotate-180 group-data-[open=true]/sel:text-mariner"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={flows[activeIdx] ? `flowopt-${flows[activeIdx].id}` : undefined}
          className="absolute left-0 top-[calc(100%+6px)] z-50 min-w-full w-max max-w-[min(420px,80vw)] max-h-[min(60vh,360px)] overflow-y-auto py-1 bg-panel border border-neutral-200 rounded-sm shadow-[0_12px_28px_-8px_rgba(24,27,32,0.22),0_2px_6px_rgba(24,27,32,0.08)] origin-top animate-ck-pop"
        >
          {flows.map((f, i) => {
            const selected = f.id === flowId;
            const active = i === activeIdx;
            return (
              <li
                key={f.id}
                id={`flowopt-${f.id}`}
                role="option"
                aria-selected={selected}
                data-active={active}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => commit(i)}
                className={`relative mx-1 flex items-center gap-2.5 rounded-[3px] pl-3 pr-2.5 py-2 cursor-pointer transition-colors duration-[90ms] ${active ? "bg-app-bg" : ""}`}
              >
                {selected && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-mariner" />
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className={`font-display text-sm leading-tight truncate ${
                      selected ? "font-semibold text-mariner" : "font-medium text-coal"
                    }`}
                  >
                    {f.label}
                  </span>
                  <span className="font-mono text-[10px] tracking-[0.04em] text-neutral-500 truncate">{f.id}</span>
                </span>
                {selected && (
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="ml-auto size-3.5 flex-none text-mariner"
                  >
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

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
  const [fullView, setFullView] = useState(false);
  const isMobile = useIsMobileViewport();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => { setNodes(flow.nodes); setEdges(flow.edges); setSelectedId(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [flow.id]);

  useEffect(() => {
    if (!fullView) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullView(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullView]);

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
    <div className={`flex flex-col min-h-0 ${fullView ? "fixed inset-0 z-50 bg-app-bg" : "h-full"}`}>
      {/* Editor toolbar */}
      <div className="flex items-center gap-4 py-3 px-6 bg-panel border-b border-neutral-200">
        <div className="flex flex-col gap-0.5">
          <div className="font-mono text-[10px] text-neutral-500 tracking-[0.06em] uppercase">{subtitle}</div>
          <div className="flex items-center gap-2.5">
            <FlowSelect flows={flows} flowId={flowId} onSelectFlow={onSelectFlow} />
          </div>
        </div>
      </div>


      {/* Editor body */}
      <div className="flex-1 flex min-h-0">
        {!isMobile && <NodePalette onAdd={addNode} />}
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
          fullView={fullView}
          onToggleFullView={() => setFullView((v) => !v)}
        />
        {selected && !isMobile && (
          <NodeConfig
            node={selected}
            onChange={updateSelected}
            onDelete={deleteSelected}
            onClose={() => setSelectedId(null)}
          />
        )}
        {isMobile && (
          <MobileSheet
            open={!!selected}
            onClose={() => setSelectedId(null)}
            title={selected ? `${selected.type} · ${selected.name}` : ""}
            heightClass="max-h-[80vh]"
          >
            {selected && (
              <NodeConfig
                node={selected}
                onChange={updateSelected}
                onDelete={deleteSelected}
                onClose={() => setSelectedId(null)}
                embedded
              />
            )}
          </MobileSheet>
        )}
        {isMobile && (
          <button
            onClick={() => setPaletteOpen(true)}
            aria-label="Add step"
            className="fixed left-4 bottom-[72px] z-40 w-12 h-12 rounded-full bg-mariner text-white text-2xl leading-none shadow-[0_3px_10px_rgba(24,27,32,0.25)] flex items-center justify-center"
          >＋</button>
        )}
        {isMobile && (
          <MobileSheet open={paletteOpen} onClose={() => setPaletteOpen(false)} title="Add step" heightClass="max-h-[60vh]">
            <div className="flex flex-col py-1">
              {PALETTE_ITEMS.map((it) => {
                const cat = NODE_CATEGORIES[it.type] || NODE_CATEGORIES.tool;
                return (
                  <button
                    key={it.name}
                    onClick={() => { addNode(it); setPaletteOpen(false); }}
                    className="appearance-none text-left border-none cursor-pointer flex items-center gap-3 px-[18px] py-3.5 bg-transparent active:bg-app-bg"
                  >
                    <span
                      className="w-[22px] h-[22px] rounded-xs text-white inline-flex items-center justify-center font-mono text-[12px] font-bold flex-[0_0_22px]"
                      style={{ background: cat.color }}
                    >{cat.glyph}</span>
                    <span className="font-body text-[15px] text-coal">{it.name}</span>
                  </button>
                );
              })}
            </div>
          </MobileSheet>
        )}
      </div>
    </div>
  );
}
const ghostBtnCls = "appearance-none cursor-pointer border border-neutral-200 bg-panel text-coal py-1.5 px-3 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase";
const darkBtnLightCls = "appearance-none cursor-pointer border border-coal bg-coal text-white py-1.5 px-3.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase";
