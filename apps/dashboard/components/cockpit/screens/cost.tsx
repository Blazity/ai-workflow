"use client";

import React from "react";
import { CkCard, CkKPI, CkChip, CkTabs, CkDot } from "@/components/ui";
import { Spark, AreaChart, Donut } from "@/components/charts";
import { ckBorder, ckMono, ckDisp, ckBody } from "@/lib/theme";
import { AIWF_DATA } from "@/lib/data/mock";

const D = AIWF_DATA;

export function CostScreen() {
  const total = D.COST_BY_MODEL.reduce((a, m) => a + m.cost, 0);
  const tokensTotal = D.COST_BY_MODEL.reduce((a, m) => a + m.tokens, 0);
  return (
    <div style={{ padding: "20px 24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontFamily: ckMono, fontSize: 10, color: "#9EA3AA", letterSpacing: "0.06em", textTransform: "uppercase" }}>Vercel ai gateway · billing</div>
          <h2 style={{ font: '500 24px/1.2 ' + ckDisp, margin: 0, color: "#181B20" }}>Cost & token usage</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <CkTabs active="model" onChange={() => {}} tabs={[
            { id: "model", label: "By model" }, { id: "wf", label: "By workflow" }, { id: "actor", label: "By actor" }]
          } />
          <button style={{ appearance: "none", border: ckBorder, background: "#fff", padding: "6px 12px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, color: "#181B20", textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>Export CSV</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <CkKPI label="MTD spend" value={"$" + total.toFixed(2)} sub="of $1,200 budget" delta="↗ +18% MoM" deltaTone="bad" />
        <CkKPI label="Tokens · MTD" value={(tokensTotal / 1_000_000).toFixed(2) + "M"} delta="↗ +24% MoM" deltaTone="bad" />
        <CkKPI label="Cost / run avg" value="$0.41" sub="all workflows" delta="↘ −$0.03 WoW" deltaTone="good" />
        <CkKPI label="Projection · EoM" value="$1,184" sub="98.7% of budget" delta="⚠ tight" deltaTone="bad" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 12 }}>
        <CkCard eyebrow="Spend trajectory" title="Daily spend · MTD"
          action={<CkTabs active="cost" onChange={() => {}} tabs={[{ id: "cost", label: "Cost" }, { id: "tokens", label: "Tokens" }]} />}>
          <AreaChart data={D.HOURS24.map((h) => h.cost * 24)} w={680} h={200} stroke="#FD6027" fill="#FD6027" labels={D.HOURS24.map((_, i) => "D" + (i + 1))} valueFmt={(v) => "$" + Math.round(v)} />
        </CkCard>

        <CkCard eyebrow="Vercel AI Gateway" title="Model mix">
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <Donut shares={D.COST_BY_MODEL.map((m) => m.share)} size={140} thickness={22} colors={["#3C43E7", "#FD6027", "#FFC800", "#181B20", "#8FC548"]} centerLabel={"$" + Math.round(total)} centerSub="MTD" />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
              {D.COST_BY_MODEL.map((m, i) =>
                <div key={m.model} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: ckBody, fontSize: 12 }}>
                  <CkDot color={["#3C43E7", "#FD6027", "#FFC800", "#181B20", "#8FC548"][i]} />
                  <span style={{ flex: 1, fontFamily: ckMono, color: "#181B20" }}>{m.model}</span>
                  <span style={{ fontFamily: ckMono, color: "#5F666F", fontWeight: 500 }}>${m.cost.toFixed(0)}</span>
                </div>
              )}
            </div>
          </div>
        </CkCard>
      </div>

      <CkCard eyebrow="Per-model breakdown" title="Spend & throughput" pad={0}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: ckBody, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F9FAFB", color: "#5F666F", fontFamily: ckMono, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {["Model", "Vendor", "Tokens", "Cost", "Share", "Trend"].map((h, i) =>
                <th key={i} style={{ padding: "10px 16px", textAlign: i >= 2 ? "right" : "left", fontWeight: 500, borderBottom: ckBorder }}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {D.COST_BY_MODEL.map((m, i) =>
              <tr key={m.model} style={{ borderBottom: i < D.COST_BY_MODEL.length - 1 ? ckBorder : "none" }}>
                <td style={{ padding: "12px 16px", fontFamily: ckMono, fontWeight: 500, color: "#181B20" }}>{m.model}</td>
                <td style={{ padding: "12px 16px", fontFamily: ckBody, color: "#5F666F" }}>{m.vendor}</td>
                <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: ckMono }}>{(m.tokens / 1_000_000).toFixed(2)}M</td>
                <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: ckMono, fontWeight: 600 }}>${m.cost.toFixed(2)}</td>
                <td style={{ padding: "12px 16px", textAlign: "right" }}>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 80, height: 6, background: "#F2F4F6", borderRadius: 1 }}>
                      <div style={{ width: m.share * 100 + "%", height: "100%", background: "#3C43E7", borderRadius: 1 }} />
                    </div>
                    <span style={{ fontFamily: ckMono, fontSize: 11, width: 36, textAlign: "right" }}>{(m.share * 100).toFixed(0)}%</span>
                  </div>
                </td>
                <td style={{ padding: "12px 16px", textAlign: "right", color: "#5F666F" }}>
                  <Spark data={Array.from({ length: 14 }, () => 0.5 + Math.random())} w={80} h={20} stroke="#3C43E7" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CkCard>

      <CkCard eyebrow="Per-workflow breakdown" title="Where the spend is going" pad={0}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: ckBody, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F9FAFB", color: "#5F666F", fontFamily: ckMono, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {["Workflow", "Runs 24h", "Tokens", "Cost today", "$/run", "Trend"].map((h, i) =>
                <th key={i} style={{ padding: "10px 16px", textAlign: i >= 1 ? "right" : "left", fontWeight: 500, borderBottom: ckBorder }}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {D.WORKFLOWS.slice().sort((a, b) => b.costToday - a.costToday).map((w, i, arr) => {
              const tokens = Math.round(w.runs24h * 2400);
              const perRun = w.costToday / Math.max(1, w.runs24h);
              const trendUp = i % 2 === 0;
              return (
                <tr key={w.id} style={{ borderBottom: i < arr.length - 1 ? ckBorder : "none" }}>
                  <td style={{ padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600, color: "#181B20" }}>{w.name}</span>
                      {w.primary && <CkChip tone="mariner">primary</CkChip>}
                    </div>
                    <div style={{ fontSize: 11, color: "#9EA3AA", fontFamily: ckMono, marginTop: 2 }}>{w.id} · gateway: {w.gateway}</div>
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: ckMono }}>{w.runs24h.toLocaleString()}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: ckMono, color: "#5F666F" }}>{(tokens / 1000).toFixed(0)}k</td>
                  <td style={{ padding: "12px 16px", textAlign: "right" }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                      <div style={{ width: 100, height: 6, background: "#F2F4F6", borderRadius: 1 }}>
                        <div style={{ width: Math.min(100, w.costToday / 200 * 100) + "%", height: "100%", background: "#FD6027", borderRadius: 1 }} />
                      </div>
                      <span style={{ fontFamily: ckMono, fontWeight: 600, width: 64, textAlign: "right" }}>${w.costToday.toFixed(2)}</span>
                    </div>
                  </td>
                  <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: ckMono, color: "#5F666F" }}>${perRun.toFixed(3)}</td>
                  <td style={{ padding: "12px 16px", textAlign: "right", color: "#5F666F" }}>
                    <Spark data={Array.from({ length: 14 }, () => 0.4 + Math.random() * 0.8)} w={80} h={20} stroke={trendUp ? "#D14343" : "#5BB04A"} />
                  </td>
                </tr>);

            })}
          </tbody>
        </table>
      </CkCard>
    </div>
  );
}
