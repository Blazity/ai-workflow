// THIS FILE IS GENERATED. DO NOT EDIT.
// Run pnpm run gen:blocks to update.

import { manifest as arthurInjectionCheckManifest } from "../blocks/arthur-injection-check/manifest.js";
import { manifest as branchManifest } from "../blocks/branch/manifest.js";
import { manifest as callLlmManifest } from "../blocks/call-llm/manifest.js";
import { manifest as completePrCheckManifest } from "../blocks/complete-pr-check/manifest.js";
import { manifest as createPrCheckManifest } from "../blocks/create-pr-check/manifest.js";
import { manifest as fetchPrContextManifest } from "../blocks/fetch-pr-context/manifest.js";
import { manifest as finalizeWorkspaceManifest } from "../blocks/finalize-workspace/manifest.js";
import { manifest as fixAgentManifest } from "../blocks/fix-agent/manifest.js";
import { manifest as genericAgentManifest } from "../blocks/generic-agent/manifest.js";
import { manifest as humanQuestionManifest } from "../blocks/human-question/manifest.js";
import { manifest as implementationAgentManifest } from "../blocks/implementation-agent/manifest.js";
import { manifest as investigateManifest } from "../blocks/investigate/manifest.js";
import { manifest as leakReviewManifest } from "../blocks/leak-review/manifest.js";
import { manifest as loopManifest } from "../blocks/loop/manifest.js";
import { manifest as openPrManifest } from "../blocks/open-pr/manifest.js";
import { manifest as planningAgentManifest } from "../blocks/planning-agent/manifest.js";
import { manifest as postPrCommentManifest } from "../blocks/post-pr-comment/manifest.js";
import { manifest as postPrReviewManifest } from "../blocks/post-pr-review/manifest.js";
import { manifest as postTicketCommentManifest } from "../blocks/post-ticket-comment/manifest.js";
import { manifest as prepareWorkspaceManifest } from "../blocks/prepare-workspace/manifest.js";
import { manifest as reviewAgentManifest } from "../blocks/review-agent/manifest.js";
import { manifest as runChecksManifest } from "../blocks/run-checks/manifest.js";
import { manifest as runPrePrChecksManifest } from "../blocks/run-pre-pr-checks/manifest.js";
import { manifest as runScriptsManifest } from "../blocks/run-scripts/manifest.js";
import { manifest as sendPlanApprovalManifest } from "../blocks/send-plan-approval/manifest.js";
import { manifest as sendSlackMessageManifest } from "../blocks/send-slack-message/manifest.js";
import { manifest as terminateManifest } from "../blocks/terminate/manifest.js";
import { manifest as transformManifest } from "../blocks/transform/manifest.js";
import { manifest as triggerPlanApprovedManifest } from "../blocks/trigger-plan-approved/manifest.js";
import { manifest as triggerPrChecksFailedManifest } from "../blocks/trigger-pr-checks-failed/manifest.js";
import { manifest as triggerPrCreatedManifest } from "../blocks/trigger-pr-created/manifest.js";
import { manifest as triggerPrMergedManifest } from "../blocks/trigger-pr-merged/manifest.js";
import { manifest as triggerPrReadyManifest } from "../blocks/trigger-pr-ready/manifest.js";
import { manifest as triggerPrReviewManifest } from "../blocks/trigger-pr-review/manifest.js";
import { manifest as triggerPrUpdatedManifest } from "../blocks/trigger-pr-updated/manifest.js";
import { manifest as triggerScheduleManifest } from "../blocks/trigger-schedule/manifest.js";
import { manifest as triggerTicketAiManifest } from "../blocks/trigger-ticket-ai/manifest.js";
import { manifest as triggerWebhookManifest } from "../blocks/trigger-webhook/manifest.js";
import { manifest as updateTicketStatusManifest } from "../blocks/update-ticket-status/manifest.js";

export const BLOCK_PARAM_SCHEMAS = {
  arthur_injection_check: arthurInjectionCheckManifest.paramsSchema,
  branch: branchManifest.paramsSchema,
  call_llm: callLlmManifest.paramsSchema,
  complete_pr_check: completePrCheckManifest.paramsSchema,
  create_pr_check: createPrCheckManifest.paramsSchema,
  fetch_pr_context: fetchPrContextManifest.paramsSchema,
  finalize_workspace: finalizeWorkspaceManifest.paramsSchema,
  fix_agent: fixAgentManifest.paramsSchema,
  generic_agent: genericAgentManifest.paramsSchema,
  human_question: humanQuestionManifest.paramsSchema,
  implementation_agent: implementationAgentManifest.paramsSchema,
  investigate: investigateManifest.paramsSchema,
  leak_review: leakReviewManifest.paramsSchema,
  loop: loopManifest.paramsSchema,
  open_pr: openPrManifest.paramsSchema,
  planning_agent: planningAgentManifest.paramsSchema,
  post_pr_comment: postPrCommentManifest.paramsSchema,
  post_pr_review: postPrReviewManifest.paramsSchema,
  post_ticket_comment: postTicketCommentManifest.paramsSchema,
  prepare_workspace: prepareWorkspaceManifest.paramsSchema,
  review_agent: reviewAgentManifest.paramsSchema,
  run_checks: runChecksManifest.paramsSchema,
  run_pre_pr_checks: runPrePrChecksManifest.paramsSchema,
  run_scripts: runScriptsManifest.paramsSchema,
  send_plan_approval: sendPlanApprovalManifest.paramsSchema,
  send_slack_message: sendSlackMessageManifest.paramsSchema,
  terminate: terminateManifest.paramsSchema,
  transform: transformManifest.paramsSchema,
  trigger_plan_approved: triggerPlanApprovedManifest.paramsSchema,
  trigger_pr_checks_failed: triggerPrChecksFailedManifest.paramsSchema,
  trigger_pr_created: triggerPrCreatedManifest.paramsSchema,
  trigger_pr_merged: triggerPrMergedManifest.paramsSchema,
  trigger_pr_ready: triggerPrReadyManifest.paramsSchema,
  trigger_pr_review: triggerPrReviewManifest.paramsSchema,
  trigger_pr_updated: triggerPrUpdatedManifest.paramsSchema,
  trigger_schedule: triggerScheduleManifest.paramsSchema,
  trigger_ticket_ai: triggerTicketAiManifest.paramsSchema,
  trigger_webhook: triggerWebhookManifest.paramsSchema,
  update_ticket_status: updateTicketStatusManifest.paramsSchema,
} as const;

export const paramsSchemas = BLOCK_PARAM_SCHEMAS;

export const arthurInjectionCheckParams = BLOCK_PARAM_SCHEMAS.arthur_injection_check;
export const branchParams = BLOCK_PARAM_SCHEMAS.branch;
export const callLlmParams = BLOCK_PARAM_SCHEMAS.call_llm;
export const completePrCheckParams = BLOCK_PARAM_SCHEMAS.complete_pr_check;
export const createPrCheckParams = BLOCK_PARAM_SCHEMAS.create_pr_check;
export const fetchPrContextParams = BLOCK_PARAM_SCHEMAS.fetch_pr_context;
export const finalizeWorkspaceParams = BLOCK_PARAM_SCHEMAS.finalize_workspace;
export const fixAgentParams = BLOCK_PARAM_SCHEMAS.fix_agent;
export const genericAgentParams = BLOCK_PARAM_SCHEMAS.generic_agent;
export const humanQuestionParams = BLOCK_PARAM_SCHEMAS.human_question;
export const implementationAgentParams = BLOCK_PARAM_SCHEMAS.implementation_agent;
export const investigateParams = BLOCK_PARAM_SCHEMAS.investigate;
export const leakReviewParams = BLOCK_PARAM_SCHEMAS.leak_review;
export const loopParams = BLOCK_PARAM_SCHEMAS.loop;
export const openPrParams = BLOCK_PARAM_SCHEMAS.open_pr;
export const planningAgentParams = BLOCK_PARAM_SCHEMAS.planning_agent;
export const postPrCommentParams = BLOCK_PARAM_SCHEMAS.post_pr_comment;
export const postPrReviewParams = BLOCK_PARAM_SCHEMAS.post_pr_review;
export const postTicketCommentParams = BLOCK_PARAM_SCHEMAS.post_ticket_comment;
export const prepareWorkspaceParams = BLOCK_PARAM_SCHEMAS.prepare_workspace;
export const reviewAgentParams = BLOCK_PARAM_SCHEMAS.review_agent;
export const runChecksParams = BLOCK_PARAM_SCHEMAS.run_checks;
export const runPrePrChecksParams = BLOCK_PARAM_SCHEMAS.run_pre_pr_checks;
export const runScriptsParams = BLOCK_PARAM_SCHEMAS.run_scripts;
export const sendPlanApprovalParams = BLOCK_PARAM_SCHEMAS.send_plan_approval;
export const sendSlackMessageParams = BLOCK_PARAM_SCHEMAS.send_slack_message;
export const terminateParams = BLOCK_PARAM_SCHEMAS.terminate;
export const transformParams = BLOCK_PARAM_SCHEMAS.transform;
export const triggerPlanApprovedParams = BLOCK_PARAM_SCHEMAS.trigger_plan_approved;
export const triggerPrChecksFailedParams = BLOCK_PARAM_SCHEMAS.trigger_pr_checks_failed;
export const triggerPrCreatedParams = BLOCK_PARAM_SCHEMAS.trigger_pr_created;
export const triggerPrMergedParams = BLOCK_PARAM_SCHEMAS.trigger_pr_merged;
export const triggerPrReadyParams = BLOCK_PARAM_SCHEMAS.trigger_pr_ready;
export const triggerPrReviewParams = BLOCK_PARAM_SCHEMAS.trigger_pr_review;
export const triggerPrUpdatedParams = BLOCK_PARAM_SCHEMAS.trigger_pr_updated;
export const triggerScheduleParams = BLOCK_PARAM_SCHEMAS.trigger_schedule;
export const triggerTicketAiParams = BLOCK_PARAM_SCHEMAS.trigger_ticket_ai;
export const triggerWebhookParams = BLOCK_PARAM_SCHEMAS.trigger_webhook;
export const updateTicketStatusParams = BLOCK_PARAM_SCHEMAS.update_ticket_status;
