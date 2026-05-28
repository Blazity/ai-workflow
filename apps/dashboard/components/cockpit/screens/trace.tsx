"use client";

// components/cockpit/screens/trace.tsx — Run trace screen.
// Renders the flame graph, span detail + evals, LLM I/O viewer, sandbox tests,
// and PR diff. Ported verbatim from variations/cockpit-screens.jsx (TraceScreen).

import React from "react";
import { FlameGraph } from "@/components/flame-graph";
import { ckBorder, ckMono, ckDisp, ckBody } from "@/lib/theme";
import { CkCard, CkKPI, CkChip, CkStatusPill } from "@/components/ui";
import { BarRow } from "@/components/charts";
import { AIWF_DATA } from "@/lib/data/mock";
import type { Run, Span } from "@/lib/types";

const D = AIWF_DATA;

/* ───────────────────── RUN TRACE ───────────────────── */

export function TraceScreen({ run, onBack }: { run: Run; onBack: () => void }) {
  const [selectedId, setSelectedId] = React.useState("s08");
  const span = D.TRACE.find((s) => s.id === selectedId) || D.TRACE[0];

  return (
    <div style={{ padding: "20px 24px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: ckBody, fontSize: 13 }}>
        <a onClick={onBack} style={{ fontFamily: ckMono, fontSize: 11, color: "#3C43E7", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.04em" }}>← Runs</a>
        <span style={{ color: "#D2D6DA" }}>/</span>
        <span style={{ fontFamily: ckMono, color: "#5F666F" }}>{run.id}</span>
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <CkStatusPill status={run.status} />
            <CkChip tone="mariner">{run.workflowName}</CkChip>
            <span style={{ fontFamily: ckMono, fontSize: 11, color: "#5F666F" }}>{run.ticket} · {run.actor}</span>
          </div>
          <h2 style={{ font: '500 24px/1.2 ' + ckDisp, margin: 0, color: "#181B20" }}>Add multi-currency support to checkout</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ appearance: "none", border: ckBorder, background: "#fff", padding: "8px 14px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, color: "#181B20", textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>Replay</button>
          <button style={{ appearance: "none", border: ckBorder, background: "#fff", padding: "8px 14px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, color: "#181B20", textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>Open in Vercel ↗</button>
          <button style={{ appearance: "none", border: "1px solid #181B20", background: "#181B20", color: "#fff", padding: "8px 14px", borderRadius: 3, fontFamily: ckMono, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>View PR ↗</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
        <CkKPI label="Duration" value="18.3s" sub="elapsed" />
        <CkKPI label="Tokens" value="24.5k" sub="in + out" />
        <CkKPI label="Cost" value="$0.34" sub="this run" />
        <CkKPI label="Spans" value="14" sub="3 LLM · 6 tool · 2 guard" />
        <CkKPI label="Eval score" value="94" sub="/ 100" />
      </div>

      <CkCard
        eyebrow="Arthur OpenInference trace"
        title="Span timeline"
        action={
        <div style={{ display: "flex", gap: 12, fontFamily: ckBody, fontSize: 12, color: "#5F666F" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, background: "#3C43E7", borderRadius: 1 }} />LLM</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, background: "#FD6027", borderRadius: 1 }} />Tool</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, background: "#FFC800", borderRadius: 1 }} />Guardrail</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, background: "#181B20", borderRadius: 1 }} />Workflow</span>
          </div>
        }>

        <div style={{ marginTop: 18 }}>
          <FlameGraph spans={D.TRACE} width={1080} rowH={22} gap={3} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      </CkCard>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
        <CkCard eyebrow={span.kind} title={span.name}>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 8, columnGap: 24, fontFamily: ckMono, fontSize: 12 }}>
            <span style={{ color: "#9EA3AA" }}>span_id</span><span style={{ color: "#181B20" }}>{span.id}</span>
            <span style={{ color: "#9EA3AA" }}>started_at</span><span style={{ color: "#181B20" }}>+{(span.start / 1000).toFixed(2)}s</span>
            <span style={{ color: "#9EA3AA" }}>duration</span><span style={{ color: "#181B20" }}>{span.duration}ms</span>
            <span style={{ color: "#9EA3AA" }}>status</span>
            <span>{span.status === "warn" ? <CkChip tone="warn">flag</CkChip> : <CkChip tone="success">ok</CkChip>}</span>
            {span.attrs && Object.entries(span.attrs).map(([k, v]) =>
            <React.Fragment key={k}>
                <span style={{ color: "#9EA3AA" }}>{k}</span>
                <span style={{ color: "#181B20", wordBreak: "break-all" }}>{String(v)}</span>
              </React.Fragment>
            )}
          </div>
        </CkCard>

        <CkCard eyebrow="Arthur" title="Span evaluations">
          {span.evals ?
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {Object.entries(span.evals).map(([k, v]) =>
            <BarRow key={k} label={k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
            value={typeof v === "number" ? v.toFixed(3) : v}
            max={1}
            color={v > 0.9 ? "#5BB04A" : v > 0.5 ? "#3C43E7" : "#FD6027"} />
            )}
              </div> :
          <div style={{ padding: "20px 0", textAlign: "center", color: "#9EA3AA", fontFamily: ckBody, fontSize: 13 }}>
                No evals run on this span kind.
              </div>}
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: ckBorder, fontFamily: ckMono, fontSize: 10, color: "#5F666F", letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Evaluator: arthur-engine v3.4 · openinference
          </div>
        </CkCard>
      </div>

      <CkLLMViewer span={span} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr", gap: 12 }}>
        <CkSandboxTests />
        <CkPRDiff />
      </div>
    </div>);

}

/* ── LLM I/O viewer (used by Trace) ── */

function CkLLMViewer({ span }: { span: Span }) {
  const [tab, setTab] = React.useState("prompt");
  if (span.kind !== "llm") return null;

  const PROMPT = `You are editing the file apps/web/checkout/Cart.tsx in the acme/storefront monorepo.

CONTEXT:
- ticket LIN-4521 "Add multi-currency support to checkout"
- prior plan span s04 outlined per-line-item currency persistence
- existing analytics events MUST be preserved (track:checkout_view, track:line_added)

INSTRUCTIONS:
1. Add a \`currency\` field to LineItem; default to cart.currency
2. Update <CurrencySelector/> to dispatch lineItem.update on change
3. Convert Subtotal to call formatMoney(amount, lineItem.currency)
4. Add tests in cart.spec.ts that cover EUR + JPY paths
5. Reply with the unified diff only — no commentary outside the patch

CONSTRAINTS:
- Do not introduce new dependencies
- Keep TypeScript strict; no \`any\`
- Match the project's existing Prettier config`;

  const COMPLETION = `\`\`\`diff
--- a/apps/web/checkout/Cart.tsx
+++ b/apps/web/checkout/Cart.tsx
@@
-type LineItem = { id: string; sku: string; qty: number; amount: number };
+type LineItem = { id: string; sku: string; qty: number; amount: number; currency: Currency };
@@
-  const subtotal = items.reduce((s, i) => s + i.amount * i.qty, 0);
-  return <span>{formatMoney(subtotal, cart.currency)}</span>;
+  return (
+    <ul className="subtotal">
+      {items.map((i) => (
+        <li key={i.id}>{formatMoney(i.amount * i.qty, i.currency)}</li>
+      ))}
+    </ul>
+  );
\`\`\`
+ 8 files changed · 142 added · 36 removed · ready for review`;

  const tabs = [
  { id: "prompt", label: "Prompt", sub: "4,280 tok in" },
  { id: "completion", label: "Completion", sub: "1,180 tok out" },
  { id: "messages", label: "Messages", sub: "3 turns" },
  { id: "tools", label: "Tool calls", sub: "2" }];


  return (
    <CkCard
      eyebrow="LLM I/O · arthur span"
      title={span.name}
      action={
      <div style={{ display: "inline-flex", gap: 2, padding: 3, background: "#F2F4F6", borderRadius: 4, border: ckBorder }}>
          {tabs.map((tb) =>
        <button key={tb.id} onClick={() => setTab(tb.id)} style={{
          appearance: "none", border: "none", cursor: "pointer",
          padding: "6px 12px", borderRadius: 3,
          background: tab === tb.id ? "#fff" : "transparent",
          boxShadow: tab === tb.id ? "0 1px 2px rgba(24,27,32,0.06)" : "none",
          color: tab === tb.id ? "#181B20" : "#5F666F",
          fontFamily: ckMono, fontWeight: 500, fontSize: 11,
          display: "inline-flex", alignItems: "center", gap: 6,
          letterSpacing: "-0.01em"
        }}>
              {tb.label}
              <span style={{ color: "#9EA3AA", fontWeight: 400, fontSize: 10 }}>{tb.sub}</span>
            </button>
        )}
        </div>
      }>

      <div style={{
        background: "#0E1014", color: "#E6E8EB",
        borderRadius: 3, padding: 16,
        fontFamily: ckMono, fontSize: 12, lineHeight: 1.65,
        whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto"
      }}>
        {tab === "prompt" && <span>{PROMPT}</span>}
        {tab === "completion" &&
        <span dangerouslySetInnerHTML={{
          __html: COMPLETION.
          replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").
          replace(/^(\+[^\n]*)$/gm, '<span style="color:#5BB04A">$1</span>').
          replace(/^(-[^\n]*)$/gm, '<span style="color:#D14343">$1</span>').
          replace(/^(@@[^\n]*@@)$/gm, '<span style="color:#FFC800">$1</span>').
          replace(/```diff/g, '<span style="color:#9EA3AA">```diff</span>').
          replace(/```$/gm, '<span style="color:#9EA3AA">```</span>')
        }} />
        }
        {tab === "messages" &&
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
          { role: "system", body: "You are an autonomous coding agent for ai-workflow. Reply with diffs only." },
          { role: "user", body: "Implement LIN-4521 from the plan in span s04." },
          { role: "assistant", body: "[tool: read_files] cart.tsx, useCart.ts, formatMoney.ts → [tool: write_diff] 9 files patched. PR opened." }].
          map((m, i) =>
          <div key={i}>
                <span style={{ color: "#FD6027", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10 }}>{m.role}</span>
                <div style={{ color: "#E6E8EB", marginTop: 2 }}>{m.body}</div>
              </div>
          )}
          </div>
        }
        {tab === "tools" &&
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div><span style={{ color: "#5BB04A" }}>● </span><span style={{ color: "#FFC800" }}>sandbox.fs.readMany</span>({'{ paths: ["cart.tsx","useCart.ts","formatMoney.ts"] }'}) <span style={{ color: "#9EA3AA" }}>→ 14 files · 82.4kb</span></div>
            <div><span style={{ color: "#5BB04A" }}>● </span><span style={{ color: "#FFC800" }}>sandbox.fs.writeMany</span>({'{ files: 9 }'}) <span style={{ color: "#9EA3AA" }}>→ ok</span></div>
          </div>
        }
      </div>
    </CkCard>);

}

/* ── Sandbox tests panel ── */

function CkSandboxTests() {
  const SUITE = [
  { f: "apps/web/checkout/cart.spec.ts", p: 28, fl: 0, t: 1240, hl: true },
  { f: "apps/web/checkout/currency.spec.ts", p: 14, fl: 0, t: 820, hl: true },
  { f: "packages/utils/formatMoney.spec.ts", p: 9, fl: 0, t: 110 },
  { f: "packages/utils/i18n.spec.ts", p: 36, fl: 0, t: 340 },
  { f: "apps/web/(rest of suite, 18 specs)", p: 225, fl: 0, t: 1610 }];

  const totalP = SUITE.reduce((a, s) => a + s.p, 0);
  return (
    <CkCard eyebrow="Vercel Sandbox · pnpm test" title="Test results" action={<CkChip tone="success">{totalP} passed · 0 failed</CkChip>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontFamily: ckMono, fontSize: 12 }}>
        {SUITE.map((s, i) =>
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: s.hl ? "#F6FAF1" : "#F9FAFB", borderRadius: 2, border: "1px solid " + (s.hl ? "#D7F4B3" : ckBorder) }}>
            <span style={{ color: "#5BB04A", fontSize: 14 }}>✓</span>
            <span style={{ flex: 1, color: "#181B20", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.f}</span>
            <span style={{ color: "#3F6B1E" }}>{s.p}</span>
            <span style={{ color: "#9EA3AA", fontSize: 11 }}>{s.t}ms</span>
          </div>
        )}
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: ckBorder, display: "flex", alignItems: "center", gap: 16, fontFamily: ckMono, fontSize: 10, color: "#5F666F", letterSpacing: "0.06em", textTransform: "uppercase" }}>
        <span>span s11 · sandbox.exec</span>
        <span style={{ marginLeft: "auto" }}>4.12s · 312 specs</span>
      </div>
    </CkCard>);

}

/* ── PR diff preview ── */

function CkPRDiff() {
  const DIFF = [
  { kind: "h", v: "diff --git a/apps/web/checkout/Cart.tsx b/apps/web/checkout/Cart.tsx" },
  { kind: "i", v: "@@ -12,7 +12,9 @@ type LineItem" },
  { kind: "x", v: "type LineItem = { id: string; sku: string; qty: number; amount: number };" },
  { kind: "a", v: "type LineItem = { id: string; sku: string; qty: number; amount: number; currency: Currency };" },
  { kind: "i", v: "@@ -48,5 +50,9 @@ function Subtotal()" },
  { kind: "x", v: "  const subtotal = items.reduce((s, i) => s + i.amount * i.qty, 0);" },
  { kind: "x", v: "  return <span>{formatMoney(subtotal, cart.currency)}</span>;" },
  { kind: "a", v: "  return (" },
  { kind: "a", v: "    <ul className=\"subtotal\">" },
  { kind: "a", v: "      {items.map((i) => (" },
  { kind: "a", v: "        <li key={i.id}>{formatMoney(i.amount * i.qty, i.currency)}</li>" },
  { kind: "a", v: "      ))}" },
  { kind: "a", v: "    </ul>" },
  { kind: "a", v: "  );" }];

  const color = (k: string) => k === "a" ? { bg: "#EAF7E0", fg: "#1C4A0E", pre: "+" } :
  k === "x" ? { bg: "#FCE6E2", fg: "#80261C", pre: "−" } :
  k === "i" ? { bg: "#F2F4F6", fg: "#5F666F", pre: " " } :
  { bg: "#181B20", fg: "#9EA3AA", pre: " " };
  return (
    <CkCard
      eyebrow="GitHub · pulls.create"
      title="PR #2147 · checkout: multi-currency support"
      action={
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <CkChip tone="success">+142 / −36</CkChip>
          <CkChip>9 files</CkChip>
          <a style={{ fontFamily: ckMono, fontSize: 11, color: "#3C43E7", textDecoration: "none", textTransform: "uppercase", letterSpacing: "0.04em", cursor: "pointer" }}>View on GitHub ↗</a>
        </div>
      }>

      <div style={{ fontFamily: ckMono, fontSize: 11, lineHeight: 1.55, border: ckBorder, borderRadius: 3, overflow: "hidden" }}>
        {DIFF.map((line, i) => {
          const c = color(line.kind);
          return (
            <div key={i} style={{ display: "flex", background: c.bg, color: c.fg }}>
              <span style={{ flex: "0 0 32px", textAlign: "right", padding: "2px 8px", color: "#9EA3AA", borderRight: ckBorder, userSelect: "none" }}>{i + 1}</span>
              <span style={{ flex: "0 0 16px", textAlign: "center", padding: "2px 0", fontWeight: 600 }}>{c.pre}</span>
              <span style={{ flex: 1, padding: "2px 8px", whiteSpace: "pre" }}>{line.v}</span>
            </div>);

        })}
      </div>
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: ckBorder, fontFamily: ckMono, fontSize: 10, color: "#5F666F", letterSpacing: "0.06em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 12 }}>
        <span>span s13 · github.pulls.create</span>
        <span style={{ marginLeft: "auto" }}>Awaiting review · sara.k</span>
      </div>
    </CkCard>);

}
