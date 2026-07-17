import type { FlowNodeDef, WorkflowBlockType } from "@/lib/flows";
import type {
  WorkflowBlockPresentation,
  WorkflowEditorOptions,
  WorkflowParamValue,
} from "@shared/contracts";

export const CONNECTED_CARD_TEXT_CLASS = "overflow-hidden text-ellipsis whitespace-nowrap";

export function blockPresentation(
  options: WorkflowEditorOptions,
  type: WorkflowBlockType,
): WorkflowBlockPresentation {
  return options.blockRegistry[type].presentation;
}

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
    case "trigger_pr_created":
    case "trigger_pr_checks_failed":
    case "trigger_pr_merged":
      return node.params.scope === "any" ? "any PR" : "workflow-owned only";
    case "trigger_pr_review": {
      const on = node.params.on;
      const scope = node.params.scope === "any" ? "any PR" : "workflow-owned only";
      return Array.isArray(on) && on.length > 0 ? `${scope} · on ${on.join(", ")}` : scope;
    }
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
      return "awaits approval";
    }
    default:
      return null;
  }
}

export interface PaletteItem {
  type: WorkflowBlockType;
  name: string;
  params: Record<string, WorkflowParamValue>;
  presentation: WorkflowBlockPresentation;
  available: boolean;
  unavailableReason: string | null;
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

const GROUP_LABELS: Record<string, string> = {
  trigger: "Triggers",
  agents: "Agents",
  workspace: "Workspace",
  control: "Control",
  ticket: "Ticket",
  vcs: "Version control",
  human: "Human",
  utility: "Utility",
  arthur: "Arthur",
};

export function buildPaletteItems(options: WorkflowEditorOptions): PaletteGroup[] {
  const contracts = Object.values(options.blockRegistry);
  return GROUP_ORDER.flatMap((group) => {
    const groupContracts = contracts.filter((contract) => contract.presentation.group === group);
    if (groupContracts.length === 0) return [];
    return [{
      group,
      label: GROUP_LABELS[group],
      color: groupContracts[0]!.presentation.color,
      items: groupContracts.map((contract) => ({
        type: contract.type,
        name: contract.presentation.label,
        params: { ...contract.defaults },
        presentation: contract.presentation,
        available: contract.availability.available,
        unavailableReason: contract.availability.unavailableReason,
      })),
    }];
  });
}
