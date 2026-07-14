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
  send_plan_approval:     { color: "#b06a14", soft: "#F7F0E7", label: "Plan approval",         glyph: "☑", group: "human" },
  human_question:         { color: "#b06a14", soft: "#F7F0E7", label: "Human question",       glyph: "?", group: "human" },
  arthur_injection_check: { color: "#8b6f8f", soft: "#F3F0F4", label: "Injection check",      glyph: "◬", group: "arthur" },
  branch:                 { color: "#35823f", soft: "#E9F3EA", label: "Branch",               glyph: "⋔", group: "control" },
  loop:                   { color: "#35823f", soft: "#E9F3EA", label: "Loop",                 glyph: "↻", group: "control" },
  terminate:              { color: "#35823f", soft: "#E9F3EA", label: "Terminate",            glyph: "■", group: "control" },
};

function truncate(text: string, max = 48): string {
  const clean = text.trim().replace(/\s+/g, " ");
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

function str(value: WorkflowParamValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function agentModelSummary(node: FlowNodeDef): string | null {
  const model = str(node.params.model);
  if (model === "") return null;
  const provider = node.params.provider;
  return provider === "claude" || provider === "codex" ? `${provider} · ${model}` : model;
}

export function nodeSummary(node: FlowNodeDef, options: WorkflowEditorOptions): string | null {
  switch (node.type) {
    case "planning_agent":
    case "implementation_agent":
    case "review_agent":
    case "fix_agent":
      return agentModelSummary(node);
    case "generic_agent": {
      const model = agentModelSummary(node);
      if (model) return model;
      const prompt = str(node.params.prompt);
      return prompt !== "" ? truncate(prompt) : null;
    }
    case "call_llm": {
      const model = str(node.params.model);
      if (model !== "") return model;
      const prompt = str(node.params.prompt);
      return prompt !== "" ? truncate(prompt) : null;
    }
    case "branch": {
      const condition = str(node.params.condition);
      return condition !== "" ? truncate(condition) : null;
    }
    case "loop": {
      const attempts = node.params.maxAttempts;
      const onExhaust = str(node.params.onExhaust);
      if (typeof attempts !== "number" && onExhaust === "") return null;
      const parts: string[] = [];
      if (typeof attempts === "number") parts.push(`max ${attempts}`);
      if (onExhaust !== "") parts.push(`on exhaust ${onExhaust}`);
      return parts.join(", ");
    }
    case "terminate": {
      const status = str(node.params.terminalStatus);
      return status !== "" ? status : null;
    }
    case "run_checks": {
      const commands = node.params.commands;
      return Array.isArray(commands) && commands.length > 0
        ? `${commands.length} command${commands.length === 1 ? "" : "s"}`
        : "config checks";
    }
    case "human_question": {
      const questions = node.params.questions;
      return Array.isArray(questions) && questions.length > 0 ? truncate(String(questions[0])) : null;
    }
    case "post_ticket_comment":
    case "post_pr_comment": {
      const body = str(node.params.body);
      return body !== "" ? truncate(body) : null;
    }
    case "update_ticket_status": {
      const target = node.params.target;
      const label = options.ticketStatusTargets.find((t) => t.value === target)?.label;
      if (label) return label;
      const custom = str(target);
      return custom !== "" ? custom : null;
    }
    case "send_slack_message": {
      const message = str(node.params.message);
      return message !== "" ? message : null;
    }
    case "run_pre_pr_checks": {
      const cycles = node.params.maxFixCycles;
      return typeof cycles === "number" ? `${cycles} fix cycles` : null;
    }
    case "send_plan_approval": {
      const from = str(node.params.planFromStep);
      return from !== "" ? from : "awaits approval";
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

export interface PaletteGroup {
  group: string;
  label: string;
  color: string;
  items: PaletteItem[];
}

const GROUP_ORDER = [
  "trigger",
  "agents",
  "workspace",
  "control",
  "ticket",
  "vcs",
  "human",
  "utility",
  "arthur",
] as const;

const GROUP_META: Record<string, { label: string; color: string }> = {
  trigger: { label: "Triggers", color: "#D14343" },
  agents: { label: "Agents", color: "#7C3AED" },
  workspace: { label: "Workspace", color: "#0f7f8b" },
  control: { label: "Control", color: "#35823f" },
  ticket: { label: "Ticket", color: "#2563EB" },
  vcs: { label: "Version control", color: "#3C43E7" },
  human: { label: "Human", color: "#b06a14" },
  utility: { label: "Utility", color: "#64748B" },
  arthur: { label: "Arthur", color: "#8b6f8f" },
};

function seedParams(type: WorkflowBlockType, defaultModel: string): Record<string, WorkflowParamValue> {
  if (NODE_CATEGORIES[type].group === "agents") return { model: defaultModel };
  if (type === "loop") return { maxAttempts: 3, onExhaust: "fail" };
  if (type === "terminate") return { terminalStatus: "done" };
  if (type === "branch") return { condition: "" };
  if (type === "update_ticket_status") return { target: "ai_review" };
  if (type === "run_pre_pr_checks") return { maxFixCycles: 3 };
  return {};
}

export function buildPaletteItems(defaultModel: string): PaletteGroup[] {
  const types = Object.keys(NODE_CATEGORIES) as WorkflowBlockType[];
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_META[group].label,
    color: GROUP_META[group].color,
    items: types
      .filter((type) => NODE_CATEGORIES[type].group === group)
      .map((type) => ({
        type,
        name: NODE_CATEGORIES[type].label,
        params: seedParams(type, defaultModel),
      })),
  }));
}
