"use client";

import React from "react";
import { FlameGraph } from "@/components/flame-graph";
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
    <div className="px-6 pt-5 pb-8 flex flex-col gap-4">
      <div className="flex items-center gap-3 font-body text-[13px]">
        <a onClick={onBack} className="font-mono text-[11px] text-mariner cursor-pointer uppercase tracking-[0.04em]">← Runs</a>
        <span className="text-[#D2D6DA]">/</span>
        <span className="font-mono text-neutral-700">{run.id}</span>
      </div>

      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <CkStatusPill status={run.status} />
            <CkChip tone="mariner">{run.workflowName}</CkChip>
            <span className="font-mono text-[11px] text-neutral-700">{run.ticket} · {run.actor}</span>
          </div>
          <h2 className="font-display font-medium text-2xl leading-[1.2] m-0 text-neutral-900">Add multi-currency support to checkout</h2>
        </div>
        <div className="flex gap-2">
          <button className="appearance-none border border-neutral-200 bg-panel px-3.5 py-2 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer">Replay</button>
          <button className="appearance-none border border-neutral-200 bg-panel px-3.5 py-2 rounded-[3px] font-mono text-[11px] text-neutral-900 uppercase tracking-[0.04em] cursor-pointer">Open in Vercel ↗</button>
          <button className="appearance-none border border-coal bg-coal text-white px-3.5 py-2 rounded-[3px] font-mono text-[11px] uppercase tracking-[0.04em] cursor-pointer">View PR ↗</button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-2">
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
        <div className="flex gap-3 font-body text-xs text-neutral-700">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-mariner rounded-[1px]" />LLM</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-burnt-orange rounded-[1px]" />Tool</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-vibe-yellow rounded-[1px]" />Guardrail</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-coal rounded-[1px]" />Workflow</span>
          </div>
        }>

        <div className="mt-[18px]">
          <FlameGraph spans={D.TRACE} width={1080} rowH={22} gap={3} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      </CkCard>

      <div className="grid grid-cols-[1.4fr_1fr] gap-3">
        <CkCard eyebrow={span.kind} title={span.name}>
          <div className="grid grid-cols-[auto_1fr] gap-y-2 gap-x-6 font-mono text-xs">
            <span className="text-neutral-500">span_id</span><span className="text-neutral-900">{span.id}</span>
            <span className="text-neutral-500">started_at</span><span className="text-neutral-900">+{(span.start / 1000).toFixed(2)}s</span>
            <span className="text-neutral-500">duration</span><span className="text-neutral-900">{span.duration}ms</span>
            <span className="text-neutral-500">status</span>
            <span>{span.status === "warn" ? <CkChip tone="warn">flag</CkChip> : <CkChip tone="success">ok</CkChip>}</span>
            {span.attrs && Object.entries(span.attrs).map(([k, v]) =>
            <React.Fragment key={k}>
                <span className="text-neutral-500">{k}</span>
                <span className="text-neutral-900 break-all">{String(v)}</span>
              </React.Fragment>
            )}
          </div>
        </CkCard>

        <CkCard eyebrow="Arthur" title="Span evaluations">
          {span.evals ?
          <div className="flex flex-col gap-2.5">
                {Object.entries(span.evals).map(([k, v]) =>
            <BarRow key={k} label={k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}
            value={typeof v === "number" ? v.toFixed(3) : v}
            max={1}
            color={v > 0.9 ? "#5BB04A" : v > 0.5 ? "#3C43E7" : "#FD6027"} />
            )}
              </div> :
          <div className="py-5 text-center text-neutral-500 font-body text-[13px]">
                No evals run on this span kind.
              </div>}
          <div className="mt-4 pt-3 border-t border-neutral-200 font-mono text-[10px] text-neutral-700 tracking-[0.06em] uppercase">
            Evaluator: arthur-engine v3.4 · openinference
          </div>
        </CkCard>
      </div>

      <CkLLMViewer span={span} />

      <div className="grid grid-cols-[1fr_1.3fr] gap-3">
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
      <div className="inline-flex gap-0.5 p-[3px] bg-app-bg rounded-sm border border-neutral-200">
          {tabs.map((tb) =>
        <button key={tb.id} onClick={() => setTab(tb.id)} className={`appearance-none border-none cursor-pointer px-3 py-1.5 rounded-[3px] font-mono font-medium text-[11px] inline-flex items-center gap-1.5 tracking-[-0.01em] ${tab === tb.id ? "bg-panel text-neutral-900 shadow-[0_1px_2px_rgba(24,27,32,0.06)]" : "bg-transparent text-neutral-700"}`}>
              {tb.label}
              <span className="text-neutral-500 font-normal text-[10px]">{tb.sub}</span>
            </button>
        )}
        </div>
      }>

      <div className="bg-[#0E1014] text-neutral-200 rounded-[3px] p-4 font-mono text-xs leading-[1.65] whitespace-pre-wrap max-h-80 overflow-auto">
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
        <div className="flex flex-col gap-2.5">
            {[
          { role: "system", body: "You are an autonomous coding agent for ai-workflow. Reply with diffs only." },
          { role: "user", body: "Implement LIN-4521 from the plan in span s04." },
          { role: "assistant", body: "[tool: read_files] cart.tsx, useCart.ts, formatMoney.ts → [tool: write_diff] 9 files patched. PR opened." }].
          map((m, i) =>
          <div key={i}>
                <span className="text-burnt-orange uppercase tracking-[0.06em] text-[10px]">{m.role}</span>
                <div className="text-neutral-200 mt-0.5">{m.body}</div>
              </div>
          )}
          </div>
        }
        {tab === "tools" &&
        <div className="flex flex-col gap-2">
            <div><span className="text-[#5BB04A]">● </span><span className="text-vibe-yellow">sandbox.fs.readMany</span>({'{ paths: ["cart.tsx","useCart.ts","formatMoney.ts"] }'}) <span className="text-neutral-500">→ 14 files · 82.4kb</span></div>
            <div><span className="text-[#5BB04A]">● </span><span className="text-vibe-yellow">sandbox.fs.writeMany</span>({'{ files: 9 }'}) <span className="text-neutral-500">→ ok</span></div>
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
      <div className="flex flex-col gap-1.5 font-mono text-xs">
        {SUITE.map((s, i) =>
        <div key={i} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-xs border ${s.hl ? "bg-[#F6FAF1] border-[#D7F4B3]" : "bg-off-white border-neutral-200"}`}>
            <span className="text-[#5BB04A] text-sm">✓</span>
            <span className="flex-1 text-neutral-900 overflow-hidden text-ellipsis whitespace-nowrap">{s.f}</span>
            <span className="text-[#3F6B1E]">{s.p}</span>
            <span className="text-neutral-500 text-[11px]">{s.t}ms</span>
          </div>
        )}
      </div>
      <div className="mt-3 pt-2.5 border-t border-neutral-200 flex items-center gap-4 font-mono text-[10px] text-neutral-700 tracking-[0.06em] uppercase">
        <span>span s11 · sandbox.exec</span>
        <span className="ml-auto">4.12s · 312 specs</span>
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
      <div className="flex gap-2 items-center">
          <CkChip tone="success">+142 / −36</CkChip>
          <CkChip>9 files</CkChip>
          <a className="font-mono text-[11px] text-mariner no-underline uppercase tracking-[0.04em] cursor-pointer">View on GitHub ↗</a>
        </div>
      }>

      <div className="font-mono text-[11px] leading-[1.55] border border-neutral-200 rounded-[3px] overflow-hidden">
        {DIFF.map((line, i) => {
          const c = color(line.kind);
          return (
            <div key={i} className="flex" style={{ background: c.bg, color: c.fg }}>
              <span className="flex-[0_0_32px] text-right px-2 py-0.5 text-neutral-500 border-r border-neutral-200 select-none">{i + 1}</span>
              <span className="flex-[0_0_16px] text-center py-0.5 font-semibold">{c.pre}</span>
              <span className="flex-1 px-2 py-0.5 whitespace-pre">{line.v}</span>
            </div>);

        })}
      </div>
      <div className="mt-3 pt-2.5 border-t border-neutral-200 font-mono text-[10px] text-neutral-700 tracking-[0.06em] uppercase flex items-center gap-3">
        <span>span s13 · github.pulls.create</span>
        <span className="ml-auto">Awaiting review · sara.k</span>
      </div>
    </CkCard>);

}
