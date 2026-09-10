import { createElement } from "react";
import type { WorkflowBlockType } from "@shared/contracts";
import type { BlockRenderer, BlockRendererProps } from "./types";
import { ArthurInjectionCheckFields } from "./arthur_injection_check";
import { BranchFields } from "./branch";
import { CallLlmFields } from "./call_llm";
import { CompletePrCheckFields } from "./complete_pr_check";
import { CreatePrCheckFields } from "./create_pr_check";
import { FetchPrContextFields } from "./fetch_pr_context";
import { FinalizeWorkspaceFields } from "./finalize_workspace";
import { FixAgentFields } from "./fix_agent";
import { GenericAgentFields } from "./generic_agent";
import { HumanQuestionFields } from "./human_question";
import { ImplementationAgentFields } from "./implementation_agent";
import { InvestigateFields } from "./investigate";
import { LeakReviewFields } from "./leak_review";
import { LoopFields } from "./loop";
import { OpenPrFields } from "./open_pr";
import { PlanningAgentFields } from "./planning_agent";
import { PostPrCommentFields } from "./post_pr_comment";
import { PostPrReviewFields } from "./post_pr_review";
import { PostTicketCommentFields } from "./post_ticket_comment";
import { PrepareWorkspaceFields } from "./prepare_workspace";
import { ReviewAgentFields } from "./review_agent";
import { RunChecksFields } from "./run_checks";
import { RunPrePrChecksFields } from "./run_pre_pr_checks";
import { RunScriptsFields } from "./run_scripts";
import { SendPlanApprovalFields } from "./send_plan_approval";
import { SendSlackMessageFields } from "./send_slack_message";
import { TerminateFields } from "./terminate";
import { TransformConfigFields } from "./transform";
import { TriggerPlanApprovedFields } from "./trigger_plan_approved";
import { TriggerPrChecksFailedFields } from "./trigger_pr_checks_failed";
import { TriggerPrCreatedFields } from "./trigger_pr_created";
import { TriggerPrMergedFields } from "./trigger_pr_merged";
import { TriggerPrReadyFields } from "./trigger_pr_ready";
import { TriggerPrReviewFields } from "./trigger_pr_review";
import { TriggerPrUpdatedFields } from "./trigger_pr_updated";
import { TriggerScheduleFields } from "./trigger_schedule";
import { TriggerTicketAiFields } from "./trigger_ticket_ai";
import { TriggerWebhookFields } from "./trigger_webhook";
import { UpdateTicketStatusFields } from "./update_ticket_status";

const BLOCK_RENDERERS = {
  arthur_injection_check: ArthurInjectionCheckFields,
  branch: BranchFields,
  call_llm: CallLlmFields,
  complete_pr_check: CompletePrCheckFields,
  create_pr_check: CreatePrCheckFields,
  fetch_pr_context: FetchPrContextFields,
  finalize_workspace: FinalizeWorkspaceFields,
  fix_agent: FixAgentFields,
  generic_agent: GenericAgentFields,
  human_question: HumanQuestionFields,
  implementation_agent: ImplementationAgentFields,
  investigate: InvestigateFields,
  leak_review: LeakReviewFields,
  loop: LoopFields,
  open_pr: OpenPrFields,
  planning_agent: PlanningAgentFields,
  post_pr_comment: PostPrCommentFields,
  post_pr_review: PostPrReviewFields,
  post_ticket_comment: PostTicketCommentFields,
  prepare_workspace: PrepareWorkspaceFields,
  review_agent: ReviewAgentFields,
  run_checks: RunChecksFields,
  run_pre_pr_checks: RunPrePrChecksFields,
  run_scripts: RunScriptsFields,
  send_plan_approval: SendPlanApprovalFields,
  send_slack_message: SendSlackMessageFields,
  terminate: TerminateFields,
  transform: TransformConfigFields,
  trigger_plan_approved: TriggerPlanApprovedFields,
  trigger_pr_checks_failed: TriggerPrChecksFailedFields,
  trigger_pr_created: TriggerPrCreatedFields,
  trigger_pr_merged: TriggerPrMergedFields,
  trigger_pr_ready: TriggerPrReadyFields,
  trigger_pr_review: TriggerPrReviewFields,
  trigger_pr_updated: TriggerPrUpdatedFields,
  trigger_schedule: TriggerScheduleFields,
  trigger_ticket_ai: TriggerTicketAiFields,
  trigger_webhook: TriggerWebhookFields,
  update_ticket_status: UpdateTicketStatusFields,
} satisfies Record<WorkflowBlockType, BlockRenderer>;

export function ConfigFields(props: BlockRendererProps) {
  return createElement(BLOCK_RENDERERS[props.node.type], props);
}
