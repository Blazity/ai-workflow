import type { SpanKind } from "@shared/contracts";

export type {
  RunStatus,
  SpanKind,
  Run,
} from "@shared/contracts";

export type SpanStatus = "ok" | "warn" | "error";

export interface Span {
  id: string;
  parent: string | null;
  name: string;
  kind: SpanKind;
  start: number;
  duration: number;
  status: SpanStatus;
  attrs?: Record<string, string | number>;
  evals?: Record<string, number>;
}
