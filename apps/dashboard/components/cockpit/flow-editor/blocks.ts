import type { FlowNodeDef, WorkflowBlockType } from "@/lib/flows";
import type { WorkflowEditorOptions, WorkflowParamValue } from "@shared/contracts";

export const NODE_CATEGORIES: Record<
  WorkflowBlockType,
  { color: string; soft: string; label: string; glyph: string; group: string }
> = {
  trigger_ticket_ai:    { color: "#D14343", soft: "#FBECEC", label: "Trigger",              glyph: "▶", group: "trigger" },
  planning_agent:       { color: "#7C3AED", soft: "#F2EBFD", label: "Planning agent",       glyph: "✦", group: "agents" },
  implementation_agent: { color: "#7C3AED", soft: "#F2EBFD", label: "Implementation agent", glyph: "⌨", group: "agents" },
  review_agent:         { color: "#7C3AED", soft: "#F2EBFD", label: "Review agent",         glyph: "☰", group: "agents" },
  run_pre_pr_checks:    { color: "#64748B", soft: "#EEF1F5", label: "Pre-PR checks",        glyph: "✓", group: "utility" },
  send_slack_message:   { color: "#64748B", soft: "#EEF1F5", label: "Slack message",        glyph: "✉", group: "utility" },
  open_pr:              { color: "#3C43E7", soft: "#ECECFD", label: "Open PR",              glyph: "⇪", group: "vcs" },
  update_ticket_status: { color: "#2563EB", soft: "#E9EFFD", label: "Ticket status",        glyph: "▤", group: "ticket" },
  branch:               { color: "#35823f", soft: "#E9F3EA", label: "Branch",               glyph: "⋔", group: "control" },
  loop:                 { color: "#35823f", soft: "#E9F3EA", label: "Loop",                 glyph: "↻", group: "control" },
  terminate:            { color: "#35823f", soft: "#E9F3EA", label: "Terminate",            glyph: "■", group: "control" },
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
