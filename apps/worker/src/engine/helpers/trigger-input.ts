import { type AgentWorkflowInput } from "../agent-input.js";
import type { HumanDecision } from "../support/human-decisions-memory.js";
import { appendClarificationRound } from "./prompt-output.js";
import type { BlockOutput, JsonValue, WorkflowBlockType, WorkflowDefinitionNode } from "@shared/contracts";

export function triggerTypeFor(entry: AgentWorkflowInput): WorkflowBlockType {
  if (entry.kind === "pr_trigger") return entry.triggerType;
  if (entry.kind === "webhook_trigger") return "trigger_webhook";
  if (entry.kind === "schedule") return "trigger_schedule";
  if (entry.kind === "plan_approved") return "trigger_plan_approved";
  return "trigger_ticket_ai";
}

export function triggerOutputFor(entry: AgentWorkflowInput): BlockOutput {
  return triggerOutputWithTicketContext(entry);
}

/**
 * Pick the node the run enters through. A definition may carry several
 * trigger_webhook or trigger_schedule nodes and each endpoint or schedule row
 * owns exactly one of them, so those select by their own node id: matching on
 * type alone would silently start another endpoint's or schedule's graph. Every
 * other kind has at most one trigger of its type, so type matching stays correct
 * for them.
 */
export function selectEntryTriggerNode(
  nodes: readonly WorkflowDefinitionNode[],
  entryTriggerType: WorkflowBlockType,
  entry: AgentWorkflowInput,
): WorkflowDefinitionNode | undefined {
  if (entry.kind === "webhook_trigger" || entry.kind === "schedule") {
    return nodes.find(
      (node) => node.id === entry.nodeId && node.type === entryTriggerType,
    );
  }
  return nodes.find((node) => node.type === entryTriggerType);
}

interface WorkflowTicketInputContext {
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  labels: string[];
  comments: Array<{ author: string; body: string; createdAt?: string }>;
  priorAnswers?: Array<{
    questions: string[];
    answer: string;
    answeredBy?: string;
    answeredAt?: string;
  }>;
  clarifications?: Array<{
    questions: string[];
    answer: string;
    answeredBy?: string;
    answeredAt?: string;
  }>;
}

function ticketBindingFields(
  entry: AgentWorkflowInput,
  ticket: WorkflowTicketInputContext | undefined,
): Record<string, JsonValue> {
  if (
    !ticket ||
    (entry.kind === "pr_trigger" &&
      (entry.scope !== "workflow_owned" || entry.ticketKey === undefined))
  ) {
    return {};
  }
  const comments = ticket.comments.map((comment) => ({
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt ?? "",
  }));
  const priorAnswers = (ticket.clarifications ?? []).map((answer) => ({
    questions: answer.questions,
    answer: answer.answer,
    ...(answer.answeredBy === undefined ? {} : { answeredBy: answer.answeredBy }),
    ...(answer.answeredAt === undefined ? {} : { answeredAt: answer.answeredAt }),
  }));
  return {
    ticket: {
      identifier: ticket.identifier,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      labels: ticket.labels,
      comments,
      priorAnswers,
    },
    comments,
    priorAnswers,
  };
}

export function triggerOutputWithTicketContext(
  entry: AgentWorkflowInput,
  ticket?: WorkflowTicketInputContext,
): BlockOutput {
  const ticketFields = ticketBindingFields(entry, ticket);
  if (entry.kind === "pr_trigger") {
    const { pr } = entry;
    const output: BlockOutput = {
      status: "fired",
      ...(entry.scope === "workflow_owned" && entry.ticketKey
        ? { ticketKey: entry.ticketKey }
        : {}),
      provider: pr.provider,
      repoPath: pr.repoPath,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      headRef: pr.headRef,
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      title: pr.title,
      author: pr.author,
      isDraft: pr.isDraft,
      ...ticketFields,
    };
    if (pr.failedChecks) {
      output.failedChecks = pr.failedChecks.map((check) => ({
        name: check.name,
        conclusion: check.conclusion,
        ...(check.detailsUrl !== undefined ? { detailsUrl: check.detailsUrl } : {}),
      }));
    }
    if (pr.review) {
      output.review = {
        state: pr.review.state,
        author: pr.review.author,
        body: pr.review.body,
      };
    }
    if (pr.mergeSha) output.mergeSha = pr.mergeSha;
    if (pr.mergedAt) output.mergedAt = pr.mergedAt;
    return output;
  }
  if (entry.kind === "webhook_trigger") {
    // Explicit branch: the ticket fallback below publishes a ticketKey a
    // webhook run never has, and the endpoint's mapped fields are the contract.
    return {
      status: "fired",
      subject: entry.entry.subject,
      description: entry.entry.description,
      requester: entry.entry.requester,
      priority: entry.entry.priority,
      payload: entry.entry.payload,
      ...(entry.entry.supportCase === undefined
        ? {}
        : { supportCase: entry.entry.supportCase }),
    };
  }
  if (entry.kind === "schedule") {
    // Explicit branch for the same reason as the webhook one: the ticket fallback
    // below publishes a ticketKey, and a run started by a clock has no ticket.
    // The occurrence instants are what let the task be written relative to the
    // previous run, so they are part of the trigger's contract, not diagnostics.
    return {
      status: "fired",
      scheduledFor: entry.scheduledFor,
      ...(entry.previousScheduledFor === undefined
        ? {}
        : { previousScheduledFor: entry.previousScheduledFor }),
      taskTitle: entry.taskTitle,
      taskDescription: entry.taskDescription,
    };
  }
  if (entry.kind === "plan_approved") {
    return {
      status: "fired",
      ticketKey: entry.ticketKey,
      approvedPlan: entry.approvedPlan.markdown,
      approver: entry.approval.approver,
      approvedAt: entry.approval.approvedAt,
      ...ticketFields,
    };
  }
  return { status: "fired", ticketKey: entry.ticketKey, ...ticketFields };
}

export function resolveImplementationPlanInput(
  resolvedInputs: Record<string, unknown>,
  legacyPlan: string,
): string {
  if (!Object.prototype.hasOwnProperty.call(resolvedInputs, "plan")) return legacyPlan;
  if (typeof resolvedInputs.plan !== "string") {
    throw new Error('Implementation input "plan" must be a string.');
  }
  return resolvedInputs.plan;
}

function resolveAgentTicketInput(
  resolvedInputs: Record<string, unknown>,
  fallback: WorkflowTicketInputContext,
  liveClarifications?: HumanDecision[],
): WorkflowTicketInputContext {
  const base = resolveAgentTicketInputFromBindings(resolvedInputs, fallback);
  if (!liveClarifications || liveClarifications.length === 0) return base;
  // Same-run clarification rounds (answered via the in-run hook) postdate both
  // the journaled trigger output and the run-start ticket snapshot, so a
  // re-executed agent phase would otherwise never see the answer it just asked
  // for. Merge them in; appendClarificationRound dedupes rounds the snapshot
  // already carries. Mirrors fix-agent's live read of ctx.clarifications.
  let clarifications = base.clarifications;
  for (const round of liveClarifications) {
    clarifications = appendClarificationRound(clarifications, round);
  }
  if (clarifications === base.clarifications) return base;
  return { ...base, clarifications };
}

function resolveAgentTicketInputFromBindings(
  resolvedInputs: Record<string, unknown>,
  fallback: WorkflowTicketInputContext,
): WorkflowTicketInputContext {
  if (!Object.prototype.hasOwnProperty.call(resolvedInputs, "ticket")) return fallback;
  if (
    resolvedInputs.ticket === null ||
    typeof resolvedInputs.ticket !== "object" ||
    Array.isArray(resolvedInputs.ticket)
  ) {
    throw new Error('Agent input "ticket" must be a ticket context object.');
  }
  const ticket = resolvedInputs.ticket as WorkflowTicketInputContext;
  const comments = Object.prototype.hasOwnProperty.call(resolvedInputs, "comments")
    ? resolvedInputs.comments
    : ticket.comments;
  const priorAnswers = Object.prototype.hasOwnProperty.call(resolvedInputs, "priorAnswers")
    ? resolvedInputs.priorAnswers
    : ticket.priorAnswers ?? ticket.clarifications ?? [];
  if (!Array.isArray(comments)) {
    throw new Error('Planning input "comments" must be an array.');
  }
  if (!Array.isArray(priorAnswers)) {
    throw new Error('Planning input "priorAnswers" must be an array.');
  }
  return {
    ...ticket,
    comments: comments as WorkflowTicketInputContext["comments"],
    ...(priorAnswers.length === 0
      ? {}
      : {
          clarifications:
            priorAnswers as NonNullable<WorkflowTicketInputContext["clarifications"]>,
        }),
  };
}
export { resolveAgentTicketInput };
