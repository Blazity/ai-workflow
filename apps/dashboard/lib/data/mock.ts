// Seeded RNG (not Math.random) so the data is identical on server and client —
// avoids hydration mismatches and keeps run IDs stable for trace deep-links.

import { makeRng } from "@/lib/rng";
import type {
  AIWFData,
  Alert,
  CostByModel,
  Deployment,
  EvalMetric,
  HourPoint,
  Prompt,
  PromptVersion,
  Run,
  RunStatus,
  Span,
  Workflow,
} from "@/lib/types";

// ── Workflows registered in ai-workflow ────────────────────────────────
const WORKFLOWS: Workflow[] = [
  { id: "wf_pr_review", name: "PR Review", blurb: "Ticket → tested PR", runs24h: 1247, p50: 22.4, p95: 78.1, errRate: 0.012, costToday: 184.2, gateway: "anthropic", primary: true },
  { id: "wf_triage", name: "Issue Triage", blurb: "Classify + label inbound issues", runs24h: 912, p50: 4.1, p95: 11.8, errRate: 0.004, costToday: 41.62, gateway: "openai" },
  { id: "wf_release_notes", name: "Release Notes", blurb: "Compose changelog from merged PRs", runs24h: 38, p50: 31.0, p95: 52.4, errRate: 0.026, costToday: 12.07, gateway: "anthropic" },
  { id: "wf_test_synth", name: "Test Synthesis", blurb: "Generate Playwright cases", runs24h: 216, p50: 18.7, p95: 41.0, errRate: 0.018, costToday: 74.83, gateway: "google" },
  { id: "wf_security_scan", name: "Security Scan", blurb: "Audit diffs for secrets/CVEs", runs24h: 402, p50: 8.9, p95: 22.6, errRate: 0.001, costToday: 19.51, gateway: "openai" },
  { id: "wf_design_review", name: "Design Review", blurb: "A11y + brand check on screenshots", runs24h: 84, p50: 14.2, p95: 28.3, errRate: 0.011, costToday: 22.04, gateway: "anthropic" },
];

// ── Recent runs (run list) ─────────────────────────────────────────────
const STATUSES: RunStatus[] = ["success", "success", "success", "success", "success", "success", "success", "running", "failed", "blocked"];
const TICKETS = ["LIN-4521", "LIN-4520", "LIN-4518", "JIRA-882", "LIN-4515", "JIRA-879", "LIN-4509", "LIN-4506", "JIRA-871", "LIN-4502", "LIN-4498", "JIRA-865", "LIN-4491", "LIN-4489", "JIRA-860", "LIN-4485", "LIN-4482", "LIN-4477"];
const ACTORS = ["sara.k", "marcin.w", "kevin.t", "ai-bot", "jules.m", "ai-bot", "ben.r", "ai-bot", "sara.k", "marcin.w", "jules.m", "ai-bot", "ben.r", "kevin.t", "ai-bot", "ai-bot", "sara.k", "marcin.w"];
const MODELS = ["claude-sonnet-4", "claude-sonnet-4", "gpt-4.1", "claude-sonnet-4", "gemini-2.5-pro", "claude-sonnet-4", "gpt-4.1", "claude-sonnet-4", "claude-sonnet-4", "grok-3"];

const runRng = makeRng(0xc0ffee);
const RUNS_RAW = TICKETS.map((tkt, i) => {
  const wf = WORKFLOWS[i % WORKFLOWS.length];
  const status = STATUSES[i % STATUSES.length];
  const idPart = Math.floor(runRng() * 1e9).toString(36).padStart(6, "0").slice(0, 6);
  const durRand = runRng();
  const tokRand = runRng();
  const costRand = runRng();
  const evalRand = runRng();
  const dur = status === "running" ? null : Math.round((4 + durRand * 72) * 10) / 10;
  return {
    id: "run_" + idPart,
    workflow: wf.id,
    workflowName: wf.name,
    status,
    ticket: tkt,
    actor: ACTORS[i % ACTORS.length],
    model: MODELS[i % MODELS.length],
    startedAtMin: i * 3 + (i % 7),
    duration: dur,
    tokens: Math.round(8000 + tokRand * 38000),
    cost: Math.round((0.04 + costRand * 0.72) * 100) / 100,
    spans: 6 + (i % 11),
    evalScore: Math.round((0.8 + evalRand * 0.18) * 100) / 100,
    guardrailHits: i % 6 === 0 ? 1 + (i % 3) : 0,
  };
});

// ── Single-run trace tree (Arthur OpenInference) ───────────────────────
const TRACE: Span[] = [
  { id: "s00", parent: null, name: "workflow.pr_review", kind: "workflow", start: 0, duration: 18340, status: "ok" },
  { id: "s01", parent: "s00", name: "vercel.workflow.start", kind: "workflow", start: 12, duration: 44, status: "ok", attrs: { trigger: "linear.issue.assigned" } },
  { id: "s02", parent: "s00", name: "linear.fetch_ticket", kind: "tool", start: 72, duration: 180, status: "ok", attrs: { "tool.name": "linear.getIssue", "issue.id": "LIN-4521" } },
  { id: "s03", parent: "s00", name: "git.clone_repo", kind: "tool", start: 280, duration: 1240, status: "ok", attrs: { "tool.name": "sandbox.git.clone", repo: "acme/storefront" } },
  { id: "s04", parent: "s00", name: "llm.plan_changes", kind: "llm", start: 1560, duration: 3220, status: "ok", attrs: { model: "claude-sonnet-4", "llm.input_tokens": 4280, "llm.output_tokens": 1180 }, evals: { hallucination: 0.018, relevance: 0.94, toolSelection: 0.97 } },
  { id: "s05", parent: "s04", name: "arthur.guardrail.input", kind: "guardrail", start: 1582, duration: 124, status: "ok", attrs: { guardrail: "prompt_injection", verdict: "pass", score: 0.001 } },
  { id: "s06", parent: "s04", name: "arthur.guardrail.output", kind: "guardrail", start: 4720, duration: 60, status: "ok", attrs: { guardrail: "pii_detection", verdict: "pass", score: 0 } },
  { id: "s07", parent: "s00", name: "tool.read_files", kind: "tool", start: 4820, duration: 910, status: "ok", attrs: { "tool.name": "sandbox.fs.readMany", files: 14 } },
  { id: "s08", parent: "s00", name: "llm.write_changes", kind: "llm", start: 5760, duration: 5680, status: "ok", attrs: { model: "claude-sonnet-4", "llm.input_tokens": 12440, "llm.output_tokens": 3210 }, evals: { hallucination: 0.024, relevance: 0.91, toolSelection: 0.93 } },
  { id: "s09", parent: "s08", name: "arthur.guardrail.output", kind: "guardrail", start: 11380, duration: 62, status: "warn", attrs: { guardrail: "toxicity", verdict: "flag", score: 0.071 } },
  { id: "s10", parent: "s00", name: "sandbox.apply_diff", kind: "tool", start: 11460, duration: 840, status: "ok", attrs: { "tool.name": "sandbox.fs.writeMany", files: 9 } },
  { id: "s11", parent: "s00", name: "sandbox.run_tests", kind: "tool", start: 12320, duration: 4120, status: "ok", attrs: { "tool.name": "sandbox.exec", cmd: "pnpm test", "tests.passed": 312, "tests.failed": 0 } },
  { id: "s12", parent: "s00", name: "llm.summarize_pr", kind: "llm", start: 16480, duration: 1480, status: "ok", attrs: { model: "claude-sonnet-4", "llm.input_tokens": 2120, "llm.output_tokens": 640 }, evals: { hallucination: 0.011, relevance: 0.96 } },
  { id: "s13", parent: "s00", name: "github.open_pr", kind: "tool", start: 17980, duration: 340, status: "ok", attrs: { "tool.name": "github.pulls.create", "pr.number": 2147 } },
];

// ── Arthur evals (live + historical) ───────────────────────────────────
const EVALS: EvalMetric[] = [
  { metric: "Hallucination", value: 0.024, target: "< 0.05", status: "pass", trend: -0.003, axis: "safety", family: "output" },
  { metric: "Tool Selection Accuracy", value: 0.94, target: "> 0.90", status: "pass", trend: +0.012, axis: "quality", family: "agent" },
  { metric: "Response Relevance", value: 0.91, target: "> 0.85", status: "pass", trend: -0.004, axis: "quality", family: "output" },
  { metric: "Prompt Injection", value: 0, target: "= 0", status: "pass", trend: 0, axis: "safety", family: "input" },
  { metric: "PII Detection", value: 3, target: "flags", status: "warn", trend: +1, axis: "safety", family: "output", unit: "flags/24h" },
  { metric: "Toxicity", value: 0.008, target: "< 0.02", status: "pass", trend: -0.001, axis: "safety", family: "output" },
  { metric: "Citation Coverage", value: 0.78, target: "> 0.80", status: "warn", trend: -0.022, axis: "quality", family: "rag" },
  { metric: "Latency p95 (s)", value: 23.1, target: "< 30", status: "pass", trend: -1.4, axis: "ops", family: "runtime" },
  { metric: "Cost / run (USD)", value: 0.34, target: "< 0.50", status: "pass", trend: +0.02, axis: "ops", family: "runtime" },
  { metric: "Tool Error Rate", value: 0.012, target: "< 0.02", status: "pass", trend: -0.001, axis: "ops", family: "agent" },
];

// ── Cost / usage analytics ─────────────────────────────────────────────
const COST_BY_MODEL: CostByModel[] = [
  { model: "claude-sonnet-4", vendor: "anthropic", cost: 412.18, tokens: 14_802_000, share: 0.62 },
  { model: "gpt-4.1", vendor: "openai", cost: 142.04, tokens: 9_240_000, share: 0.21 },
  { model: "gemini-2.5-pro", vendor: "google", cost: 68.91, tokens: 4_180_000, share: 0.1 },
  { model: "grok-3", vendor: "xai", cost: 31.2, tokens: 2_010_000, share: 0.05 },
  { model: "claude-haiku-4-5", vendor: "anthropic", cost: 12.92, tokens: 3_640_000, share: 0.02 },
];

// Hourly time series for sparkline + area chart (24h, runs/cost/latency)
const hourRng = makeRng(0x5eed);
const HOURS24: HourPoint[] = Array.from({ length: 24 }, (_, h) => {
  const peak = Math.exp(-Math.pow((h - 14) / 4.5, 2)); // workday hump
  return {
    h,
    runs: Math.round(40 + 220 * peak + hourRng() * 30),
    cost: Math.round((6 + 28 * peak + hourRng() * 5) * 100) / 100,
    p95: Math.round((14 + 8 * peak + hourRng() * 6) * 10) / 10,
    errors: Math.round(hourRng() * 4 * peak),
  };
});

// ── Vercel deployments adjacent to the AI workflow ─────────────────────
const DEPLOYMENTS: Deployment[] = [
  { id: "dpl_a93", ref: "main@4f2e1c0", actor: "sara.k", when: "2m", status: "ready", workflow: "all", env: "prod" },
  { id: "dpl_a92", ref: "main@bc14a8f", actor: "ai-bot", when: "38m", status: "ready", workflow: "wf_pr_review", env: "prod" },
  { id: "dpl_a91", ref: "pr/2147", actor: "ai-bot", when: "42m", status: "preview", workflow: "wf_pr_review", env: "preview" },
  { id: "dpl_a90", ref: "main@77c91d3", actor: "kevin.t", when: "3h", status: "ready", workflow: "all", env: "prod" },
  { id: "dpl_a89", ref: "pr/2144", actor: "marcin.w", when: "4h", status: "error", workflow: "wf_test_synth", env: "preview" },
];

// ── Alerts / incidents ─────────────────────────────────────────────────
const ALERTS: Alert[] = [
  { id: "a1", severity: "warn", who: "arthur.toxicity", msg: "Toxicity flag rate up 38% on wf_release_notes", when: "7m" },
  { id: "a2", severity: "info", who: "vercel.workflow", msg: "Budget for wf_pr_review at 64% of monthly cap", when: "1h" },
  { id: "a3", severity: "error", who: "vercel.function", msg: "sandbox.exec timeout x3 on wf_test_synth", when: "2h" },
];

// ── Live runs (currently executing OR awaiting human clarification) ───
const LIVE_RUNS_RAW = [
  {
    id: "run_streaming",
    workflow: "wf_pr_review", workflowName: "PR Review",
    status: "running" as RunStatus,
    ticket: "LIN-4527", actor: "ai-bot", model: "claude-sonnet-4",
    startedAtMin: 0, duration: null, tokens: 12_400, cost: 0.18, spans: 9, evalScore: 0,
    currentSpan: "llm.write_changes", currentSpanKind: "llm" as const,
    progress: 0.62, spanIndex: 8, spansTotal: 14,
    elapsed: 11.4, etaSec: 7,
    guardrailHits: 0,
  },
  {
    id: "run_5c1f9d",
    workflow: "wf_design_review", workflowName: "Design Review",
    status: "running" as RunStatus,
    ticket: "LIN-4525", actor: "ai-bot", model: "gemini-2.5-pro",
    startedAtMin: 0, duration: null, tokens: 4_200, cost: 0.06, spans: 5, evalScore: 0,
    currentSpan: "tool.analyze_screenshots", currentSpanKind: "tool" as const,
    progress: 0.34, spanIndex: 3, spansTotal: 9,
    elapsed: 4.8, etaSec: 12,
    guardrailHits: 0,
  },
  {
    id: "run_a8d2f1",
    workflow: "wf_pr_review", workflowName: "PR Review",
    status: "awaiting" as RunStatus,
    ticket: "JIRA-884", actor: "ai-bot", model: "claude-sonnet-4",
    startedAtMin: 3, duration: null, tokens: 9_100, cost: 0.14, spans: 7, evalScore: 0,
    pausedAtSpan: "llm.plan_changes",
    askedAtMin: 3,
    question:
      "The ticket asks to refactor checkout, but two routes both implement it (apps/web/checkout and packages/commerce/checkout). Which is the source of truth — should I migrate the other into it, or treat them as separate code paths?",
    questionFor: "marcin.w",
    blockingReason: "Ambiguous repo layout",
    suggestedAnswers: ["apps/web is source of truth", "packages/commerce is source of truth", "Keep separate"],
    guardrailHits: 0,
  },
  {
    id: "run_b7e4c0",
    workflow: "wf_test_synth", workflowName: "Test Synthesis",
    status: "awaiting" as RunStatus,
    ticket: "LIN-4519", actor: "ai-bot", model: "gpt-4.1",
    startedAtMin: 12, duration: null, tokens: 6_800, cost: 0.09, spans: 4, evalScore: 0,
    pausedAtSpan: "llm.draft_specs",
    askedAtMin: 12,
    question:
      "Should generated tests run against the staging API or use mocked fixtures? The spec doesn't say, and the existing suite mixes both.",
    questionFor: "kevin.t",
    blockingReason: "Test-target unspecified",
    suggestedAnswers: ["Staging API", "Mocked fixtures", "Both — separate suites"],
    guardrailHits: 0,
  },
];

// ── Linear / Jira ticket titles (keyed by ticket id) ──────────────────
const TICKET_TITLES: Record<string, string> = {
  "LIN-4521": "Add multi-currency support to checkout",
  "LIN-4520": "Fix product-page hydration error on iOS Safari",
  "LIN-4519": "Generate Playwright tests for the cart page",
  "LIN-4518": "Sticky filters on the search results page",
  "LIN-4515": "Replace deprecated next/font import in layout",
  "LIN-4509": "Compose May release notes from merged PRs",
  "LIN-4506": "Triage incoming support tickets w/ severity labels",
  "LIN-4502": "A11y audit for the new wishlist drawer",
  "LIN-4498": "Cache invalidation bug on product variant change",
  "LIN-4491": "Migrate checkout-success page to App Router",
  "LIN-4489": "Add OG image generator for blog posts",
  "LIN-4485": "Improve TTFB on the homepage hero",
  "LIN-4482": "Brand-color contrast check across CTAs",
  "LIN-4477": "Remove unused Stripe webhook handler",
  "LIN-4525": "Design review for the new wishlist drawer",
  "LIN-4527": "Refactor cart line items to support gift wrapping",
  "JIRA-882": "Triage P0 outage tickets from incident #114",
  "JIRA-879": "Audit auth flow for secrets in the diff",
  "JIRA-871": "PR review · Stripe SCA migration",
  "JIRA-865": "Triage release-blocker tickets",
  "JIRA-860": "A11y review for the multi-step checkout",
  "JIRA-884": "PR review · refactor checkout module structure",
};

// PR numbers issued by wf_pr_review per ticket (where one has been opened).
const TICKET_PRS: Record<string, number> = {
  "LIN-4521": 2147,
  "LIN-4520": 2146,
  "LIN-4518": 2145,
  "LIN-4515": 2143,
  "LIN-4498": 2140,
  "JIRA-871": 2138,
  "LIN-4477": 2131,
};

// Attach titles + PR refs to runs (live + historical).
function decorate(run: Omit<Run, "ticketTitle" | "prNumber" | "ticketUrl" | "prUrl">): Run {
  return {
    ...run,
    ticketTitle: TICKET_TITLES[run.ticket] || run.ticket,
    prNumber: TICKET_PRS[run.ticket] || null,
    ticketUrl: run.ticket.startsWith("JIRA")
      ? "https://acme.atlassian.net/browse/" + run.ticket
      : "https://linear.app/acme/issue/" + run.ticket,
    prUrl: TICKET_PRS[run.ticket]
      ? "https://github.com/acme/storefront/pull/" + TICKET_PRS[run.ticket]
      : null,
  };
}

const LIVE_RUNS: Run[] = LIVE_RUNS_RAW.map(decorate);
const RUNS: Run[] = RUNS_RAW.map(decorate);

// Prepend live runs so they appear at the top of tables with extended badges.
const RUNS_ALL: Run[] = [...LIVE_RUNS, ...RUNS];

// ── Arthur Prompt Versioning · registered prompts + versions ───────────
const PROMPTS: Prompt[] = [
  { id: "p_plan_changes", name: "plan_changes", workflow: "wf_pr_review", workflowName: "PR Review", span: "llm.plan_changes", versionCount: 12, current: "v12", trafficSplit: { v12: 0.85, v11: 0.15 }, evalScore: 0.94, evalDelta: +0.012, lastEditedBy: "sara.k", lastEditedAtMin: 120, tags: ["production", "ab-test"], model: "claude-sonnet-4" },
  { id: "p_write_changes", name: "write_changes", workflow: "wf_pr_review", workflowName: "PR Review", span: "llm.write_changes", versionCount: 8, current: "v8", trafficSplit: { v8: 1.0 }, evalScore: 0.91, evalDelta: -0.004, lastEditedBy: "marcin.w", lastEditedAtMin: 1480, tags: ["production"], model: "claude-sonnet-4" },
  { id: "p_summarize_pr", name: "summarize_pr", workflow: "wf_pr_review", workflowName: "PR Review", span: "llm.summarize_pr", versionCount: 5, current: "v5", trafficSplit: { v5: 1.0 }, evalScore: 0.96, evalDelta: +0.022, lastEditedBy: "ai-bot", lastEditedAtMin: 360, tags: ["production"], model: "claude-sonnet-4" },
  { id: "p_triage_classify", name: "classify_issue", workflow: "wf_triage", workflowName: "Issue Triage", span: "llm.classify", versionCount: 7, current: "v7", trafficSplit: { v7: 1.0 }, evalScore: 0.89, evalDelta: +0.001, lastEditedBy: "jules.m", lastEditedAtMin: 720, tags: ["production"], model: "gpt-4.1" },
  { id: "p_release_compose", name: "compose_release_notes", workflow: "wf_release_notes", workflowName: "Release Notes", span: "llm.compose", versionCount: 4, current: "v4", trafficSplit: { v4: 0.7, "v5-draft": 0.3 }, evalScore: 0.84, evalDelta: -0.018, lastEditedBy: "ben.r", lastEditedAtMin: 28, tags: ["staging", "draft"], model: "claude-sonnet-4" },
  { id: "p_test_draft", name: "draft_specs", workflow: "wf_test_synth", workflowName: "Test Synthesis", span: "llm.draft_specs", versionCount: 9, current: "v9", trafficSplit: { v9: 1.0 }, evalScore: 0.88, evalDelta: +0.006, lastEditedBy: "kevin.t", lastEditedAtMin: 4320, tags: ["production"], model: "gemini-2.5-pro" },
  { id: "p_security_audit", name: "audit_diff", workflow: "wf_security_scan", workflowName: "Security Scan", span: "llm.audit", versionCount: 3, current: "v3", trafficSplit: { v3: 1.0 }, evalScore: 0.97, evalDelta: 0, lastEditedBy: "sara.k", lastEditedAtMin: 7200, tags: ["production", "locked"], model: "gpt-4.1" },
];

// Detailed version history for the selected (plan_changes) prompt.
const PROMPT_VERSIONS: Record<string, PromptVersion[]> = {
  p_plan_changes: [
    { v: "v12", deployedAt: "2h ago", by: "sara.k", status: "production", traffic: 0.85, evalScore: 0.94, runs: 1085, costAvg: 0.058, p95: 3.4, halluc: 0.018, change: "Tightened repo-layout disambiguation. Added explicit guidance for monorepo paths." },
    { v: "v11", deployedAt: "1d ago", by: "marcin.w", status: "production", traffic: 0.15, evalScore: 0.93, runs: 192, costAvg: 0.062, p95: 3.5, halluc: 0.021, change: "Reduced verbosity in planning step; switched to bullet output." },
    { v: "v10", deployedAt: "3d ago", by: "ai-bot", status: "archived", traffic: 0, evalScore: 0.91, runs: 2410, costAvg: 0.061, p95: 3.7, halluc: 0.028, change: "Added analytics-preservation constraint to instructions." },
    { v: "v9", deployedAt: "7d ago", by: "marcin.w", status: "archived", traffic: 0, evalScore: 0.88, runs: 4120, costAvg: 0.067, p95: 3.9, halluc: 0.034, change: "First prompt with structured tool-use schema." },
    { v: "v8", deployedAt: "14d ago", by: "sara.k", status: "archived", traffic: 0, evalScore: 0.85, runs: 3210, costAvg: 0.072, p95: 4.2, halluc: 0.044, change: "Loosened constraints; experimented with chain-of-thought." },
    { v: "v7", deployedAt: "21d ago", by: "jules.m", status: "archived", traffic: 0, evalScore: 0.86, runs: 2840, costAvg: 0.071, p95: 4.1, halluc: 0.041, change: "Initial production version." },
  ],
};

const PROMPT_BODIES: Record<string, string> = {
  v12: `# plan_changes  ·  v12  ·  production
You are the planning step of the PR Review workflow. Given a ticket
and a repository snapshot, output a structured plan that the
write_changes span can execute deterministically.

INPUT:
- ticket: {{ticket}}
- repo_summary: {{repo_summary}}
- prior_planning_context: {{plan_context|optional}}

INSTRUCTIONS:
1. Identify the SINGLE source-of-truth path for the feature. If the
   monorepo contains overlapping implementations, prefer the path
   under apps/ over packages/.
2. Output the plan as a JSON tool call with this shape:
   { "files": [...], "tests_required": [...], "constraints": [...] }
3. Preserve existing analytics events; never remove a track:* call.
4. If the ticket is ambiguous on layout, EMIT a clarification request
   via the request_clarification tool — do NOT guess.

CONSTRAINTS:
- No new dependencies
- TypeScript strict; no \`any\`
- Match project Prettier config`,

  v11: `# plan_changes  ·  v11  ·  production
You are the planning step of the PR Review workflow. Given a ticket
and a repository snapshot, output a structured plan that the
write_changes span can execute deterministically.

INPUT:
- ticket: {{ticket}}
- repo_summary: {{repo_summary}}

INSTRUCTIONS:
1. Identify the source-of-truth path for the feature.
2. Output the plan as bullets:
   - files to touch
   - tests required
   - constraints
3. Preserve existing analytics events.

CONSTRAINTS:
- No new dependencies
- TypeScript strict`,
};

export const AIWF_DATA: AIWFData = {
  WORKFLOWS,
  RUNS: RUNS_ALL,
  LIVE_RUNS,
  TRACE,
  EVALS,
  COST_BY_MODEL,
  HOURS24,
  DEPLOYMENTS,
  ALERTS,
  PROMPTS,
  PROMPT_VERSIONS,
  PROMPT_BODIES,
};

export default AIWF_DATA;
