"use client";

import React from "react";
import { SPAN_KIND_COLOR } from "@/lib/theme";
import type { Span } from "@/lib/types";

function flameLayout(spans: Span[]) {
  const byId: Record<string, Span> = Object.fromEntries(spans.map((s) => [s.id, s]));
  const depthOf: Record<string, number> = {};
  function d(id: string): number {
    if (id in depthOf) return depthOf[id];
    const s = byId[id];
    if (!s || !s.parent) return (depthOf[id] = 0);
    return (depthOf[id] = d(s.parent) + 1);
  }
  spans.forEach((s) => d(s.id));
  const total = Math.max(...spans.map((s) => s.start + s.duration));
  return { byId, depthOf, total };
}

export function FlameGraph({
  spans,
  width = 880,
  rowH = 26,
  gap = 2,
  selectedId,
  onSelect,
  dark = false,
  showLabels = true,
}: {
  spans: Span[];
  width?: number;
  rowH?: number;
  gap?: number;
  selectedId?: string;
  onSelect?: (id: string) => void;
  dark?: boolean;
  showLabels?: boolean;
}) {
  const { depthOf, total } = flameLayout(spans);
  const maxDepth = Math.max(...Object.values(depthOf)) + 1;
  const height = maxDepth * (rowH + gap);

  return (
    <div className="relative" style={{ width, height }}>
      {/* timeline grid */}
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
        const x = t * width;
        const label = ((total * t) / 1000).toFixed(1) + "s";
        return (
          <div
            key={i}
            className={`absolute -top-3.5 font-mono text-[9px] ${dark ? "text-white/40" : "text-black/45"}`}
            style={{ left: x }}
          >
            {label}
          </div>
        );
      })}
      {[0.25, 0.5, 0.75].map((t, i) => (
        <div
          key={i}
          className={`absolute top-0 bottom-0 w-px ${dark ? "bg-white/5" : "bg-black/5"}`}
          style={{ left: t * width }}
        />
      ))}
      {spans.map((s) => {
        const x = (s.start / total) * width;
        const w = Math.max(2, (s.duration / total) * width - 1);
        const y = depthOf[s.id] * (rowH + gap);
        const isSel = selectedId === s.id;
        const baseBg = SPAN_KIND_COLOR[s.kind];
        const isWarn = s.status === "warn";
        const isErr = s.status === "error";
        const bg = isErr ? "#D14343" : isWarn ? "#FD6027" : baseBg;
        return (
          <div
            key={s.id}
            onClick={() => onSelect && onSelect(s.id)}
            className="absolute text-white font-mono text-[11px] px-1.5 flex items-center rounded-xs cursor-pointer opacity-95 hover:opacity-100 whitespace-nowrap overflow-hidden transition-transform duration-[120ms] ease-[cubic-bezier(.2,0,0,1)]"
            style={{
              left: x,
              top: y,
              width: w,
              height: rowH,
              background: bg,
              boxShadow: isSel ? "0 0 0 2px #fff, 0 0 0 4px " + bg : "none",
            }}
            title={`${s.name} · ${s.duration}ms`}
          >
            {showLabels && w > 60 && <span className="overflow-hidden text-ellipsis">{s.name}</span>}
            {showLabels && w > 120 && <span className="ml-auto opacity-75 text-[10px]">{s.duration}ms</span>}
          </div>
        );
      })}
    </div>
  );
}
