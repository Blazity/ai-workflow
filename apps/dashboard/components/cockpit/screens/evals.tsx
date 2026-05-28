"use client";

// components/cockpit/screens/evals.tsx — Arthur evals & guardrails screen.
// Grouped evaluators (safety / quality / ops) with status, value, trend, spark.
// Ported verbatim from variations/cockpit-screens.jsx (EvalsScreen).

import { ckBorder, ckMono, ckDisp, ckBody } from "@/lib/theme";
import { CkCard, CkChip } from "@/components/ui";
import { Spark } from "@/components/charts";
import { AIWF_DATA } from "@/lib/data/mock";

const D = AIWF_DATA;

/* ───────────────────── ARTHUR EVALS ───────────────────── */

export function EvalsScreen() {
  const groups = ["safety", "quality", "ops"];
  return (
    <div style={{ padding: "20px 24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontFamily: ckMono, fontSize: 10, color: "#9EA3AA", letterSpacing: "0.06em", textTransform: "uppercase" }}>Arthur engine · continuous evaluation</div>
          <h2 style={{ font: '500 24px/1.2 ' + ckDisp, margin: 0, color: "#181B20" }}>Evaluations & guardrails</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <CkChip tone="success">Live · 12,408 spans · 24h</CkChip>
          <button style={{ appearance: "none", border: ckBorder, background: "#fff", padding: "8px 14px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, color: "#181B20", textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>+ New eval</button>
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
          action={<span style={{ fontFamily: ckMono, fontSize: 11, color: "#5F666F", letterSpacing: "0.04em", textTransform: "uppercase" }}>{list.length} evaluators</span>}
          style={{ borderLeft: "3px solid " + accents[g] }}
          pad={0}>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)" }}>
              {list.map((e, i) =>
              <div key={e.metric} style={{
                padding: "16px 20px",
                borderBottom: i < list.length - (list.length % 2 === 0 ? 2 : 1) ? ckBorder : "none",
                borderRight: i % 2 === 0 ? ckBorder : "none",
                display: "flex", flexDirection: "column", gap: 10
              }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontFamily: ckBody, fontSize: 14, fontWeight: 500, color: "#181B20" }}>{e.metric}</span>
                    {e.status === "pass" ? <CkChip tone="success">Pass</CkChip> :
                  e.status === "warn" ? <CkChip tone="warn">Warn</CkChip> :
                  <CkChip tone="failed">Fail</CkChip>}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                    <span style={{ font: '600 28px/1 ' + ckDisp, letterSpacing: "-0.02em", color: "#181B20" }}>
                      {typeof e.value === "number" ? e.value < 1 ? e.value.toFixed(3) : e.value : e.value}
                    </span>
                    {e.unit && <span style={{ fontFamily: ckMono, fontSize: 11, color: "#9EA3AA" }}>{e.unit}</span>}
                    <span style={{ fontFamily: ckMono, fontSize: 11, color: e.trend < 0 ? "#3F6B1E" : e.trend > 0 ? "#A2351C" : "#9EA3AA", marginLeft: "auto" }}>
                      {e.trend > 0 ? "↗" : e.trend < 0 ? "↘" : "→"} {Math.abs(e.trend).toFixed(3)}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Spark data={Array.from({ length: 24 }, () => (e.value || 0.5) + (Math.random() - 0.5) * 0.05)} w={140} h={22} stroke={accents[g]} fill={accents[g]} />
                    <span style={{ marginLeft: "auto", fontFamily: ckMono, fontSize: 11, color: "#9EA3AA" }}>target {e.target}</span>
                  </div>
                </div>
              )}
            </div>
          </CkCard>);

      })}
    </div>);

}
