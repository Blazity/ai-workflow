"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import Link from "next/link";
import type { FlowNodeDef, FlowEdgeDef, NodeRunStatus, RunStatusMap, WorkflowBlockType } from "@/lib/flows";
import type { WorkflowEditorOptions, WorkflowParamValue } from "@shared/contracts";
import { useIsMobileViewport } from "@/lib/use-media-query";
import { MobileSheet } from "@/components/cockpit/mobile/mobile-sheet";
import { Listbox } from "@/components/cockpit/listbox";

const NODE_CATEGORIES: Record<
  WorkflowBlockType,
  { color: string; soft: string; label: string; glyph: string; group: string }
> = {
  trigger_ticket_ai:    { color: "#D14343", soft: "#FBECEC", label: "Trigger",              glyph: "▶", group: "trigger" },
  planning_agent:       { color: "#7C3AED", soft: "#F2EBFD", label: "Planning agent",       glyph: "✦", group: "agents" },
  implementation_agent: { color: "#7C3AED", soft: "#F2EBFD", label: "Implementation agent", glyph: "⌨", group: "agents" },
  review_agent:         { color: "#7C3AED", soft: "#F2EBFD", label: "Review agent",         glyph: "☰", group: "agents" },
  run_pre_pr_checks:    { color: "#64748B", soft: "#EEF1F5", label: "Pre-PR checks",        glyph: "✓", group: "utility" },
  send_slack_message:   { color: "#64748B", soft: "#EEF1F5", label: "Slack message",        glyph: "✉", group: "utility" },
  open_pr:              { color: "#3C43E7", soft: "#ECECFD", label: "Open PR",              glyph: "⇪", group: "vcs" },
  update_ticket_status: { color: "#2563EB", soft: "#E9EFFD", label: "Ticket status",        glyph: "▤", group: "ticket" },
  branch:               { color: "#35823f", soft: "#E9F3EA", label: "Branch",               glyph: "⋔", group: "control" },
  loop:                 { color: "#35823f", soft: "#E9F3EA", label: "Loop",                 glyph: "↻", group: "control" },
  terminate:            { color: "#35823f", soft: "#E9F3EA", label: "Terminate",            glyph: "■", group: "control" },
};

const NODE_W = 168;
const NODE_H = 84;

const RUN_STATUS_COLORS: Record<NodeRunStatus, string> = {
  pending: "#9EA3AA",
  running: "#3C43E7",
  ok: "#5BB04A",
  warn: "#FFC800",
  fail: "#D14343",
};

interface Point { x: number; y: number; }

function portPos(node: FlowNodeDef, kind: "in" | "out"): Point {
  if (kind === "in") return { x: node.x, y: node.y + NODE_H / 2 };
  return { x: node.x + NODE_W, y: node.y + NODE_H / 2 };
}

function bezier(p1: Point, p2: Point): string {
  const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.45);
  return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
}

function nodeSummary(node: FlowNodeDef, options: WorkflowEditorOptions): string | null {
  switch (node.type) {
    case "planning_agent":
    case "implementation_agent":
    case "review_agent": {
      const model = node.params.model;
      const modelText = typeof model === "string" && model !== "" ? model : null;
      if (modelText === null) return null;
      const provider = node.params.provider;
      return provider === "claude" || provider === "codex"
        ? `${provider} · ${modelText}`
        : modelText;
    }
    case "update_ticket_status": {
      const target = node.params.target;
      return options.ticketStatusTargets.find((t) => t.value === target)?.label ?? null;
    }
    case "send_slack_message": {
      const message = node.params.message;
      return typeof message === "string" && message !== "" ? message : null;
    }
    case "run_pre_pr_checks": {
      const cycles = node.params.maxFixCycles;
      return typeof cycles === "number" ? `${cycles} fix cycles` : null;
    }
    default:
      return null;
  }
}

const FlowNode = React.memo(function FlowNode({
  node,
  options,
  canEdit,
  selected,
  onSelect,
  onDragStart,
  onPortDown,
  onPortUp,
  runStatus,
  runError,
  connecting,
}: {
  node: FlowNodeDef;
  options: WorkflowEditorOptions;
  canEdit: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onDragStart: (e: React.PointerEvent, node: FlowNodeDef) => void;
  onPortDown: (e: React.PointerEvent, nodeId: string) => void;
  onPortUp: (e: React.PointerEvent, nodeId: string) => void;
  runStatus?: NodeRunStatus;
  runError?: string;
  connecting?: boolean;
}) {
  const cat = NODE_CATEGORIES[node.type];
  const locked = node.type === "trigger_ticket_ai";
  const summary = nodeSummary(node, options);

  return (
    <div
      onPointerDown={(e) => onDragStart(e, node)}
      onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
      className={`absolute rounded-sm select-none transition-[box-shadow,border-color] duration-[120ms] bg-panel ${
        canEdit ? "cursor-grab" : "cursor-pointer"
      } ${
        selected
          ? "border-2 border-mariner shadow-[0_0_0_4px_rgba(60,67,231,0.12),0_4px_12px_rgba(24,27,32,0.08)] z-[3]"
          : "border border-neutral-200 shadow-[0_1px_2px_rgba(24,27,32,0.05)] z-[2]"
      }`}
      style={{
        left: node.x, top: node.y,
        width: NODE_W, height: NODE_H,
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-t-[3px] font-mono text-[9px] font-semibold tracking-[0.06em] uppercase border-b"
        style={{ background: cat.soft, borderBottomColor: cat.soft, color: cat.color }}
      >
        <span
          className="w-4 h-4 rounded-xs text-white inline-flex items-center justify-center text-[10px] font-bold"
          style={{ background: cat.color }}
        >{cat.glyph}</span>
        {cat.label}
        <span className="ml-auto font-mono text-[9px] text-neutral-500">{node.id}</span>
        {locked && <span title="Anchor step, can't be removed" className="text-[9px] leading-none" aria-hidden>🔒</span>}
        {runStatus && (
          <span
            title={
              (runStatus === "fail" || runStatus === "warn") && runError
                ? `last run: ${runStatus} (${runError})`
                : "last run: " + runStatus
            }
            className={`w-1.5 h-1.5 rounded-full ${runStatus === "running" ? "animate-pulse" : ""}`}
            style={{ background: RUN_STATUS_COLORS[runStatus] }}
          />
        )}
      </div>
      <div className="px-2.5 py-2 flex flex-col gap-0.5">
        <div className="font-body text-[13px] font-semibold leading-[1.2] overflow-hidden text-ellipsis whitespace-nowrap text-coal">{node.name || cat.label}</div>
        {summary && (
          <div className="font-mono text-[10px] overflow-hidden text-ellipsis whitespace-nowrap text-neutral-700">{summary}</div>
        )}
      </div>

      {node.type !== "trigger_ticket_ai" && (
        <span
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => onPortUp(e, node.id)}
          title={canEdit ? "Drop a connection here" : undefined}
          className={`absolute w-3.5 h-3.5 rounded-full bg-panel border-2 ${canEdit ? "cursor-crosshair hover:scale-125 transition-transform" : ""}`}
          style={{
            left: -7, top: NODE_H / 2 - 7,
            borderColor: cat.color,
          }}
        />
      )}
      <span
        onPointerDown={(e) => onPortDown(e, node.id)}
        title={canEdit ? "Drag to another node to connect" : undefined}
        className={`absolute w-3.5 h-3.5 rounded-full border-2 border-white ${canEdit ? "cursor-crosshair hover:scale-125 transition-transform" : ""} ${connecting ? "ring-2 ring-mariner ring-offset-1 scale-125" : ""}`}
        style={{
          left: NODE_W - 5, top: NODE_H / 2 - 7,
          background: cat.color,
        }}
      />
    </div>
  );
});

interface PaletteItem {
  type: WorkflowBlockType;
  name: string;
  params: Record<string, WorkflowParamValue>;
}

function buildPaletteItems(defaultModel: string): PaletteItem[] {
  return [
    { type: "planning_agent", name: "Planning agent", params: { model: defaultModel } },
    { type: "implementation_agent", name: "Implementation agent", params: { model: defaultModel } },
    { type: "review_agent", name: "Review agent", params: { model: defaultModel } },
    { type: "run_pre_pr_checks", name: "Run pre-PR checks", params: { maxFixCycles: 3 } },
    { type: "open_pr", name: "Open pull request", params: {} },
    { type: "update_ticket_status", name: "Update ticket status", params: { target: "ai_review" } },
    { type: "send_slack_message", name: "Send Slack message", params: { message: "" } },
  ];
}

function NodePalette({ items, onAdd }: { items: PaletteItem[]; onAdd: (item: PaletteItem) => void }) {
  return (
    <aside className="w-52 flex-[0_0_208px] bg-panel border-r border-neutral-200 flex flex-col overflow-hidden">
      <div className="pt-[14px] px-[14px] pb-[10px] border-b border-neutral-200 flex flex-col gap-1">
        <div className="font-mono text-[9px] text-neutral-500 tracking-[0.06em] uppercase">Add step</div>
        <div className="font-mono text-[9px] text-neutral-500 tracking-[0.04em]">Drag onto canvas, or click to add</div>
      </div>
      <div className="flex-1 overflow-auto py-2 flex flex-col">
        {items.map((it) => {
          const cat = NODE_CATEGORIES[it.type];
          return (
            <button
              key={it.type}
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

const inputCls = "h-[26px] px-2 bg-off-white border border-neutral-200 rounded-xs font-mono text-xs text-coal outline-none disabled:opacity-60";

function ConfigField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2.5 px-[14px] border-b border-neutral-200">
      <label className="font-mono text-[9px] text-neutral-700 tracking-[0.06em] uppercase">{label}</label>
      {children}
    </div>
  );
}

function ConfigNote({ children }: { children: React.ReactNode }) {
  return <div className="py-2.5 px-[14px] border-b border-neutral-200 font-body text-xs leading-[1.5] text-neutral-700">{children}</div>;
}

const CUSTOM_MODEL = "__custom__";

function ProviderField({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: WorkflowEditorOptions;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <Listbox
      options={[
        { value: "", label: `Default (${options.agentKind})` },
        { value: "claude", label: "Claude Code" },
        { value: "codex", label: "OpenAI Codex" },
      ]}
      value={value}
      disabled={disabled}
      ariaLabel="Provider"
      onChange={onChange}
    />
  );
}

function ModelField({
  value,
  provider,
  options,
  disabled,
  onChange,
}: {
  value: string;
  provider: string;
  options: WorkflowEditorOptions;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const effectiveKind = provider === "claude" || provider === "codex" ? provider : options.agentKind;
  const defaultModel = options.defaultModels[effectiveKind];
  const models = options.models[effectiveKind];
  const list = useMemo(
    () => [defaultModel, ...models.filter((m) => m !== defaultModel)],
    [models, defaultModel],
  );
  const [customPicked, setCustomPicked] = useState(false);
  const custom = customPicked || (value !== "" && !list.includes(value));

  return (
    <div className="flex flex-col gap-1.5">
      <Listbox
        options={[...list.map((m) => ({ value: m, label: m })), { value: CUSTOM_MODEL, label: "Custom…" }]}
        value={custom ? CUSTOM_MODEL : value === "" ? defaultModel : value}
        disabled={disabled}
        ariaLabel="Model"
        onChange={(v) => {
          if (v === CUSTOM_MODEL) {
            setCustomPicked(true);
            return;
          }
          setCustomPicked(false);
          onChange(v);
        }}
      />
      {custom && (
        <input
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
        />
      )}
    </div>
  );
}

function ConfigFields({
  node,
  options,
  canEdit,
  onChange,
}: {
  node: FlowNodeDef;
  options: WorkflowEditorOptions;
  canEdit: boolean;
  onChange: (path: string, value: WorkflowParamValue | undefined) => void;
}) {
  switch (node.type) {
    case "trigger_ticket_ai":
      return <ConfigNote>Fires when a Jira ticket enters the AI column.</ConfigNote>;
    case "planning_agent":
    case "implementation_agent":
    case "review_agent": {
      const provider = typeof node.params.provider === "string" ? node.params.provider : "";
      return (
        <>
          <ConfigField label="Provider">
            <ProviderField
              value={provider}
              options={options}
              disabled={!canEdit}
              onChange={(v) => {
                onChange("params.provider", v);
                if (v !== provider) onChange("params.model", "");
              }}
            />
          </ConfigField>
          <ConfigField label="Model">
            <ModelField
              key={`${node.id}:${provider}`}
              value={typeof node.params.model === "string" ? node.params.model : ""}
              provider={provider}
              options={options}
              disabled={!canEdit}
              onChange={(v) => onChange("params.model", v)}
            />
          </ConfigField>
        </>
      );
    }
    case "run_pre_pr_checks":
      return (
        <>
          <ConfigField label="Max fix cycles">
            <input
              type="number"
              min={0}
              max={5}
              value={typeof node.params.maxFixCycles === "number" ? node.params.maxFixCycles : ""}
              disabled={!canEdit}
              onChange={(e) => {
                if (e.target.value === "") {
                  onChange("params.maxFixCycles", undefined);
                  return;
                }
                const n = Math.round(Number(e.target.value));
                if (!Number.isFinite(n)) return;
                onChange("params.maxFixCycles", Math.max(0, Math.min(5, n)));
              }}
              className={inputCls}
            />
          </ConfigField>
          <ConfigNote>
            Commands are configured in <Link href="/checks" className="text-mariner underline">Pre-PR checks</Link>.
          </ConfigNote>
        </>
      );
    case "open_pr":
      return <ConfigNote>Opens a pull request with the agent&apos;s changes on the ticket branch.</ConfigNote>;
    case "update_ticket_status":
      return (
        <ConfigField label="Target status">
          <Listbox
            options={options.ticketStatusTargets.map((t) => ({ value: t.value, label: t.label }))}
            value={typeof node.params.target === "string" ? node.params.target : ""}
            disabled={!canEdit}
            ariaLabel="Target status"
            onChange={(v) => onChange("params.target", v)}
          />
        </ConfigField>
      );
    case "send_slack_message":
      return (
        <ConfigField label="Message">
          <input
            value={typeof node.params.message === "string" ? node.params.message : ""}
            disabled={!canEdit}
            onChange={(e) => onChange("params.message", e.target.value)}
            className={inputCls}
          />
        </ConfigField>
      );
  }
}

function NodeConfig({
  node,
  options,
  canEdit,
  onChange,
  onDelete,
  onClose,
  embedded,
}: {
  node: FlowNodeDef;
  options: WorkflowEditorOptions;
  canEdit: boolean;
  onChange: (path: string, value: WorkflowParamValue | undefined) => void;
  onDelete: () => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  const cat = NODE_CATEGORIES[node.type];
  const locked = node.type === "trigger_ticket_ai";
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
          value={node.name ?? ""}
          disabled={!canEdit}
          onChange={(e) => onChange("name", e.target.value)}
          className="border-none outline-none p-0 bg-transparent font-display font-medium text-[17px] leading-[1.3] text-coal disabled:opacity-100"
        />
      </div>

      <div className="flex-1 overflow-auto">
        <ConfigFields node={node} options={options} canEdit={canEdit} onChange={onChange} />
      </div>

      {(locked || canEdit) && (
        <div className="border-t border-neutral-200 py-3 px-[14px] flex gap-2 items-center">
          {locked ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-neutral-700 tracking-[0.04em] uppercase">
              <span aria-hidden>🔒</span> Anchor step · can&apos;t be removed
            </span>
          ) : (
            <button
              onClick={onDelete}
              className="appearance-none cursor-pointer border border-neutral-200 bg-panel py-1.5 px-3 rounded-[3px] font-mono text-[11px] text-[#A2351C] tracking-[0.04em] uppercase"
            >Delete</button>
          )}
        </div>
      )}
    </>
  );
  return embedded ? (
    <div className="flex flex-col">{inner}</div>
  ) : (
    <aside className="w-80 flex-[0_0_320px] bg-panel border-l border-neutral-200 flex flex-col overflow-hidden">{inner}</aside>
  );
}

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
  cursor: Point;
}

function FlowCanvas({
  nodes,
  edges,
  canEdit,
  options,
  onNodesChange,
  onAddEdge,
  onRemoveEdge,
  onDropNode,
  runStatuses,
  runErrors,
  selectedId,
  setSelectedId,
  fullView,
  onToggleFullView,
  fitSignal,
}: {
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
  canEdit: boolean;
  options: WorkflowEditorOptions;
  onNodesChange: React.Dispatch<React.SetStateAction<FlowNodeDef[]>>;
  onAddEdge: (from: string, to: string) => void;
  onRemoveEdge: (edge: FlowEdgeDef) => void;
  onDropNode: (item: PaletteItem, at: Point) => void;
  runStatuses?: RunStatusMap;
  runErrors?: Record<string, string>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  fullView: boolean;
  onToggleFullView: () => void;
  fitSignal: number;
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

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    const t = setTimeout(() => fitNodes(nodesRef.current), 50);
    return () => clearTimeout(t);
  }, [fitNodes, fitSignal]);

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
    if (!canEdit) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    movedRef.current = false;
    setDrag({ kind: "node", id: node.id, ox: node.x, oy: node.y, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId });
  }, [canEdit]);
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
  const onPortDown = useCallback((e: React.PointerEvent, nodeId: string) => {
    e.stopPropagation();
    if (!canEdit) return;
    setConnect({ from: nodeId, cursor: toCanvas(e.clientX, e.clientY) });
  }, [toCanvas, canEdit]);
  const onPortUp = useCallback((e: React.PointerEvent, nodeId: string) => {
    e.stopPropagation();
    if (connect && connect.from !== nodeId) onAddEdge(connect.from, nodeId);
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
      // iOS Safari spuriously fires pointerleave mid-drag (finger still down and
      // inside the canvas, even with pointer capture), which would end the drag
      // one move in. Capture guarantees a real pointerup/cancel, so only use
      // pointerleave as the desktop mouse-left-the-window fallback.
      onPointerLeave={(e) => { if (e.pointerType !== "touch") onPointerUp(e); }}
      onPointerCancel={onPointerUp}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-flow-node")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        if (!canEdit) return;
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
            const p1 = portPos(a, "out");
            const p2 = portPos(b, "in");
            const isActive = (selectedId === a.id || selectedId === b.id);
            const stroke = isActive ? "#3C43E7" : "#9EA3AA";
            const hovered = hoverEdge === i;
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            return (
              <g
                key={i}
                onMouseEnter={() => { if (canEdit) setHoverEdge(i); }}
                onMouseLeave={() => setHoverEdge((h) => (h === i ? null : h))}
              >
                <path
                  d={bezier(p1, p2)}
                  stroke={hovered ? "#D14343" : stroke}
                  strokeWidth={isActive || hovered ? 2 : 1.5}
                  fill="none"
                  markerEnd={hovered ? undefined : isActive ? "url(#arrowBlue)" : "url(#arrow)"}
                  className="transition-[stroke] duration-[120ms] pointer-events-none"
                />
                {/* Fat transparent hit area so the thin edge is easy to hover */}
                <path d={bezier(p1, p2)} stroke="transparent" strokeWidth={18} fill="none" style={{ pointerEvents: "stroke" }} />
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
            const p1 = portPos(a, "out");
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
            options={options}
            canEdit={canEdit}
            selected={selectedId === n.id}
            onSelect={setSelectedId}
            onDragStart={startNodeDrag}
            onPortDown={onPortDown}
            onPortUp={onPortUp}
            runStatus={runStatuses?.[n.id]}
            runError={runErrors?.[n.id]}
            connecting={connect?.from === n.id}
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

export function FlowEditor({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  canEdit,
  dirty,
  saveEnabled,
  saving,
  error,
  onSave,
  headerTitle,
  headerVersionBadge,
  headerExtra,
  options,
  runStatuses,
  runErrors,
  fitSignal,
}: {
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
  onNodesChange: React.Dispatch<React.SetStateAction<FlowNodeDef[]>>;
  onEdgesChange: React.Dispatch<React.SetStateAction<FlowEdgeDef[]>>;
  canEdit: boolean;
  dirty: boolean;
  saveEnabled: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  headerTitle: string;
  headerVersionBadge: string;
  headerExtra?: React.ReactNode;
  options: WorkflowEditorOptions;
  runStatuses?: RunStatusMap;
  runErrors?: Record<string, string>;
  fitSignal?: number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fullView, setFullView] = useState(false);
  const isMobile = useIsMobileViewport();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (!fullView) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullView(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullView]);

  const selected = selectedId ? nodes.find(n => n.id === selectedId) ?? null : null;

  const paletteItems = useMemo(() => buildPaletteItems(options.defaultModel), [options.defaultModel]);

  const addNode = (item: PaletteItem, at?: Point) => {
    const num = (s: string) => parseInt(s.replace(/\D/g, ""), 10) || 0;
    const id = "n" + (Math.max(0, ...nodes.map(n => num(n.id))) + 1);
    let x: number, y: number;
    if (at) {
      x = Math.round(at.x - NODE_W / 2);
      y = Math.round(at.y - NODE_H / 2);
    } else {
      x = (nodes.length ? Math.max(...nodes.map(n => n.x)) : 200) + 60;
      y = nodes.length ? Math.round(nodes.reduce((s, n) => s + n.y, 0) / nodes.length) : 280;
    }
    onNodesChange(prev => [...prev, { id, type: item.type, name: item.name, x, y, params: { ...item.params } }]);
    setSelectedId(id);
  };

  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    onEdgesChange(prev =>
      prev.some(e => e.from === from && e.to === to)
        ? prev
        : [...prev, { from, to }],
    );
  };

  const removeEdge = (edge: FlowEdgeDef) => {
    onEdgesChange(prev =>
      prev.filter(e => !(e.from === edge.from && e.to === edge.to)),
    );
  };

  const updateSelected = (path: string, value: WorkflowParamValue | undefined) => {
    onNodesChange((prev) => prev.map(n => {
      if (n.id !== selectedId) return n;
      if (path === "name") return { ...n, name: value as string };
      if (path.startsWith("params.")) {
        const k = path.slice(7);
        const params = { ...n.params };
        if (value === undefined) delete params[k];
        else params[k] = value;
        return { ...n, params };
      }
      return n;
    }));
  };
  const deleteSelected = () => {
    if (!selected || selected.type === "trigger_ticket_ai") return;
    onNodesChange(prev => prev.filter(n => n.id !== selectedId));
    onEdgesChange(prev => prev.filter(e => e.from !== selectedId && e.to !== selectedId));
    setSelectedId(null);
  };

  return (
    <div className={`flex flex-col min-h-0 ${fullView ? "fixed inset-0 z-50 bg-app-bg" : "h-full"}`}>
      {/* Editor toolbar */}
      <div className="flex items-center gap-4 py-3 px-6 bg-panel border-b border-neutral-200">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="font-display font-semibold text-sm leading-[1.2] text-coal truncate">{headerTitle}</div>
          <span className="rounded-[3px] bg-app-bg px-[6px] py-[2px] font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-600">{headerVersionBadge}</span>
          {dirty && (
            <span className="rounded-full border border-mariner px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] uppercase text-mariner">Unsaved changes</span>
          )}
          {!canEdit && (
            <span className="rounded-full border border-neutral-200 bg-app-bg px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] uppercase text-neutral-600">Read-only</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {headerExtra}
          {canEdit && (
            <button
              onClick={onSave}
              disabled={!saveEnabled || saving}
              className="appearance-none cursor-pointer border border-mariner bg-mariner text-white py-1.5 px-3.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase disabled:opacity-40 disabled:cursor-default"
            >{saving ? "Saving…" : "Save changes"}</button>
          )}
        </div>
      </div>
      {error && (
        <div className="px-6 py-2 border-b border-red-300 bg-red-50 font-body text-[12px] text-red-700">{error}</div>
      )}

      {/* Editor body */}
      <div className="flex-1 flex min-h-0">
        {!isMobile && canEdit && <NodePalette items={paletteItems} onAdd={addNode} />}
        <FlowCanvas
          nodes={nodes}
          edges={edges}
          canEdit={canEdit}
          options={options}
          onNodesChange={onNodesChange}
          onAddEdge={addEdge}
          onRemoveEdge={removeEdge}
          onDropNode={addNode}
          runStatuses={runStatuses ?? {}}
          runErrors={runErrors ?? {}}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          fullView={fullView}
          onToggleFullView={() => setFullView((v) => !v)}
          fitSignal={fitSignal ?? 0}
        />
        {selected && !isMobile && (
          <NodeConfig
            node={selected}
            options={options}
            canEdit={canEdit}
            onChange={updateSelected}
            onDelete={deleteSelected}
            onClose={() => setSelectedId(null)}
          />
        )}
        {isMobile && (
          <MobileSheet
            open={!!selected}
            onClose={() => setSelectedId(null)}
            title={selected ? `${NODE_CATEGORIES[selected.type].label} · ${selected.name ?? ""}` : ""}
            heightClass="max-h-[80vh]"
          >
            {selected && (
              <NodeConfig
                node={selected}
                options={options}
                canEdit={canEdit}
                onChange={updateSelected}
                onDelete={deleteSelected}
                onClose={() => setSelectedId(null)}
                embedded
              />
            )}
          </MobileSheet>
        )}
        {isMobile && canEdit && (
          <button
            onClick={() => setPaletteOpen(true)}
            aria-label="Add step"
            className="fixed left-4 bottom-[72px] z-40 w-12 h-12 rounded-full bg-mariner text-white text-2xl leading-none shadow-[0_3px_10px_rgba(24,27,32,0.25)] flex items-center justify-center"
          >＋</button>
        )}
        {isMobile && canEdit && (
          <MobileSheet open={paletteOpen} onClose={() => setPaletteOpen(false)} title="Add step" heightClass="max-h-[60vh]">
            <div className="flex flex-col py-1">
              {paletteItems.map((it) => {
                const cat = NODE_CATEGORIES[it.type];
                return (
                  <button
                    key={it.type}
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
