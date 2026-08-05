import React from "react";

/** Sparkline: 1D series → smooth line, 80x24 by default. */
export function Spark({
  data,
  w = 80,
  h = 24,
  stroke = "currentColor",
  fill = "none",
  strokeWidth = 1.5,
}: {
  data: number[];
  w?: number;
  h?: number;
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
}) {
  if (!data || !data.length) return null;
  const max = Math.max(...data),
    min = Math.min(...data);
  const range = max - min || 1;
  const dx = w / Math.max(1, data.length - 1);
  const pts = data.map((v, i) => [i * dx, h - ((v - min) / range) * (h - 2) - 1]);
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const area = `${d} L${w},${h} L0,${h} Z`;
  return (
    <svg width={w} height={h} className="block overflow-visible">
      {fill !== "none" && <path d={area} fill={fill} opacity="0.18" />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Area chart: 1D series → filled area with axis labels. */
export function AreaChart({
  data,
  w = 600,
  h = 180,
  stroke = "#3C43E7",
  fill = "#3C43E7",
  labels,
  grid = true,
  valueFmt = (v: number) => v,
}: {
  data: number[];
  w?: number;
  h?: number;
  stroke?: string;
  fill?: string;
  labels?: string[];
  grid?: boolean;
  valueFmt?: (v: number) => string | number;
}) {
  if (!data || !data.length) return null;
  const padL = 32,
    padR = 8,
    padT = 12,
    padB = 22;
  const iw = w - padL - padR,
    ih = h - padT - padB;
  const max = Math.max(...data),
    min = Math.min(0, Math.min(...data));
  const range = max - min || 1;
  const dx = iw / Math.max(1, data.length - 1);
  const yOf = (v: number) => padT + ih - ((v - min) / range) * ih;
  const xOf = (i: number) => padL + i * dx;
  const path = data.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i)},${yOf(v)}`).join(" ");
  const area = `${path} L${xOf(data.length - 1)},${padT + ih} L${padL},${padT + ih} Z`;
  const yTicks = [min, min + range / 2, max];
  return (
    <svg width={w} height={h} className="block overflow-visible">
      {grid &&
        yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={padL + iw} y1={yOf(v)} y2={yOf(v)} stroke="rgba(0,0,0,0.06)" strokeDasharray="2 3" />
            <text x={padL - 6} y={yOf(v) + 3} textAnchor="end" fontSize="9" fontFamily='"JetBrains Mono", monospace' fill="rgba(0,0,0,0.4)">
              {valueFmt(v)}
            </text>
          </g>
        ))}
      <path d={area} fill={fill} opacity="0.14" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" />
      {labels &&
        labels.map(
          (lbl, i) =>
            (i % 4 === 0 || i === labels.length - 1) && (
              <text key={i} x={xOf(i)} y={h - 4} textAnchor="middle" fontSize="9" fontFamily='"JetBrains Mono", monospace' fill="rgba(0,0,0,0.4)">
                {lbl}
              </text>
            ),
        )}
    </svg>
  );
}

/** Donut chart: shares array → ring with center text. */
export function Donut({
  shares,
  size = 120,
  thickness = 18,
  colors = ["#3C43E7", "#FD6027", "#FFC800", "#BBED80", "#181B20"],
  centerLabel,
  centerSub,
}: {
  shares: number[];
  size?: number;
  thickness?: number;
  colors?: string[];
  centerLabel?: string | number;
  centerSub?: string;
}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2,
    cy = size / 2;
  let acc = 0;
  return (
    <svg width={size} height={size} className="block overflow-visible">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth={thickness} />
      {shares.map((s, i) => {
        const len = s * c;
        const off = -acc * c;
        acc += s;
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={colors[i % colors.length]}
            strokeWidth={thickness}
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={off}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        );
      })}
      {centerLabel != null && (
        <text x={cx} y={centerSub ? cy - 6 : cy} textAnchor="middle" dominantBaseline="central" fontSize="18" fontFamily='"Manrope", sans-serif' fontWeight="600" fill="currentColor">
          {centerLabel}
        </text>
      )}
      {centerSub && (
        <text x={cx} y={cy + 11} textAnchor="middle" dominantBaseline="central" fontSize="9" fontFamily='"JetBrains Mono", monospace' fill="rgba(0,0,0,0.5)">
          {centerSub}
        </text>
      )}
    </svg>
  );
}
