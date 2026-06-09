"use client";

import { CkCard, CkChip } from "@/components/ui";
import type { EvalsResponse } from "@shared/contracts";

const QUALITY_ACCENT = "#3C43E7";

/* ───────────────────── ARTHUR EVALS ───────────────────── */

function Header({ chip }: { chip: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Arthur engine · continuous evaluation</div>
        <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">Evaluations & guardrails</h2>
      </div>
      <div className="flex gap-2">{chip}</div>
    </div>
  );
}

export function EvalsScreen({ data }: { data: EvalsResponse }) {
  if (!data.available) {
    return (
      <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
        <Header chip={<CkChip tone="neutral">No data</CkChip>} />
        <div className="bg-panel border border-neutral-200 rounded-sm px-5 py-8 font-body text-sm text-neutral-500">
          {data.reason}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
      <Header
        chip={
          <CkChip tone="success">
            Live · {data.spansGraded.toLocaleString("en-US")} spans · {data.windowHours}h
          </CkChip>
        }
      />

      <CkCard
        eyebrow="quality"
        title="Quality"
        action={
          <span className="font-mono text-[11px] text-neutral-700 uppercase tracking-[0.04em]">
            {data.score.toFixed(1)}% pass
          </span>
        }
        style={{ borderLeft: "3px solid " + QUALITY_ACCENT }}>

        <div className="flex items-baseline gap-2.5">
          <span className="font-display text-[28px] font-semibold leading-none tracking-[-0.02em] text-neutral-900">
            {data.score.toFixed(1)}%
          </span>
          <span className="font-mono text-[11px] text-neutral-500">
            {data.spansGraded.toLocaleString("en-US")} spans graded · {data.traceCount.toLocaleString("en-US")} traces · {data.windowHours}h
          </span>
        </div>
      </CkCard>
    </div>);

}
