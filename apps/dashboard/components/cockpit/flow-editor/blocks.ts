import type { FlowNodeDef, WorkflowBlockType } from "@/lib/flows";
import type {
  WorkflowBlockPresentation,
  WorkflowEditorOptions,
  WorkflowParamValue,
} from "@shared/contracts";
import { isV2OnlyBlockType } from "@shared/contracts";
import {
  WORKFLOW_EDITOR_BLOCK_TEMPLATES,
  type WorkflowEditorBlockTemplateId,
} from "@/lib/workflow-editor/block-templates";
import {
  parseWorkflowBranchConfigurationV2,
  summarizeWorkflowBranchConfiguration,
} from "@/lib/workflow-editor/branch-ast";

export const CONNECTED_CARD_TEXT_CLASS = "overflow-hidden text-ellipsis whitespace-nowrap";

/**
 * Editor-side corrections to the worker's block presentation.
 *
 * "Pre-PR checks" named the gate after the wrong thing: it runs the very same
 * repository script groups run_scripts does, and an author reading three
 * near-identical utility blocks had no way to tell which one gates publication.
 * The glyph moves off the check mark for the same reason, so the gate and
 * run_scripts never read as the same block at a glance.
 */
const PRESENTATION_OVERRIDES: Partial<
  Record<WorkflowBlockType, Partial<WorkflowBlockPresentation>>
> = {
  run_pre_pr_checks: { label: "Run scripts (publication gate)", glyph: "◈" },
};

export function blockPresentation(
  options: WorkflowEditorOptions,
  type: WorkflowBlockType,
): WorkflowBlockPresentation {
  const presentation = options.blockRegistry[type].presentation;
  const override = PRESENTATION_OVERRIDES[type];
  return override ? { ...presentation, ...override } : presentation;
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

/** The investigate block's enabled context providers, read from v2.configuration
 *  for a deployed node and from params for a freshly edited one. An absent list
 *  means both are on, matching the param's own default: a node nobody has
 *  configured yet investigates every source it can reach. */
export function investigateProviders(node: FlowNodeDef): { jira: boolean; slack: boolean } {
  const raw: unknown = node.v2?.configuration.providers ?? node.params.providers;
  if (!Array.isArray(raw)) return { jira: true, slack: true };
  return { jira: raw.includes("jira"), slack: raw.includes("slack") };
}

function rateLimitSummary(node: FlowNodeDef): string | null {
  const max = node.params.rateLimitMax;
  if (typeof max !== "number") return null;
  const window = str(node.params.rateLimitWindow) || "day";
  return `max ${max}/${window}`;
}

function joinSummary(parts: (string | null)[]): string | null {
  const present = parts.filter((part): part is string => part !== null && part !== "");
  return present.length > 0 ? present.join(" · ") : null;
}

export function nodeSummary(node: FlowNodeDef, options: WorkflowEditorOptions): string | null {
  // "investigate" is registered in the worker's block registry but is not part
  // of the WorkflowBlockType union yet; the palette is data-driven, so the
  // type arrives here as a plain string once the worker ships the block.
  const nodeType: string = node.type;
  if (nodeType === "investigate") {
    const providers = investigateProviders(node);
    return joinSummary([providers.jira ? "jira" : null, providers.slack ? "slack" : null]);
  }
  switch (node.type) {
    case "trigger_ticket_ai":
      return rateLimitSummary(node);
    case "trigger_pr_created":
    case "trigger_pr_ready":
    case "trigger_pr_updated":
    case "trigger_pr_checks_failed":
    case "trigger_pr_merged":
      return joinSummary([
        node.params.scope === "any" ? "any PR" : "workflow-owned only",
        rateLimitSummary(node),
      ]);
    case "trigger_webhook":
      return joinSummary(["signed webhook endpoint", rateLimitSummary(node)]);
    case "trigger_schedule":
      return joinSummary(["recurring schedule", rateLimitSummary(node)]);
    case "trigger_pr_review": {
      const on = node.params.on;
      const scope = node.params.scope === "any" ? "any PR" : "workflow-owned only";
      const base =
        Array.isArray(on) && on.length > 0 ? `${scope} · on ${on.join(", ")}` : scope;
      return joinSummary([base, rateLimitSummary(node)]);
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
      if (node.v2) {
        const configuration = parseWorkflowBranchConfigurationV2(
          node.v2.configuration,
        );
        return configuration
          ? truncate(summarizeWorkflowBranchConfiguration(configuration))
          : "Condition needs setup";
      }
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
      // A named selection is what the block runs, so it names it the way
      // run_scripts does; only a node in neither mode falls back to the gate.
      const groups = node.params.groups;
      if (Array.isArray(groups) && groups.length > 0) {
        return truncate(groups.map(String).join(", "));
      }
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
    case "create_pr_check": {
      const name = str(node.params.checkName);
      return name !== "" ? truncate(name) : null;
    }
    case "complete_pr_check": {
      const conclusion = str(node.params.conclusion);
      return conclusion !== "" ? conclusion : null;
    }
    case "post_pr_review":
      return "combined review";
    case "open_pr": {
      const title = str(node.params.title);
      return title !== "" ? truncate(title) : null;
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
    case "run_scripts": {
      const groups = node.params.groups;
      return Array.isArray(groups) && groups.length > 0
        ? truncate(groups.map(String).join(", "))
        : null;
    }
    case "send_plan_approval": {
      return "awaits approval";
    }
    default:
      return null;
  }
}

export interface PaletteItem {
  id: string;
  type: WorkflowBlockType;
  name: string;
  params: Record<string, WorkflowParamValue>;
  presentation: WorkflowBlockPresentation;
  available: boolean;
  unavailableReason: string | null;
  templateId?: WorkflowEditorBlockTemplateId;
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

function paletteDefaults(
  contract: WorkflowEditorOptions["blockRegistry"][WorkflowBlockType],
  schemaVersion: 1 | 2,
): Record<string, WorkflowParamValue> {
  const defaults = { ...contract.defaults };
  if (schemaVersion === 2 && contract.type === "open_pr") {
    // The registry's Open PR prose templates are the v1 compatibility
    // templates and contain flat {{ticket_*}} variables. V2 leaves these
    // fields absent so it cannot seed placeholders that its canonical data
    // authoring/runtime deliberately rejects.
    delete defaults.title;
    delete defaults.body;
  }
  return defaults;
}

export function buildPaletteItems(
  options: WorkflowEditorOptions,
  schemaVersion: 1 | 2 = 1,
): PaletteGroup[] {
  // trigger_schedule (and other v2-only block types) never belong in a v1
  // palette: v1 has no executor for them and the schema forbids the type.
  const contracts = Object.values(options.blockRegistry).filter(
    (contract) =>
      // run_checks is retired from the palette: run_scripts covers the named
      // group run and run_pre_pr_checks the publication gate, and its own two
      // modes (commands vs groups) are the thing authors kept getting wrong.
      // Existing run_checks nodes still render, edit and deploy: only the
      // "add a new one" affordance is gone.
      contract.type !== "run_checks" &&
      (schemaVersion === 2 || !isV2OnlyBlockType(contract.type)),
  );
  const groups: PaletteGroup[] = GROUP_ORDER.flatMap((group) => {
    const groupContracts = contracts.filter((contract) => contract.presentation.group === group);
    if (groupContracts.length === 0) return [];
    return [{
      group,
      label: GROUP_LABELS[group],
      color: groupContracts[0]!.presentation.color,
      items: groupContracts.map((contract) => ({
        id: `block:${contract.type}`,
        type: contract.type,
        name: blockPresentation(options, contract.type).label,
        params: paletteDefaults(contract, schemaVersion),
        presentation: blockPresentation(options, contract.type),
        available: contract.availability.available,
        unavailableReason: contract.availability.unavailableReason,
      })),
    }];
  });
  if (schemaVersion === 1) return groups;

  for (const template of WORKFLOW_EDITOR_BLOCK_TEMPLATES) {
    // A composite whose source block left the palette would put it back, which
    // is the one thing retiring run_checks from the palette has to prevent.
    if (template.sourceType === "run_checks") continue;
    const source = options.blockRegistry[template.sourceType];
    if (!source) continue;
    const group = groups.find(
      (candidate) => candidate.group === source.presentation.group,
    );
    if (!group) continue;
    const sourceIndex = group.items.findIndex(
      (item) => item.type === template.sourceType && !item.templateId,
    );
    const item: PaletteItem = {
      id: `template:${template.id}`,
      templateId: template.id,
      type: template.sourceType,
      name: template.name,
      params: paletteDefaults(source, schemaVersion),
      presentation: {
        ...blockPresentation(options, template.sourceType),
        description: template.description,
      },
      available: source.availability.available,
      unavailableReason: source.availability.unavailableReason,
    };
    group.items.splice(sourceIndex < 0 ? group.items.length : sourceIndex + 1, 0, item);
  }
  return groups;
}
