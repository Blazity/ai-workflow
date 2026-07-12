import type { FlowNodeDef, WorkflowBlockType } from "@/lib/flows";
import type { WorkflowEditorOptions, WorkflowParamValue } from "@shared/contracts";

export const NODE_CATEGORIES: Record<
  WorkflowBlockType,
  { color: string; soft: string; label: string; glyph: string; group: string }
> = {
  trigger_ticket_ai:      { color: "#D14343", soft: "#FBECEC", label: "Trigger",              glyph: "▶", group: "trigger" },
  trigger_plan_approved:  { color: "#b8433a", soft: "#F8ECEB", label: "Plan approved",        glyph: "✔", group: "trigger" },
  trigger_pr_created:     { color: "#b8433a", soft: "#F8ECEB", label: "PR created",           glyph: "⎇", group: "trigger" },
  trigger_pr_checks_failed: { color: "#b8433a", soft: "#F8ECEB", label: "PR checks failed",   glyph: "✗", group: "trigger" },
  trigger_pr_review:      { color: "#b8433a", soft: "#F8ECEB", label: "PR review",            glyph: "✎", group: "trigger" },
  planning_agent:         { color: "#7C3AED", soft: "#F2EBFD", label: "Planning agent",       glyph: "✦", group: "agents" },
  implementation_agent:   { color: "#7C3AED", soft: "#F2EBFD", label: "Implementation agent", glyph: "⌨", group: "agents" },
  review_agent:           { color: "#7C3AED", soft: "#F2EBFD", label: "Review agent",         glyph: "☰", group: "agents" },
  fix_agent:              { color: "#7345c8", soft: "#F1ECF9", label: "Fix agent",            glyph: "✚", group: "agents" },
  generic_agent:          { color: "#7345c8", soft: "#F1ECF9", label: "Agent",                glyph: "❖", group: "agents" },
  prepare_workspace:      { color: "#0f7f8b", soft: "#E7F2F3", label: "Prepare workspace",    glyph: "⊞", group: "workspace" },
  finalize_workspace:     { color: "#0f7f8b", soft: "#E7F2F3", label: "Finalize workspace",   glyph: "⇉", group: "workspace" },
  run_pre_pr_checks:      { color: "#64748B", soft: "#EEF1F5", label: "Pre-PR checks",        glyph: "✓", group: "utility" },
  run_checks:             { color: "#57616e", soft: "#EEF0F2", label: "Run checks",           glyph: "✓", group: "utility" },
  call_llm:               { color: "#57616e", soft: "#EEF0F2", label: "Call LLM",             glyph: "λ", group: "utility" },
  fetch_pr_context:       { color: "#4b50bf", soft: "#EDEEF9", label: "Fetch PR context",     glyph: "⇊", group: "vcs" },
  open_pr:                { color: "#3C43E7", soft: "#ECECFD", label: "Open PR",              glyph: "⇪", group: "vcs" },
  update_ticket_status:   { color: "#2563EB", soft: "#E9EFFD", label: "Ticket status",        glyph: "▤", group: "ticket" },
  post_ticket_comment:    { color: "#2367b8", soft: "#E9F0F8", label: "Ticket comment",       glyph: "❝", group: "ticket" },
  post_pr_comment:        { color: "#4b50bf", soft: "#EDEEF9", label: "PR comment",           glyph: "❞", group: "vcs" },
  send_slack_message:     { color: "#64748B", soft: "#EEF1F5", label: "Slack message",        glyph: "✉", group: "utility" },
  human_question:         { color: "#b06a14", soft: "#F7F0E7", label: "Human question",       glyph: "?", group: "human" },
  arthur_injection_check: { color: "#8b6f8f", soft: "#F3F0F4", label: "Injection check",      glyph: "◬", group: "arthur" },
  arthur_trace:           { color: "#8b6f8f", soft: "#F3F0F4", label: "Arthur trace",         glyph: "∿", group: "arthur" },
  branch:                 { color: "#35823f", soft: "#E9F3EA", label: "Branch",               glyph: "⋔", group: "control" },
  loop:                   { color: "#35823f", soft: "#E9F3EA", label: "Loop",                 glyph: "↻", group: "control" },
  terminate:              { color: "#35823f", soft: "#E9F3EA", label: "Terminate",            glyph: "■", group: "control" },
};

export function nodeSummary(node: FlowNodeDef, options: WorkflowEditorOptions): string | null {
  switch (node.type) {
    case "planning_agent":
    case "implementation_agent":
    case "review_agent": {
      const model = node.params.model;
      const modelText = typeof model === "string" && model !== "" ? model : null;
      if (modelText === null) return null;
      const provider = node.params.provider;
      return provider === "claude" || provider === "codex"
        ? `${provider} · ${modelText}`
        : modelText;
    }
    case "update_ticket_status": {
      const target = node.params.target;
      return options.ticketStatusTargets.find((t) => t.value === target)?.label ?? null;
    }
    case "send_slack_message": {
      const message = node.params.message;
      return typeof message === "string" && message !== "" ? message : null;
    }
    case "run_pre_pr_checks": {
      const cycles = node.params.maxFixCycles;
      return typeof cycles === "number" ? `${cycles} fix cycles` : null;
    }
    default:
      return null;
  }
}

export interface PaletteItem {
  type: WorkflowBlockType;
  name: string;
  params: Record<string, WorkflowParamValue>;
}

export function buildPaletteItems(defaultModel: string): PaletteItem[] {
  return [
    { type: "planning_agent", name: "Planning agent", params: { model: defaultModel } },
    { type: "implementation_agent", name: "Implementation agent", params: { model: defaultModel } },
    { type: "review_agent", name: "Review agent", params: { model: defaultModel } },
    { type: "run_pre_pr_checks", name: "Run pre-PR checks", params: { maxFixCycles: 3 } },
    { type: "open_pr", name: "Open pull request", params: {} },
    { type: "update_ticket_status", name: "Update ticket status", params: { target: "ai_review" } },
    { type: "send_slack_message", name: "Send Slack message", params: { message: "" } },
  ];
}
