"use client";

import React from "react";
import { CkCard, CkKPI } from "@/components/ui";
import { AreaChart } from "@/components/charts";
import type { CostResponse } from "@shared/contracts";

/** Short label from an ISO/bucket date string for the daily-spend x-axis. */
function shortDate(date: string): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function CostScreen({ data }: { data: CostResponse }) {
  if (!data.available) {
    return (
      <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
        <div className="flex items-end justify-between">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Arthur · token usage</div>
            <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">Cost & token usage</h2>
          </div>
        </div>
        <div className="bg-panel border border-neutral-200 rounded-sm px-5 py-8 font-body text-sm text-neutral-500">
          Cost data is unavailable — Arthur GenAI Engine is not configured or unreachable.
        </div>
      </div>
    );
  }

  const { totals, byWorkflow, daily } = data;
  const total = totals.totalTokenCost;

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6 pt-5 pb-8">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Arthur · token usage</div>
          <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">Cost & token usage</h2>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5 lg:gap-3">
        <CkKPI label="MTD spend" value={"$" + total.toFixed(2)} />
        <CkKPI label="Tokens · MTD" value={(totals.totalTokens / 1_000_000).toFixed(2) + "M"} />
        <CkKPI label="Cost / run avg" value={"$" + totals.costPerRun.toFixed(2)} sub="all workflows" />
      </div>

      <CkCard eyebrow="Spend trajectory" title="Daily spend · MTD">
          {daily.length > 0 ? (
            <div className="overflow-x-auto">
              <AreaChart
                data={daily.map((d) => d.cost)}
                w={680}
                h={200}
                stroke="#FD6027"
                fill="#FD6027"
                labels={daily.map((d) => shortDate(d.date))}
                valueFmt={(v) => "$" + Math.round(Number(v))}
              />
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-neutral-500 text-sm">No spend data</div>
          )}
      </CkCard>

      <CkCard eyebrow="Per-workflow breakdown" title="Where the spend is going" pad={0}>
        {byWorkflow.length > 0 ? (
          <div className="overflow-x-auto">
          <table className="w-full border-collapse font-body text-[13px]">
            <thead>
              <tr className="bg-neutral-100 text-neutral-700 font-mono text-[10px] uppercase tracking-[0.06em]">
                {["Workflow", "Runs", "Tokens", "Cost", "$/run"].map((h, i) =>
                  <th key={i} className={`px-4 py-2.5 font-medium border-b border-neutral-200 ${i >= 1 ? "text-right" : "text-left"}`}>{h}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {[...byWorkflow].sort((a, b) => b.cost - a.cost).map((w, i, arr) =>
                <tr key={w.taskId} className={i < arr.length - 1 ? "border-b border-neutral-200" : ""}>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-neutral-900">{w.name}</span>
                    <div className="text-[11px] text-neutral-500 font-mono mt-0.5">{w.taskId}</div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{w.runs.toLocaleString("en-US")}</td>
                  <td className="px-4 py-3 text-right font-mono text-neutral-700">{(w.tokens / 1000).toFixed(0)}k</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold">${w.cost.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right font-mono text-neutral-700">${w.costPerRun.toFixed(3)}</td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        ) : (
          <div className="px-5 py-10 text-center text-neutral-500 text-sm">No workflow breakdown available</div>
        )}
      </CkCard>
    </div>
  );
}
