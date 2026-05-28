"use client";

import React from "react";
import { CkCard, CkKPI, CkChip, CkTabs, CkDot } from "@/components/ui";
import { Spark, AreaChart, Donut } from "@/components/charts";
import { AIWF_DATA } from "@/lib/data/mock";
import { sparkSeries } from "@/lib/rng";

const D = AIWF_DATA;

export function CostScreen() {
  const total = D.COST_BY_MODEL.reduce((a, m) => a + m.cost, 0);
  const tokensTotal = D.COST_BY_MODEL.reduce((a, m) => a + m.tokens, 0);
  return (
    <div className="flex flex-col gap-4 px-6 pt-5 pb-8">
      <div className="flex items-end justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-neutral-500">Vercel ai gateway · billing</div>
          <h2 className="font-display text-2xl font-medium leading-[1.2] text-neutral-900 m-0">Cost & token usage</h2>
        </div>
        <div className="flex gap-2">
          <CkTabs active="model" onChange={() => {}} tabs={[
            { id: "model", label: "By model" }, { id: "wf", label: "By workflow" }, { id: "actor", label: "By actor" }]
          } />
          <button className="appearance-none border border-neutral-200 bg-panel px-3 py-1.5 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer">Export CSV</button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <CkKPI label="MTD spend" value={"$" + total.toFixed(2)} sub="of $1,200 budget" delta="↗ +18% MoM" deltaTone="bad" />
        <CkKPI label="Tokens · MTD" value={(tokensTotal / 1_000_000).toFixed(2) + "M"} delta="↗ +24% MoM" deltaTone="bad" />
        <CkKPI label="Cost / run avg" value="$0.41" sub="all workflows" delta="↘ −$0.03 WoW" deltaTone="good" />
        <CkKPI label="Projection · EoM" value="$1,184" sub="98.7% of budget" delta="⚠ tight" deltaTone="bad" />
      </div>

      <div className="grid grid-cols-[1.5fr_1fr] gap-3">
        <CkCard eyebrow="Spend trajectory" title="Daily spend · MTD"
          action={<CkTabs active="cost" onChange={() => {}} tabs={[{ id: "cost", label: "Cost" }, { id: "tokens", label: "Tokens" }]} />}>
          <AreaChart data={D.HOURS24.map((h) => h.cost * 24)} w={680} h={200} stroke="#FD6027" fill="#FD6027" labels={D.HOURS24.map((_, i) => "D" + (i + 1))} valueFmt={(v) => "$" + Math.round(v)} />
        </CkCard>

        <CkCard eyebrow="Vercel AI Gateway" title="Model mix">
          <div className="flex items-center gap-[18px]">
            <Donut shares={D.COST_BY_MODEL.map((m) => m.share)} size={140} thickness={22} colors={["#3C43E7", "#FD6027", "#FFC800", "#181B20", "#8FC548"]} centerLabel={"$" + Math.round(total)} centerSub="MTD" />
            <div className="flex flex-1 flex-col gap-2.5">
              {D.COST_BY_MODEL.map((m, i) =>
                <div key={m.model} className="flex items-center gap-2 font-body text-xs">
                  <CkDot color={["#3C43E7", "#FD6027", "#FFC800", "#181B20", "#8FC548"][i]} />
                  <span className="flex-1 font-mono text-neutral-900">{m.model}</span>
                  <span className="font-mono font-medium text-neutral-700">${m.cost.toFixed(0)}</span>
                </div>
              )}
            </div>
          </div>
        </CkCard>
      </div>

      <CkCard eyebrow="Per-model breakdown" title="Spend & throughput" pad={0}>
        <table className="w-full border-collapse font-body text-[13px]">
          <thead>
            <tr className="bg-neutral-100 text-neutral-700 font-mono text-[10px] uppercase tracking-[0.06em]">
              {["Model", "Vendor", "Tokens", "Cost", "Share", "Trend"].map((h, i) =>
                <th key={i} className={`px-4 py-2.5 font-medium border-b border-neutral-200 ${i >= 2 ? "text-right" : "text-left"}`}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {D.COST_BY_MODEL.map((m, i) =>
              <tr key={m.model} className={i < D.COST_BY_MODEL.length - 1 ? "border-b border-neutral-200" : ""}>
                <td className="px-4 py-3 font-mono font-medium text-neutral-900">{m.model}</td>
                <td className="px-4 py-3 font-body text-neutral-700">{m.vendor}</td>
                <td className="px-4 py-3 text-right font-mono">{(m.tokens / 1_000_000).toFixed(2)}M</td>
                <td className="px-4 py-3 text-right font-mono font-semibold">${m.cost.toFixed(2)}</td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    <div className="w-20 h-1.5 bg-app-bg rounded-[1px]">
                      <div className="h-full bg-mariner rounded-[1px]" style={{ width: m.share * 100 + "%" }} />
                    </div>
                    <span className="font-mono text-[11px] w-9 text-right">{(m.share * 100).toFixed(0)}%</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-neutral-700">
                  <Spark data={sparkSeries(i + 1, 14, 0.5, 1)} w={80} h={20} stroke="#3C43E7" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CkCard>

      <CkCard eyebrow="Per-workflow breakdown" title="Where the spend is going" pad={0}>
        <table className="w-full border-collapse font-body text-[13px]">
          <thead>
            <tr className="bg-neutral-100 text-neutral-700 font-mono text-[10px] uppercase tracking-[0.06em]">
              {["Workflow", "Runs 24h", "Tokens", "Cost today", "$/run", "Trend"].map((h, i) =>
                <th key={i} className={`px-4 py-2.5 font-medium border-b border-neutral-200 ${i >= 1 ? "text-right" : "text-left"}`}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {D.WORKFLOWS.slice().sort((a, b) => b.costToday - a.costToday).map((w, i, arr) => {
              const tokens = Math.round(w.runs24h * 2400);
              const perRun = w.costToday / Math.max(1, w.runs24h);
              const trendUp = i % 2 === 0;
              return (
                <tr key={w.id} className={i < arr.length - 1 ? "border-b border-neutral-200" : ""}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-neutral-900">{w.name}</span>
                      {w.primary && <CkChip tone="mariner">primary</CkChip>}
                    </div>
                    <div className="text-[11px] text-neutral-500 font-mono mt-0.5">{w.id} · gateway: {w.gateway}</div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">{w.runs24h.toLocaleString("en-US")}</td>
                  <td className="px-4 py-3 text-right font-mono text-neutral-700">{(tokens / 1000).toFixed(0)}k</td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2 justify-end">
                      <div className="w-[100px] h-1.5 bg-app-bg rounded-[1px]">
                        <div className="h-full bg-burnt-orange rounded-[1px]" style={{ width: Math.min(100, w.costToday / 200 * 100) + "%" }} />
                      </div>
                      <span className="font-mono font-semibold w-16 text-right">${w.costToday.toFixed(2)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-neutral-700">${perRun.toFixed(3)}</td>
                  <td className="px-4 py-3 text-right text-neutral-700">
                    <Spark data={sparkSeries(100 + i, 14, 0.4, 0.8)} w={80} h={20} stroke={trendUp ? "#D14343" : "#5BB04A"} />
                  </td>
                </tr>);

            })}
          </tbody>
        </table>
      </CkCard>
    </div>
  );
}
