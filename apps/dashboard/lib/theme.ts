import type { SpanKind } from "@shared/contracts";

/** Span-kind colors used by the flame graph and the "Now running" panel. */
export const SPAN_KIND_COLOR: Record<SpanKind, string> = {
  workflow: "#181B20",
  llm: "#3C43E7",
  tool: "#FD6027",
  guardrail: "#FFC800",
  retrieval: "#8FC548",
};

export const spanColor = (kind?: SpanKind): string =>
  kind ? SPAN_KIND_COLOR[kind] : "#5F666F";
