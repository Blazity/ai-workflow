// THIS FILE IS GENERATED. DO NOT EDIT.
// Run pnpm run gen:blocks to update.

import { execute as arthurInjectionCheckExecute } from "./arthur-injection-check/execute.js";
import { execute as callLlmExecute } from "./call-llm/execute.js";
import { execute as completePrCheckExecute } from "./complete-pr-check/execute.js";
import { execute as createPrCheckExecute } from "./create-pr-check/execute.js";
import { execute as fetchPrContextExecute } from "./fetch-pr-context/execute.js";
import { execute as finalizeWorkspaceExecute } from "./finalize-workspace/execute.js";
import { execute as fixAgentExecute } from "./fix-agent/execute.js";
import { execute as genericAgentExecute } from "./generic-agent/execute.js";
import { execute as humanQuestionExecute } from "./human-question/execute.js";
import { execute as investigateExecute } from "./investigate/execute.js";
import { execute as leakReviewExecute } from "./leak-review/execute.js";
import { execute as postPrCommentExecute } from "./post-pr-comment/execute.js";
import { execute as postPrReviewExecute } from "./post-pr-review/execute.js";
import { execute as postTicketCommentExecute } from "./post-ticket-comment/execute.js";
import { execute as runChecksExecute } from "./run-checks/execute.js";
import { execute as runScriptsExecute } from "./run-scripts/execute.js";
import { execute as sendPlanApprovalExecute } from "./send-plan-approval/execute.js";
import type { BlockExecuteFn } from "./support/types.js";
import type { WorkflowBlockType } from "@shared/contracts";

export const BLOCK_EXECUTORS: Partial<Record<WorkflowBlockType, BlockExecuteFn>> = {
  arthur_injection_check: arthurInjectionCheckExecute,
  call_llm: callLlmExecute,
  complete_pr_check: completePrCheckExecute,
  create_pr_check: createPrCheckExecute,
  fetch_pr_context: fetchPrContextExecute,
  finalize_workspace: finalizeWorkspaceExecute,
  fix_agent: fixAgentExecute,
  generic_agent: genericAgentExecute,
  human_question: humanQuestionExecute,
  investigate: investigateExecute,
  leak_review: leakReviewExecute,
  post_pr_comment: postPrCommentExecute,
  post_pr_review: postPrReviewExecute,
  post_ticket_comment: postTicketCommentExecute,
  run_checks: runChecksExecute,
  run_scripts: runScriptsExecute,
  send_plan_approval: sendPlanApprovalExecute,
};

export const INLINE_EXECUTED_BLOCK_TYPES: readonly WorkflowBlockType[] = [
  "implementation_agent",
  "open_pr",
  "planning_agent",
  "prepare_workspace",
  "review_agent",
  "run_pre_pr_checks",
  "send_slack_message",
  "update_ticket_status",
];
