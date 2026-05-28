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
    <div style={{ position: "relative", width, height }}>
      {/* timeline grid */}
      {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
        const x = t * width;
        const label = ((total * t) / 1000).toFixed(1) + "s";
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: -14,
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 9,
              color: dark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.45)",
            }}
          >
            {label}
          </div>
        );
      })}
      {[0.25, 0.5, 0.75].map((t, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: t * width,
            top: 0,
            bottom: 0,
            width: 1,
            background: dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)",
          }}
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
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: w,
              height: rowH,
              background: bg,
              color: "#fff",
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              padding: "0 6px",
              display: "flex",
              alignItems: "center",
              borderRadius: 2,
              cursor: "pointer",
              boxShadow: isSel ? "0 0 0 2px #fff, 0 0 0 4px " + bg : "none",
              opacity: 0.94,
              whiteSpace: "nowrap",
              overflow: "hidden",
              transition: "transform 120ms cubic-bezier(.2,0,0,1)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.94")}
            title={`${s.name} · ${s.duration}ms`}
          >
            {showLabels && w > 60 && <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>}
            {showLabels && w > 120 && <span style={{ marginLeft: "auto", opacity: 0.75, fontSize: 10 }}>{s.duration}ms</span>}
          </div>
        );
      })}
    </div>
  );
}
