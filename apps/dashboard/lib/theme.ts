import type { SpanKind } from "@shared/contracts";

export const ckBorder = "1px solid #E6E8EB";
export const ckMono = '"JetBrains Mono", monospace';
export const ckDisp = '"Manrope", system-ui, sans-serif';
export const ckBody = '"Inter", system-ui, sans-serif';

export const APP_BG = "#F2F4F6";
export const PANEL_BG = "#FFFFFF";

/** Span-kind colors used by the flame graph and the "Now running" panel. */
export const SPAN_KIND_COLOR: Record<SpanKind, string> = {
  workflow: "#181B20",
  llm: "#3C43E7",
  tool: "#FD6027",
  guardrail: "#FFC800",
  retrieval: "#8FC548",
};

export const SPAN_KIND_LIGHT: Record<SpanKind, string> = {
  workflow: "rgba(24,27,32,0.12)",
  llm: "rgba(60,67,231,0.14)",
  tool: "rgba(253,96,39,0.16)",
  guardrail: "rgba(255,200,0,0.22)",
  retrieval: "rgba(143,197,72,0.18)",
};

export const spanColor = (kind?: SpanKind): string =>
  kind ? SPAN_KIND_COLOR[kind] : "#5F666F";
