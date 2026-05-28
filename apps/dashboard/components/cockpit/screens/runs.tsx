"use client";

import React, { useState } from "react";
import { CkCard, CkChip, CkStatusPill, CkTabs, TicketLink, PRLink } from "@/components/ui";
import { ckBorder, ckMono, ckDisp, ckBody } from "@/lib/theme";
import { AIWF_DATA } from "@/lib/data/mock";
import type { Run } from "@/lib/types";

const D = AIWF_DATA;

export function RunsScreen({ onOpenRun }: { onOpenRun: (run: Run) => void }) {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? D.RUNS : D.RUNS.filter((r) => r.status === filter);

  return (
    <div style={{ padding: "20px 24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontFamily: ckMono, fontSize: 10, color: "#9EA3AA", letterSpacing: "0.06em", textTransform: "uppercase" }}>Workflow runs</div>
          <h2 style={{ font: '500 24px/1.2 ' + ckDisp, margin: 0, color: "#181B20" }}>{D.RUNS.length} runs · last 24h</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <CkTabs active={filter} onChange={setFilter} tabs={[
            { id: "all", label: "All" },
            { id: "success", label: "Success" },
            { id: "running", label: "Running" },
            { id: "awaiting", label: "Awaiting input" },
            { id: "failed", label: "Failed" },
            { id: "blocked", label: "Blocked" }]
          } />
          <button style={{ appearance: "none", border: ckBorder, background: "#fff", padding: "6px 12px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, color: "#181B20", textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>+ Filter</button>
          <button style={{ appearance: "none", border: "1px solid #181B20", background: "#181B20", color: "#fff", padding: "6px 12px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>Export ↓</button>
        </div>
      </div>

      <CkCard pad={0}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: ckBody, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F9FAFB", color: "#5F666F", fontFamily: ckMono, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {["Status", "Ticket · title", "Workflow", "Model", "Started", "Duration", "Tokens", "Cost", "Eval", "Guard"].map((h, i) =>
                <th key={i} style={{ padding: "10px 12px", textAlign: i >= 4 ? "right" : "left", fontWeight: 500, borderBottom: ckBorder, whiteSpace: "nowrap" }}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) =>
              <tr key={r.id} onClick={() => onOpenRun(r)} style={{ borderBottom: i < filtered.length - 1 ? ckBorder : "none", cursor: "pointer" }}
                onMouseEnter={(e) => e.currentTarget.style.background = "#F9FAFB"}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                <td style={{ padding: "10px 12px" }}><CkStatusPill status={r.status} /></td>
                <td style={{ padding: "10px 12px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontWeight: 600, color: "#181B20", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{r.ticketTitle}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <TicketLink ticket={r.ticket} url={r.ticketUrl} />
                      {r.prNumber && r.prUrl && <PRLink num={r.prNumber} url={r.prUrl} />}
                      <span style={{ fontFamily: ckMono, fontSize: 10, color: "#9EA3AA" }}>{r.id}</span>
                    </div>
                  </div>
                </td>
                <td style={{ padding: "10px 12px" }}>
                  <CkChip style={{ background: "#F2F4F6", color: "#3E444C" }}>{r.workflowName}</CkChip>
                </td>
                <td style={{ padding: "10px 12px", fontFamily: ckMono, fontSize: 11, color: "#5F666F" }}>{r.model}</td>
                <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: ckMono, fontSize: 11, color: "#9EA3AA" }}>{r.startedAtMin}m ago</td>
                <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: ckMono, fontWeight: 500 }}>{r.duration ? r.duration + "s" : "—"}</td>
                <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: ckMono, color: "#5F666F" }}>{(r.tokens / 1000).toFixed(1)}k</td>
                <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: ckMono, fontWeight: 500 }}>${r.cost.toFixed(2)}</td>
                <td style={{ padding: "10px 12px", textAlign: "right" }}>
                  {r.evalScore ?
                    <span style={{ fontFamily: ckMono, fontSize: 11, color: r.evalScore > 0.9 ? "#3F6B1E" : r.evalScore > 0.85 ? "#7A5A00" : "#A2351C", fontWeight: 600 }}>{(r.evalScore * 100).toFixed(0)}</span> :
                    <span style={{ fontFamily: ckMono, fontSize: 11, color: "#D2D6DA" }}>—</span>}
                </td>
                <td style={{ padding: "10px 12px", textAlign: "right" }}>
                  {r.guardrailHits > 0 ?
                    <CkChip tone="warn">{r.guardrailHits}</CkChip> :
                    <span style={{ fontFamily: ckMono, fontSize: 11, color: "#D2D6DA" }}>—</span>}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CkCard>
    </div>
  );
}
