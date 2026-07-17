"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import type { FlowNodeDef, FlowEdgeDef, NodeRunStatus, RunStatusMap } from "@/lib/flows";
import type {
  WorkflowDefinition,
  WorkflowEditorOptions,
  WorkflowExecutionBudgets,
  WorkflowParamValue,
} from "@shared/contracts";
import { FAILURE_PORT, isTriggerBlockType } from "@shared/contracts";
import { useIsMobileViewport } from "@/lib/use-media-query";
import { MobileSheet } from "@/components/cockpit/mobile/mobile-sheet";
import {
  defaultPort,
  edgeKey,
  isBackEdge,
  removeEdge as removeEdgeFromList,
  resolvedPort,
  upsertEdge,
  visibleOutPorts,
} from "@/lib/workflow-editor/edges";
import {
  blockPresentation,
  buildPaletteItems,
  CONNECTED_CARD_TEXT_CLASS,
  nodeSummary,
} from "./blocks";
import type { PaletteItem } from "./blocks";
import { NODE_W, NODE_H, inPortPos, outPortPos, bezier } from "./ports";
import type { Point } from "./ports";
import { NodePalette, MobilePaletteList } from "./palette";
import { ConfigFields } from "./config-fields";
import { BindingFields, updateInputBindings } from "./binding-fields";
import type { WorkflowValidationState } from "@/lib/workflow-editor/validation-controller";
import { removeNodeFromGraph } from "@/lib/workflow-editor/graph-edit";
import {
  setExecutionLimit,
  type WorkflowExecutionLimitKey,
} from "@/lib/workflow-editor/execution-limits";

const RUN_STATUS_COLORS: Record<NodeRunStatus, string> = {
  pending: "#9EA3AA",
  running: "#3C43E7",
  ok: "#5BB04A",
  warn: "#FFC800",
  fail: "#D14343",
};

const EXECUTION_LIMIT_FIELDS: Array<{
  key: WorkflowExecutionLimitKey;
  label: string;
  placeholder: string;
  step: number;
}> = [
  { key: "maxDurationMs", label: "Duration (ms)", placeholder: "Default", step: 1 },
  { key: "maxTokens", label: "Tokens", placeholder: "Unset", step: 1 },
  { key: "maxCostUsd", label: "Cost (USD)", placeholder: "Unset", step: 0.01 },
];

function ExecutionLimitsBar({
  limits,
  canEdit,
  onChange,
}: {
  limits: WorkflowExecutionBudgets;
  canEdit: boolean;
  onChange: (limits: WorkflowExecutionBudgets) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2 border-b border-neutral-200 bg-app-bg">
      <div className="min-w-[110px]">
        <div className="font-mono text-[9px] font-semibold tracking-[0.06em] uppercase text-neutral-700">
          Execution limits
        </div>
        <div className="font-body text-[10px] text-neutral-500">Optional per run</div>
      </div>
      {EXECUTION_LIMIT_FIELDS.map((field) => (
        <label key={field.key} className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] tracking-[0.04em] uppercase text-neutral-600">
            {field.label}
          </span>
          <input
            type="number"
            min={field.step}
            step={field.step}
            value={limits[field.key] ?? ""}
            placeholder={field.placeholder}
            disabled={!canEdit}
            onChange={(event) => {
              const value = event.target.value === "" ? undefined : Number(event.target.value);
              if (value !== undefined && !Number.isFinite(value)) return;
              onChange(setExecutionLimit(limits, field.key, value));
            }}
            className="h-[26px] w-[104px] px-2 bg-panel border border-neutral-200 rounded-xs font-mono text-[10px] text-coal outline-none disabled:opacity-60"
          />
        </label>
      ))}
    </div>
  );
}

const FlowNode = React.memo(function FlowNode({
  node,
  options,
  canEdit,
  selected,
  locked,
  outPorts,
  onSelect,
  onDelete,
  onDragStart,
  onPortDown,
  onPortUp,
  runStatus,
  runError,
  connectingPort,
}: {
  node: FlowNodeDef;
  options: WorkflowEditorOptions;
  canEdit: boolean;
  selected: boolean;
  locked: boolean;
  outPorts: string[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDragStart: (e: React.PointerEvent, node: FlowNodeDef) => void;
  onPortDown: (e: React.PointerEvent, nodeId: string, portId: string) => void;
  onPortUp: (e: React.PointerEvent, nodeId: string) => void;
  runStatus?: NodeRunStatus;
  runError?: string;
  connectingPort?: string | null;
}) {
  const cat = blockPresentation(options, node.type);
  const summary = nodeSummary(node, options);
  const portCount = outPorts.length;
  const running = runStatus === "running";

  return (
    <div
      onPointerDown={(e) => {
        if (e.button === 2) {
          e.stopPropagation();
          return;
        }
        onDragStart(e, node);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (canEdit && !locked) onDelete(node.id);
      }}
      onClick={(e) => { e.stopPropagation(); onSelect(node.id); }}
      className={`absolute rounded-sm select-none transition-[box-shadow,border-color] duration-[120ms] bg-panel ${
        canEdit ? "cursor-grab" : "cursor-pointer"
      } ${
        running
          ? "border-2 border-mariner z-[4] animate-ck-glow"
          : selected
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
        style={{ background: cat.softColor, borderBottomColor: cat.softColor, color: cat.color }}
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
        <div className={`font-body text-[13px] font-semibold leading-[1.2] text-coal ${CONNECTED_CARD_TEXT_CLASS}`}>{node.name || cat.label}</div>
        {summary && (
          <div className={`font-mono text-[10px] text-neutral-700 ${CONNECTED_CARD_TEXT_CLASS}`}>{summary}</div>
        )}
      </div>

      {!isTriggerBlockType(node.type) && (
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
      {outPorts.map((port, i) => {
        const top = (NODE_H * (i + 1)) / (portCount + 1);
        const showLabel = portCount > 1 || port === FAILURE_PORT;
        return (
          <span key={port}>
            {showLabel && (
              <span
                className="absolute font-mono text-[8px] font-semibold tracking-[0.06em] uppercase leading-none pointer-events-none"
                style={{ right: 12, top: top - 4, color: cat.color }}
              >{port}</span>
            )}
            <span
              onPointerDown={(e) => onPortDown(e, node.id, port)}
              title={canEdit ? "Drag to another node to connect" : undefined}
              className={`absolute w-3.5 h-3.5 rounded-full border-2 border-white ${canEdit ? "cursor-crosshair hover:scale-125 transition-transform" : ""} ${connectingPort === port ? "ring-2 ring-mariner ring-offset-1 scale-125" : ""}`}
              style={{
                left: NODE_W - 5, top: top - 7,
                background: cat.color,
              }}
            />
          </span>
        );
      })}
    </div>
  );
});

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
  fromPort: string;
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
  onDeleteNode,
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
  onAddEdge: (from: string, fromPort: string, to: string) => void;
  onRemoveEdge: (edge: FlowEdgeDef) => void;
  onDeleteNode: (nodeId: string) => void;
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
  const onPortDown = useCallback((e: React.PointerEvent, nodeId: string, portId: string) => {
    e.stopPropagation();
    if (!canEdit) return;
    setConnect({ from: nodeId, fromPort: portId, cursor: toCanvas(e.clientX, e.clientY) });
  }, [toCanvas, canEdit]);
  const onPortUp = useCallback((e: React.PointerEvent, nodeId: string) => {
    e.stopPropagation();
    if (connect && connect.from !== nodeId) onAddEdge(connect.from, connect.fromPort, nodeId);
    setConnect(null);
  }, [connect, onAddEdge]);

  // For edges
  const nodeById = useMemo(() => Object.fromEntries(nodes.map(n => [n.id, n])), [nodes]);

  // A sole trigger cannot be deleted (a graph needs at least one entry point).
  const triggerCount = useMemo(() => nodes.filter(n => isTriggerBlockType(n.type)).length, [nodes]);

  // Nodes whose "failed" port is wired by an existing edge — such ports render
  // even when the node isn't selected.
  const failureUsed = useMemo(() => {
    const set = new Set<string>();
    for (const e of edges) if (e.fromPort === FAILURE_PORT) set.add(e.from);
    return set;
  }, [edges]);

  // Output ports rendered per node: the spec ports plus "failed" when it is
  // wired or the node is the editable selection.
  const portsByNode = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const n of nodes) {
      map[n.id] = visibleOutPorts(n.type, failureUsed.has(n.id), selectedId === n.id && canEdit);
    }
    return map;
  }, [nodes, failureUsed, selectedId, canEdit]);

  // Edges that close a cycle (their target can already reach their source) are
  // drawn dashed. Recomputed only when the edge set changes.
  const backEdgeKeys = useMemo(() => {
    const set = new Set<string>();
    for (const e of edges) if (isBackEdge(edges, e)) set.add(edgeKey(e));
    return set;
  }, [edges]);

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
            const ports = portsByNode[a.id] ?? [];
            const port = resolvedPort(e, a.type);
            const idx = ports.indexOf(port);
            const p1 = outPortPos(a, idx < 0 ? 0 : idx, ports.length || 1);
            const p2 = inPortPos(b);
            const isActive = (selectedId === a.id || selectedId === b.id);
            const stroke = isActive ? "#3C43E7" : "#9EA3AA";
            const hovered = hoverEdge === i;
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            const back = backEdgeKeys.has(edgeKey(e));
            const labelPort = e.fromPort !== undefined && e.fromPort !== defaultPort(a.type) ? e.fromPort : null;
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
                  strokeDasharray={back ? "6 6" : undefined}
                  fill="none"
                  markerEnd={hovered ? undefined : isActive ? "url(#arrowBlue)" : "url(#arrow)"}
                  className="transition-[stroke] duration-[120ms] pointer-events-none"
                />
                {/* Fat transparent hit area so the thin edge is easy to hover */}
                <path d={bezier(p1, p2)} stroke="transparent" strokeWidth={18} fill="none" style={{ pointerEvents: "stroke" }} />
                {labelPort && !hovered && (
                  <text
                    x={mx} y={my - 8} textAnchor="middle" fontSize={11} fontWeight={800}
                    fill="#181b20" stroke="#fff" strokeWidth={4} paintOrder="stroke"
                    className="pointer-events-none"
                    style={{ fontFamily: '"JetBrains Mono", monospace' }}
                  >{labelPort}</text>
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
            const ports = portsByNode[a.id] ?? [];
            const idx = ports.indexOf(connect.fromPort);
            const p1 = outPortPos(a, idx < 0 ? 0 : idx, ports.length || 1);
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
            locked={isTriggerBlockType(n.type) && triggerCount === 1}
            outPorts={portsByNode[n.id] ?? []}
            onSelect={setSelectedId}
            onDelete={onDeleteNode}
            onDragStart={startNodeDrag}
            onPortDown={onPortDown}
            onPortUp={onPortUp}
            runStatus={runStatuses?.[n.id]}
            runError={runErrors?.[n.id]}
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

export function FlowEditor({
  nodes,
  edges,
  limits,
  onLimitsChange,
  onNodesChange,
  onEdgesChange,
  canEdit,
  dirty,
  saveEnabled,
  saving,
  error,
  validation,
  onSave,
  saveLabel = "Save changes",
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
  limits: WorkflowExecutionBudgets;
  onLimitsChange: (limits: WorkflowExecutionBudgets) => void;
  onNodesChange: React.Dispatch<React.SetStateAction<FlowNodeDef[]>>;
  onEdgesChange: React.Dispatch<React.SetStateAction<FlowEdgeDef[]>>;
  canEdit: boolean;
  dirty: boolean;
  saveEnabled: boolean;
  saving: boolean;
  error: string | null;
  validation: WorkflowValidationState;
  onSave: () => void;
  saveLabel?: string;
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
  const triggerCount = nodes.filter(n => isTriggerBlockType(n.type)).length;
  const selectedLocked = selected ? isTriggerBlockType(selected.type) && triggerCount === 1 : false;

  const paletteGroups = useMemo(() => buildPaletteItems(options), [options]);
  const bindingDefinition = useMemo<WorkflowDefinition>(
    () => ({ schemaVersion: 1, nodes, edges }),
    [edges, nodes],
  );

  const addNode = (item: PaletteItem, at?: Point) => {
    if (!item.available) return;
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
    onNodesChange(prev => [
      ...prev,
      { id, type: item.type, name: item.name, x, y, params: { ...item.params }, inputs: {} },
    ]);
    setSelectedId(id);
  };

  const addEdge = (from: string, fromPort: string, to: string) => {
    if (from === to) return;
    const source = nodes.find(n => n.id === from);
    if (!source) return;
    onEdgesChange(prev => upsertEdge(prev, from, fromPort, to, source.type));
  };

  const removeEdge = (edge: FlowEdgeDef) => {
    onEdgesChange(prev => removeEdgeFromList(prev, edge));
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
      if (path.startsWith("inputs.")) {
        const name = path.slice(7);
        const bindingValue = typeof value === "string" ? value : undefined;
        return {
          ...n,
          inputs: updateInputBindings(
            n.inputs,
            name,
            bindingValue,
          ),
        };
      }
      return n;
    }));
  };
  const deleteNode = (nodeId: string) => {
    const result = removeNodeFromGraph(nodes, edges, nodeId);
    if (!result.removed) return;
    onNodesChange(result.nodes);
    onEdgesChange(result.edges);
    if (selectedId === nodeId) setSelectedId(null);
  };
  const deleteSelected = () => {
    if (selected) deleteNode(selected.id);
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
          <span
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-[0.04em] uppercase ${
              validation.status === "valid"
                ? "border-emerald-300 text-emerald-700"
                : validation.status === "checking"
                  ? "border-neutral-200 text-neutral-500"
                  : "border-red-300 text-red-700"
            }`}
          >
            {validation.status === "valid"
              ? "Validated"
              : validation.status === "checking"
                ? "Validating…"
                : `${validation.issues.length} validation issue${validation.issues.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {headerExtra}
          {canEdit && (
            <button
              onClick={onSave}
              disabled={!saveEnabled || saving}
              className="appearance-none cursor-pointer border border-mariner bg-mariner text-white py-1.5 px-3.5 rounded-[3px] font-mono text-[11px] tracking-[0.04em] uppercase disabled:opacity-40 disabled:cursor-default"
            >{saving ? "Saving…" : saveLabel}</button>
          )}
        </div>
      </div>
      <ExecutionLimitsBar limits={limits} canEdit={canEdit} onChange={onLimitsChange} />
      {error && (
        <div className="px-6 py-2 border-b border-red-300 bg-red-50 font-body text-[12px] text-red-700">{error}</div>
      )}
      {(validation.status === "invalid" || validation.status === "error") && (
        <div className="px-6 py-2 border-b border-amber-300 bg-amber-50 font-body text-[12px] text-amber-900">
          <ul className="m-0 pl-4 space-y-0.5">
            {validation.issues.map((issue, index) => (
              <li key={`${issue.nodeId ?? "workflow"}-${index}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Editor body */}
      <div className="flex-1 flex min-h-0">
        {!isMobile && canEdit && <NodePalette groups={paletteGroups} onAdd={addNode} />}
        <FlowCanvas
          nodes={nodes}
          edges={edges}
          canEdit={canEdit}
          options={options}
          onNodesChange={onNodesChange}
          onAddEdge={addEdge}
          onRemoveEdge={removeEdge}
          onDeleteNode={deleteNode}
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
            definition={bindingDefinition}
            nodeContracts={validation.nodeContracts}
            canEdit={canEdit}
            locked={selectedLocked}
            onChange={updateSelected}
            onDelete={deleteSelected}
            onClose={() => setSelectedId(null)}
          />
        )}
        {isMobile && (
          <MobileSheet
            open={!!selected}
            onClose={() => setSelectedId(null)}
            title={selected ? `${blockPresentation(options, selected.type).label} · ${selected.name ?? ""}` : ""}
            heightClass="max-h-[80vh]"
          >
            {selected && (
              <NodeConfig
                node={selected}
                options={options}
                definition={bindingDefinition}
                nodeContracts={validation.nodeContracts}
                canEdit={canEdit}
                locked={selectedLocked}
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
            <MobilePaletteList groups={paletteGroups} onAdd={(it) => { addNode(it); setPaletteOpen(false); }} />
          </MobileSheet>
        )}
      </div>
    </div>
  );
}

function NodeConfig({
  node,
  options,
  definition,
  nodeContracts,
  canEdit,
  locked,
  onChange,
  onDelete,
  onClose,
  embedded,
}: {
  node: FlowNodeDef;
  options: WorkflowEditorOptions;
  definition: WorkflowDefinition;
  nodeContracts: WorkflowValidationState["nodeContracts"];
  canEdit: boolean;
  locked: boolean;
  onChange: (path: string, value: WorkflowParamValue | undefined) => void;
  onDelete: () => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  const cat = blockPresentation(options, node.type);
  const contract = nodeContracts[node.id] ?? options.blockRegistry[node.type];
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
        <BindingFields
          key={node.id}
          definition={definition}
          nodeId={node.id}
          options={options}
          nodeContracts={nodeContracts}
          canEdit={canEdit}
          onChange={(name, value) => onChange(`inputs.${name}`, value)}
          onLegacyParamsChange={(params) =>
            onChange("params.legacyRequiredChecks", params.legacyRequiredChecks)
          }
        />
        {!contract.availability.available && (
          <div className="py-2.5 px-[14px] border-b border-amber-300 bg-amber-50 font-body text-xs leading-[1.5] text-amber-900">
            <span className="block font-mono text-[9px] font-semibold tracking-[0.05em] uppercase mb-1">
              Unavailable
            </span>
            {contract.availability.unavailableReason}
          </div>
        )}
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
