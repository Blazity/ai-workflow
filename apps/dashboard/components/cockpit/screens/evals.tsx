"use client";

import { CkCard, CkChip } from "@/components/ui";
import { Spark } from "@/components/charts";
import { AIWF_DATA } from "@/lib/data/mock";
import { jitterSeries } from "@/lib/rng";

const D = AIWF_DATA;

/* ───────────────────── ARTHUR EVALS ───────────────────── */

export function EvalsScreen() {
  const groups = ["safety", "quality", "ops"];
  return (
    <div className="flex flex-col gap-4 px-6 pt-5 pb-8">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Arthur engine · continuous evaluation</div>
          <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">Evaluations & guardrails</h2>
        </div>
        <div className="flex gap-2">
          <CkChip tone="success">Live · 12,408 spans · 24h</CkChip>
          <button className="appearance-none border border-neutral-200 bg-panel px-3.5 py-2 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer">+ New eval</button>
        </div>
      </div>

      {groups.map((g) => {
        const list = D.EVALS.filter((e) => e.axis === g);
        const titles: Record<string, string> = { safety: "Safety", quality: "Quality", ops: "Operations" };
        const accents: Record<string, string> = { safety: "#FD6027", quality: "#3C43E7", ops: "#181B20" };
        return (
          <CkCard key={g}
          eyebrow={g}
          title={titles[g]}
          action={<span className="font-mono text-[11px] text-neutral-700 uppercase tracking-[0.04em]">{list.length} evaluators</span>}
          style={{ borderLeft: "3px solid " + accents[g] }}
          pad={0}>

            <div className="grid grid-cols-2">
              {list.map((e, i) =>
              <div key={e.metric} className={`flex flex-col gap-2.5 px-5 py-4 ${i < list.length - (list.length % 2 === 0 ? 2 : 1) ? "border-b border-neutral-200" : ""} ${i % 2 === 0 ? "border-r border-neutral-200" : ""}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-body text-sm font-medium text-neutral-900">{e.metric}</span>
                    {e.status === "pass" ? <CkChip tone="success">Pass</CkChip> :
                  e.status === "warn" ? <CkChip tone="warn">Warn</CkChip> :
                  <CkChip tone="failed">Fail</CkChip>}
                  </div>
                  <div className="flex items-baseline gap-2.5">
                    <span className="font-display text-[28px] font-semibold leading-none tracking-[-0.02em] text-neutral-900">
                      {typeof e.value === "number" ? e.value < 1 ? e.value.toFixed(3) : e.value : e.value}
                    </span>
                    {e.unit && <span className="font-mono text-[11px] text-neutral-500">{e.unit}</span>}
                    <span className={`font-mono text-[11px] ml-auto ${e.trend < 0 ? "text-success-fg" : e.trend > 0 ? "text-fail-fg" : "text-neutral-500"}`}>
                      {e.trend > 0 ? "↗" : e.trend < 0 ? "↘" : "→"} {Math.abs(e.trend).toFixed(3)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Spark data={jitterSeries(i + 1, 24, (typeof e.value === "number" ? e.value : 0.5), 0.05)} w={140} h={22} stroke={accents[g]} fill={accents[g]} />
                    <span className="ml-auto font-mono text-[11px] text-neutral-500">target {e.target}</span>
                  </div>
                </div>
              )}
            </div>
          </CkCard>);

      })}
    </div>);

}
