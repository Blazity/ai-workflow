import {
  REVIEW_RESULT_JSON_SCHEMA,
  type HarnessProvider,
  type HarnessProfileReference,
  type WorkflowDefinitionTemplate,
  type WorkflowDataReferenceV2,
  type WorkflowDefinitionV2,
} from "@shared/contracts";
import {
  buildBuiltinV2Definition,
  builtinHarnessProfileConfiguration,
  defaultWorkflowDefinitionV2,
  type V2BlockSpec,
} from "./default.js";

export const DEFAULT_WORKFLOW_TEMPLATE_ID = "ticket-workflow";

interface TemplateOptions {
  includeReview: boolean;
  includeLeakReview?: boolean;
  provider?: HarnessProvider;
  profileReference?: HarnessProfileReference;
}

function humanApprovedPlanDefinition(
  provider: HarnessProvider,
  profileReference?: HarnessProfileReference,
): WorkflowDefinitionV2 {
  const profile = () =>
    builtinHarnessProfileConfiguration(provider, profileReference);
  const specs: V2BlockSpec[] = [
    {
      id: "trigger-ticket",
      type: "trigger_ticket_ai",
      name: "Ticket assigned to AI",
      column: 0,
      row: 0,
    },
    {
      id: "prepare-plan",
      type: "prepare_workspace",
      name: "Prepare planning workspace",
      column: 1,
      row: 0,
    },
    {
      id: "planning",
      type: "planning_agent",
      name: "Planning agent",
      column: 2,
      row: 0,
      configuration: {
        ...profile(),
        prompt: "{{prompt:research-plan@1}}",
      },
      inputs: {
        ticket: {
          kind: "reference",
          reference: "steps.entry.output.ticket",
        },
        comments: {
          kind: "reference",
          reference: "steps.entry.output.comments",
        },
        priorAnswers: {
          kind: "reference",
          reference: "steps.entry.output.priorAnswers",
        },
      },
    },
    {
      id: "send-approval",
      type: "send_plan_approval",
      name: "Send plan for approval",
      column: 3,
      row: 0,
      inputs: {
        plan: {
          kind: "reference",
          reference: "steps.planning.output.plan",
        },
      },
    },
    {
      id: "trigger-approved",
      type: "trigger_plan_approved",
      name: "Plan approved",
      column: 0,
      row: 1,
    },
    {
      id: "prepare-implementation",
      type: "prepare_workspace",
      name: "Prepare implementation workspace",
      column: 1,
      row: 1,
    },
    {
      id: "implementation",
      type: "implementation_agent",
      name: "Implementation agent",
      column: 2,
      row: 1,
      configuration: {
        ...profile(),
        prompt: "{{prompt:implement@1}}",
      },
      inputs: {
        ticket: {
          kind: "reference",
          reference: "steps.entry.output.ticket",
        },
        plan: {
          kind: "reference",
          reference: "steps.entry.output.approvedPlan",
        },
      },
    },
    {
      id: "checks",
      type: "run_pre_pr_checks",
      name: "Run pre-PR checks",
      column: 3,
      row: 1,
    },
    {
      id: "finalize",
      type: "finalize_workspace",
      name: "Finalize workspace",
      column: 4,
      row: 1,
    },
    {
      id: "open-pr",
      type: "open_pr",
      name: "Open pull request",
      column: 5,
      row: 1,
      inputs: {
        repositories: {
          kind: "reference",
          reference: "steps.finalize.output.repositories",
        },
      },
    },
    {
      id: "status",
      type: "update_ticket_status",
      name: "Update ticket status",
      column: 6,
      row: 1,
      configuration: { target: "ai_review" },
    },
  ];
  return buildBuiltinV2Definition("human-approved-plan", specs, [
    { from: "trigger-ticket", to: "prepare-plan" },
    { from: "prepare-plan", to: "planning" },
    { from: "planning", to: "send-approval" },
    { from: "trigger-approved", to: "prepare-implementation" },
    { from: "prepare-implementation", to: "implementation" },
    { from: "implementation", to: "checks" },
    { from: "checks", to: "finalize" },
    { from: "finalize", to: "open-pr" },
    { from: "open-pr", to: "status" },
  ]);
}

function reviewFixAfterPrDefinition(
  provider: HarnessProvider,
  profileReference?: HarnessProfileReference,
): WorkflowDefinitionV2 {
  const specs: V2BlockSpec[] = [
    {
      id: "trigger-checks-failed",
      type: "trigger_pr_checks_failed",
      name: "PR checks failed",
      column: 0,
      row: 0,
      configuration: {
        providers: ["github", "gitlab"],
        scope: "workflow_owned",
        checkNames: ["CI"],
        githubAppSlugs: ["github-actions"],
        gitlabPipelineSources: ["merge_request_event"],
      },
    },
    {
      id: "trigger-review",
      type: "trigger_pr_review",
      name: "PR review submitted",
      column: 0,
      row: 1,
      configuration: {
        providers: ["github"],
        on: ["changes_requested"],
        scope: "workflow_owned",
      },
    },
    {
      id: "prepare",
      type: "prepare_workspace",
      name: "Prepare workspace",
      column: 1,
      row: 0,
    },
    {
      id: "fetch-context",
      type: "fetch_pr_context",
      name: "Fetch PR context",
      column: 2,
      row: 0,
    },
    {
      id: "fix",
      type: "fix_agent",
      name: "Fix agent",
      column: 3,
      row: 0,
      configuration: {
        ...builtinHarnessProfileConfiguration(provider, profileReference),
        instructions:
          "Resolve the fetched pull-request review feedback or failing checks, verify the fix, and commit the resulting changes.",
      },
    },
    {
      id: "checks",
      type: "run_pre_pr_checks",
      name: "Run pre-PR checks",
      column: 4,
      row: 0,
    },
    {
      id: "finalize",
      type: "finalize_workspace",
      name: "Finalize workspace",
      column: 5,
      row: 0,
    },
    {
      id: "comment",
      type: "post_pr_comment",
      name: "Post PR comment",
      column: 6,
      row: 0,
      configuration: {
        body: "Automated fix pushed. Please re-review.",
        target: "all",
      },
    },
  ];
  return buildBuiltinV2Definition("review-fix-after-pr", specs, [
    { from: "trigger-checks-failed", to: "prepare" },
    { from: "trigger-review", to: "prepare" },
    { from: "prepare", to: "fetch-context" },
    { from: "fetch-context", to: "fix" },
    { from: "fix", to: "checks" },
    { from: "checks", to: "finalize" },
    { from: "finalize", to: "comment" },
  ]);
}

function fullyModularDefinition(
  provider: HarnessProvider,
  profileReference?: HarnessProfileReference,
): WorkflowDefinitionV2 {
  const planningOutput = JSON.stringify({
    type: "object",
    properties: { plan: { type: "string" } },
    required: ["plan"],
    additionalProperties: false,
  });
  const implementationOutput = JSON.stringify({
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  });
  const specs: V2BlockSpec[] = [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      name: "Ticket assigned to AI",
      column: 0,
    },
    {
      id: "prepare",
      type: "prepare_workspace",
      name: "Prepare workspace",
      column: 1,
    },
    {
      id: "planning",
      type: "generic_agent",
      name: "Generic agent — planning",
      column: 2,
      configuration: {
        ...builtinHarnessProfileConfiguration(provider, profileReference),
        prompt: "Produce an implementation plan for this ticket.",
        outputSchema: planningOutput,
        outputSchemaDialect:
          "https://json-schema.org/draft/2020-12/schema",
        workspaceMode: "none",
      },
    },
    {
      id: "implementation",
      type: "generic_agent",
      name: "Generic agent — implementation",
      column: 3,
      configuration: {
        ...builtinHarnessProfileConfiguration(provider, profileReference),
        prompt:
          "Implement this plan in the prepared workspace:\n\n{{data:steps.planning.output.plan}}",
        outputSchema: implementationOutput,
        outputSchemaDialect:
          "https://json-schema.org/draft/2020-12/schema",
        workspaceMode: "read_write",
      },
    },
    {
      id: "checks",
      type: "run_checks",
      name: "Run checks",
      column: 4,
      configuration: { commands: [] },
    },
    {
      id: "checks-passed",
      type: "branch",
      name: "Checks passed?",
      column: 5,
      configuration: {
        combinator: "all",
        conditions: [{
          reference: "steps.checks.output.outcome",
          operator: "equals",
          value: "passed",
        }],
      },
    },
    {
      id: "finalize",
      type: "finalize_workspace",
      name: "Finalize workspace",
      column: 6,
      row: -1,
    },
    {
      id: "open-pr",
      type: "open_pr",
      name: "Open pull request",
      column: 7,
      row: -1,
      inputs: {
        repositories: {
          kind: "reference",
          reference: "steps.finalize.output.repositories",
        },
      },
    },
    {
      id: "checks-failed",
      type: "terminate",
      name: "Stop after failed checks",
      column: 6,
      row: 1,
      configuration: { terminalStatus: "failed" },
    },
  ];
  return buildBuiltinV2Definition("fully-modular", specs, [
    { from: "trigger", to: "prepare" },
    { from: "prepare", to: "planning" },
    { from: "planning", to: "implementation" },
    { from: "implementation", to: "checks" },
    { from: "checks", to: "checks-passed" },
    {
      from: "checks-passed",
      fromPort: "true",
      to: "finalize",
    },
    {
      from: "checks-passed",
      fromPort: "false",
      to: "checks-failed",
    },
    { from: "finalize", to: "open-pr" },
  ]);
}

function webhookTicketTriageDefinition(
  provider: HarnessProvider,
  profileReference?: HarnessProfileReference,
): WorkflowDefinitionV2 {
  const profile = () =>
    builtinHarnessProfileConfiguration(provider, profileReference);
  const triageOutput = JSON.stringify({
    type: "object",
    properties: {
      category: { type: "string" },
      summary: { type: "string" },
    },
    required: ["category", "summary"],
    additionalProperties: false,
  });
  const assessmentOutput = JSON.stringify({
    type: "object",
    properties: {
      severity: {
        type: "string",
        enum: ["low", "medium", "high", "critical"],
      },
      codeIssue: { type: "boolean" },
      rationale: { type: "string" },
    },
    required: ["severity", "codeIssue", "rationale"],
    additionalProperties: false,
  });
  const fixOutput = JSON.stringify({
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  });
  const specs: V2BlockSpec[] = [
    {
      id: "trigger",
      type: "trigger_webhook",
      name: "Zendesk ticket received",
      column: 0,
    },
    {
      id: "triage",
      type: "generic_agent",
      name: "Triage ticket",
      column: 1,
      configuration: {
        ...profile(),
        prompt:
          "Triage this incoming support ticket. Categorize it and summarize the reported issue.\n\n" +
          "Subject: {{data:steps.entry.output.subject}}\n" +
          "Requester: {{data:steps.entry.output.requester}}\n" +
          "Reported priority: {{data:steps.entry.output.priority}}\n\n" +
          "Description:\n{{data:steps.entry.output.description}}",
        outputSchema: triageOutput,
        outputSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
        workspaceMode: "none",
      },
    },
    {
      id: "assess",
      type: "generic_agent",
      name: "Assess criticality",
      column: 2,
      configuration: {
        ...profile(),
        prompt:
          "Assess how critical this triaged ticket is and decide whether resolving it requires a code change.\n\n" +
          "Category: {{data:steps.triage.output.category}}\n" +
          "Reported priority: {{data:steps.entry.output.priority}}\n\n" +
          "Triage summary:\n{{data:steps.triage.output.summary}}",
        outputSchema: assessmentOutput,
        outputSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
        workspaceMode: "none",
      },
    },
    {
      id: "code-issue",
      type: "branch",
      name: "Code issue?",
      column: 3,
      configuration: {
        combinator: "all",
        conditions: [{
          reference: "steps.assess.output.codeIssue",
          operator: "equals",
          value: true,
        }],
      },
    },
    {
      id: "prepare",
      type: "prepare_workspace",
      name: "Prepare workspace",
      column: 1,
      row: 1,
    },
    {
      id: "implement",
      type: "generic_agent",
      name: "Implement fix",
      column: 2,
      row: 1,
      configuration: {
        ...profile(),
        prompt:
          "Implement the smallest safe fix for this ticket in the prepared workspace, then commit it.\n\n" +
          "Triage summary:\n{{data:steps.triage.output.summary}}\n\n" +
          "Assessment:\n{{data:steps.assess.output.rationale}}",
        outputSchema: fixOutput,
        outputSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
        workspaceMode: "read_write",
      },
    },
    {
      id: "finalize",
      type: "finalize_workspace",
      name: "Finalize workspace",
      column: 3,
      row: 1,
    },
    {
      id: "open-pr",
      type: "open_pr",
      name: "Open fix PR",
      column: 4,
      row: 1,
      inputs: {
        repositories: {
          kind: "reference",
          reference: "steps.finalize.output.repositories",
        },
      },
    },
    {
      id: "notify",
      type: "send_slack_message",
      name: "Notify team",
      column: 5,
      row: 1,
      configuration: {
        message: "A fix pull request is open for the triaged webhook ticket.",
        sendOn: "always",
      },
    },
    {
      id: "notify-no-code",
      type: "send_slack_message",
      name: "Notify team (no code change)",
      column: 4,
      row: 0,
      configuration: {
        message:
          "The triaged webhook ticket needs no code change; a human should pick it up.",
        sendOn: "always",
      },
    },
  ];
  return buildBuiltinV2Definition("webhook-ticket-triage", specs, [
    { from: "trigger", to: "triage" },
    { from: "triage", to: "assess" },
    { from: "assess", to: "code-issue" },
    { from: "code-issue", fromPort: "true", to: "prepare" },
    { from: "prepare", to: "implement" },
    { from: "implement", to: "finalize" },
    { from: "finalize", to: "open-pr" },
    { from: "open-pr", to: "notify" },
    { from: "code-issue", fromPort: "false", to: "notify-no-code" },
  ]);
}

const REVIEW_TASKS = {
  security:
    "Review the implementation for security vulnerabilities, unsafe trust boundaries, credential exposure, and abuse cases. Do not modify files. Report concrete findings only.",
  quality:
    "Review the implementation for correctness, maintainability, test coverage, regressions, and adherence to repository conventions. Do not modify files. Report concrete findings only.",
  requirements:
    "Review the implementation against the ticket, approved plan, and acceptance criteria. Do not modify files. Report concrete gaps only.",
} as const;

const REVIEW_IDS = [
  "security-review",
  "quality-review",
  "requirements-review",
] as const;

function reviewedTicketDefinition(
  provider: HarnessProvider,
  profileReference?: HarnessProfileReference,
): WorkflowDefinitionV2 {
  const profile = () =>
    builtinHarnessProfileConfiguration(provider, profileReference);
  const specs: V2BlockSpec[] = [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      name: "Ticket assigned to AI",
      column: 0,
    },
    {
      id: "prepare",
      type: "prepare_workspace",
      name: "Prepare workspace",
      column: 1,
    },
    {
      id: "planning",
      type: "planning_agent",
      name: "Planning agent",
      column: 2,
      configuration: {
        ...profile(),
        prompt: "{{prompt:research-plan@1}}",
      },
      inputs: {
        ticket: {
          kind: "reference",
          reference: "steps.entry.output.ticket",
        },
        comments: {
          kind: "reference",
          reference: "steps.entry.output.comments",
        },
        priorAnswers: {
          kind: "reference",
          reference: "steps.entry.output.priorAnswers",
        },
      },
    },
    {
      id: "implementation",
      type: "implementation_agent",
      name: "Implementation agent",
      column: 3,
      configuration: {
        ...profile(),
        prompt: "{{prompt:implement@1}}",
      },
      inputs: {
        ticket: {
          kind: "reference",
          reference: "steps.entry.output.ticket",
        },
        plan: {
          kind: "reference",
          reference: "steps.planning.output.plan",
        },
      },
    },
    ...([
      ["security-review", "Security review", REVIEW_TASKS.security, -1],
      ["quality-review", "Code quality review", REVIEW_TASKS.quality, 0],
      [
        "requirements-review",
        "Requirements review",
        REVIEW_TASKS.requirements,
        1,
      ],
    ] as const).map(
      ([id, name, prompt, row]) =>
        ({
          id,
          type: "review_agent",
          name,
          column: 5,
          row,
          configuration: {
            ...profile(),
            prompt,
          },
        }) satisfies V2BlockSpec,
    ),
    {
      id: "reviews-approved",
      type: "branch",
      name: "All reviews approved?",
      column: 6,
      configuration: {
        combinator: "all",
        conditions: [
          {
            reference: "steps.security-review.output.decision",
            operator: "equals",
            value: "approve",
          },
          {
            reference: "steps.quality-review.output.decision",
            operator: "equals",
            value: "approve",
          },
          {
            reference: "steps.requirements-review.output.decision",
            operator: "equals",
            value: "approve",
          },
        ],
      },
    },
    {
      id: "checks",
      type: "run_pre_pr_checks",
      name: "Run pre-PR checks",
      column: 7,
      row: -1,
    },
    {
      id: "finalize",
      type: "finalize_workspace",
      name: "Finalize workspace",
      column: 8,
      row: -1,
    },
    {
      id: "open-pr",
      type: "open_pr",
      name: "Open pull request",
      column: 9,
      row: -1,
      inputs: {
        repositories: {
          kind: "reference",
          reference: "steps.finalize.output.repositories",
        },
      },
    },
    {
      id: "status",
      type: "update_ticket_status",
      name: "Update ticket status",
      column: 10,
      row: -1,
      configuration: { target: "ai_review" },
    },
    {
      id: "retry",
      type: "loop",
      name: "Retry review fixes",
      column: 7,
      row: 1,
      configuration: {
        maxAttempts: 3,
        onExhaust: "fail",
        carry: [
          {
            name: "securityReview",
            schema: REVIEW_RESULT_JSON_SCHEMA,
            binding: {
              kind: "reference",
              reference: "steps.security-review.output",
            },
          },
          {
            name: "qualityReview",
            schema: REVIEW_RESULT_JSON_SCHEMA,
            binding: {
              kind: "reference",
              reference: "steps.quality-review.output",
            },
          },
          {
            name: "requirementsReview",
            schema: REVIEW_RESULT_JSON_SCHEMA,
            binding: {
              kind: "reference",
              reference: "steps.requirements-review.output",
            },
          },
        ],
      },
    },
    {
      id: "fix",
      type: "fix_agent",
      name: "Fix review findings",
      column: 4,
      row: 2,
      configuration: {
        ...profile(),
        instructions:
          "Resolve the supplied internal review findings, verify the changes, and commit the fix.",
        maxMinutes: 25,
      },
      inputs: {
        reviewResults: {
          kind: "reference_list",
          references: [
            "steps.retry.output.values.securityReview",
            "steps.retry.output.values.qualityReview",
            "steps.retry.output.values.requirementsReview",
          ],
        },
      },
    },
    {
      id: "exhausted-message",
      type: "send_slack_message",
      name: "Report unresolved review findings",
      column: 8,
      row: 2,
      configuration: {
        message:
          "The workflow could not resolve all review findings after three fix attempts.",
        sendOn: "always",
      },
    },
    {
      id: "exhausted-failure",
      type: "terminate",
      name: "Fail unresolved review",
      column: 9,
      row: 2,
      configuration: {
        terminalStatus: "failed",
      },
    },
  ];
  return buildBuiltinV2Definition("reviewed-ticket-workflow", specs, [
    { from: "trigger", to: "prepare" },
    { from: "prepare", to: "planning" },
    { from: "planning", to: "implementation" },
    { from: "implementation", to: "security-review" },
    { from: "implementation", to: "quality-review" },
    { from: "implementation", to: "requirements-review" },
    { from: "security-review", to: "reviews-approved" },
    { from: "quality-review", to: "reviews-approved" },
    { from: "requirements-review", to: "reviews-approved" },
    {
      from: "reviews-approved",
      fromPort: "true",
      to: "checks",
    },
    { from: "checks", to: "finalize" },
    { from: "finalize", to: "open-pr" },
    { from: "open-pr", to: "status" },
    {
      from: "reviews-approved",
      fromPort: "false",
      to: "retry",
    },
    {
      from: "retry",
      fromPort: "continue",
      to: "fix",
    },
    { from: "fix", to: "security-review" },
    { from: "fix", to: "quality-review" },
    { from: "fix", to: "requirements-review" },
    {
      from: "retry",
      fromPort: "exhausted",
      to: "exhausted-message",
    },
    { from: "exhausted-message", to: "exhausted-failure" },
  ]);
}

/**
 * The failure check text is FIXED, not bound to the review summary.
 *
 * `complete_pr_check` details reaches GitHub as a check-run TITLE sliced to 200
 * characters, plain text with no markdown, and GitLab as a commit-status
 * description clamped to 255. The review summary is markdown, is as long as the
 * findings make it, and opens with agent-authored material, so through that clamp
 * a client read a truncated fragment of it as the whole verdict. The review itself
 * is published in full by Post PR review, which is where its text belongs.
 *
 * The Arthur definition already made this call for its own graph; see
 * `FAILURE_DETAILS` in scenarios/arthur-review.scenario.test.ts. This template had
 * diverged from it.
 */
const POST_PR_REVIEW_FAILURE_DETAILS =
  "The review requested changes. See the review on this pull request.";

function postPrReviewDefinition(
  provider: HarnessProvider,
  profileReference?: HarnessProfileReference,
): WorkflowDefinitionV2 {
  const profile = () =>
    builtinHarnessProfileConfiguration(provider, profileReference);
  const specs: V2BlockSpec[] = [
    {
      id: "trigger-ready",
      type: "trigger_pr_ready",
      name: "PR ready for review",
      column: 0,
      row: -1,
      configuration: { providers: ["github", "gitlab"], scope: "any" },
    },
    {
      id: "trigger-updated",
      type: "trigger_pr_updated",
      name: "PR updated",
      column: 0,
      row: 1,
      configuration: { providers: ["github", "gitlab"], scope: "any" },
    },
    {
      id: "create-check",
      type: "create_pr_check",
      name: "Create review check",
      column: 1,
      configuration: { checkName: "AI Workflow / Review" },
    },
    {
      id: "prepare",
      type: "prepare_workspace",
      name: "Prepare exact-head workspace",
      column: 2,
    },
    ...([
      ["security-review", "Security review", REVIEW_TASKS.security, -1],
      ["quality-review", "Code quality review", REVIEW_TASKS.quality, 0],
      [
        "requirements-review",
        "Requirements review",
        REVIEW_TASKS.requirements,
        1,
      ],
    ] as const).map(
      ([id, name, prompt, row]) =>
        ({
          id,
          type: "review_agent",
          name,
          column: 3,
          row,
          configuration: { ...profile(), prompt },
        }) satisfies V2BlockSpec,
    ),
    {
      id: "post-review",
      type: "post_pr_review",
      name: "Post PR review",
      column: 4,
      inputs: {
        reviewResults: {
          kind: "reference_list",
          references: [
            "steps.security-review.output",
            "steps.quality-review.output",
            "steps.requirements-review.output",
          ],
        },
      },
    },
    {
      id: "review-approved",
      type: "branch",
      name: "Review approved?",
      column: 5,
      configuration: {
        combinator: "all",
        conditions: [
          {
            reference: "steps.post-review.output.decision",
            operator: "equals",
            value: "approve",
          },
        ],
      },
    },
    {
      id: "complete-success",
      type: "complete_pr_check",
      name: "Pass review check",
      column: 6,
      row: -1,
      configuration: {
        conclusion: "success",
        details: "No blocking findings on this commit.",
      },
      inputs: {
        check: {
          kind: "reference",
          reference: "steps.create-check.output.check",
        },
      },
    },
    {
      id: "complete-failure",
      type: "complete_pr_check",
      name: "Fail review check",
      column: 6,
      row: 1,
      configuration: {
        conclusion: "failure",
        details: POST_PR_REVIEW_FAILURE_DETAILS,
      },
      inputs: {
        check: {
          kind: "reference",
          reference: "steps.create-check.output.check",
        },
      },
    },
  ];
  return buildBuiltinV2Definition("post-pr-review", specs, [
    { from: "trigger-ready", to: "create-check" },
    { from: "trigger-updated", to: "create-check" },
    { from: "create-check", to: "prepare" },
    { from: "prepare", to: "security-review" },
    { from: "prepare", to: "quality-review" },
    { from: "prepare", to: "requirements-review" },
    { from: "security-review", to: "post-review" },
    { from: "quality-review", to: "post-review" },
    { from: "requirements-review", to: "post-review" },
    { from: "post-review", to: "review-approved" },
    { from: "review-approved", fromPort: "true", to: "complete-success" },
    { from: "review-approved", fromPort: "false", to: "complete-failure" },
  ]);
}

function postPrAutofixDefinition(
  provider: HarnessProvider,
  profileReference?: HarnessProfileReference,
): WorkflowDefinitionV2 {
  const profile = () =>
    builtinHarnessProfileConfiguration(provider, profileReference);
  const checkSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      id: { type: "string" },
      headSha: { type: "string" },
      name: { type: "string" },
    },
    required: ["id", "headSha", "name"],
    additionalProperties: false,
  };
  const reviewResultReferences = (): WorkflowDataReferenceV2[] =>
    REVIEW_IDS.map(
      (reviewer) =>
        `steps.retry.output.values.${reviewer.replace("-review", "Review")}` as WorkflowDataReferenceV2,
    );
  const specs: V2BlockSpec[] = [
    {
      id: "trigger-ready",
      type: "trigger_pr_ready",
      name: "PR ready for review",
      column: 0,
      row: -1,
      configuration: {
        providers: ["github", "gitlab"],
        scope: "workflow_owned",
      },
    },
    {
      id: "trigger-updated",
      type: "trigger_pr_updated",
      name: "PR updated",
      column: 0,
      row: 1,
      configuration: {
        providers: ["github", "gitlab"],
        scope: "workflow_owned",
      },
    },
    {
      id: "create-check",
      type: "create_pr_check",
      name: "Create review check",
      column: 1,
      configuration: { checkName: "AI Workflow / Review" },
    },
    {
      id: "prepare",
      type: "prepare_workspace",
      name: "Prepare exact-head workspace",
      column: 2,
    },
    ...([
      ["security-review", "Security review", REVIEW_TASKS.security, -1],
      ["quality-review", "Code quality review", REVIEW_TASKS.quality, 0],
      [
        "requirements-review",
        "Requirements review",
        REVIEW_TASKS.requirements,
        1,
      ],
    ] as const).map(
      ([id, name, prompt, row]) =>
        ({
          id,
          type: "review_agent",
          name,
          column: 3,
          row,
          configuration: { ...profile(), prompt },
        }) satisfies V2BlockSpec,
    ),
    {
      id: "review-approved",
      type: "branch",
      name: "Review approved?",
      column: 5,
      row: 1,
      configuration: {
        combinator: "all",
        conditions: REVIEW_IDS.map((reviewer) => ({
          reference: `steps.${reviewer}.output.decision`,
          operator: "equals",
          value: "approve",
        })),
      },
    },
    {
      id: "retry",
      type: "loop",
      name: "Retry review fixes",
      column: 4,
      row: 1,
      configuration: {
        maxAttempts: 2,
        onExhaust: "fail",
        carry: [
          {
            name: "check",
            schema: checkSchema,
            binding: {
              kind: "reference",
              reference: "steps.create-check.output.check" as WorkflowDataReferenceV2,
            },
          },
          ...REVIEW_IDS.map((reviewer) => ({
            name: reviewer.replace("-review", "Review"),
            schema: REVIEW_RESULT_JSON_SCHEMA,
            binding: {
              kind: "reference",
              reference: `steps.${reviewer}.output` as WorkflowDataReferenceV2,
            },
          })),
        ],
      },
    },
    {
      id: "fix",
      type: "fix_agent",
      name: "Fix review findings",
      column: 6,
      row: 1,
      configuration: {
        ...profile(),
        instructions:
          "Resolve the supplied review findings, verify the changes, and commit the fix.",
        maxMinutes: 25,
      },
      inputs: {
        reviewResults: {
          kind: "reference_list",
          references: reviewResultReferences(),
        },
      },
    },
    ...([
      ["post-review-approved", "Post approved review"],
      ["post-review-exhausted", "Post exhausted review"],
    ] as const).map(
      ([id, name]) =>
        ({
          id,
          type: "post_pr_review",
          name,
          column: 7,
          row: id === "post-review-approved" ? -1 : 1,
          inputs: {
            reviewResults: {
              kind: "reference_list",
              references: reviewResultReferences(),
            },
          },
        }) satisfies V2BlockSpec,
    ),
    {
      id: "exhausted-message",
      type: "send_slack_message",
      name: "Report unresolved review findings",
      column: 8,
      row: 1,
      configuration: {
        message:
          "The workflow could not resolve all review findings after two fix attempts.",
        sendOn: "always",
      },
    },
    {
      id: "complete-success",
      type: "complete_pr_check",
      name: "Pass review check",
      column: 9,
      row: -1,
      configuration: {
        conclusion: "success",
        details: "No blocking findings on this commit.",
        refreshHead: true,
      },
      inputs: {
        check: {
          kind: "reference",
          reference: "steps.retry.output.values.check" as WorkflowDataReferenceV2,
        },
      },
    },
    {
      id: "complete-failure",
      type: "complete_pr_check",
      name: "Fail review check",
      column: 9,
      row: 1,
      configuration: {
        conclusion: "failure",
        details: POST_PR_REVIEW_FAILURE_DETAILS,
        refreshHead: true,
      },
      inputs: {
        check: {
          kind: "reference",
          reference: "steps.retry.output.values.check" as WorkflowDataReferenceV2,
        },
      },
    },
  ];
  return buildBuiltinV2Definition("post-pr-autofix", specs, [
    { from: "trigger-ready", to: "create-check" },
    { from: "trigger-updated", to: "create-check" },
    { from: "create-check", to: "prepare" },
    { from: "prepare", to: "security-review" },
    { from: "prepare", to: "quality-review" },
    { from: "prepare", to: "requirements-review" },
    { from: "security-review", to: "review-approved" },
    { from: "quality-review", to: "review-approved" },
    { from: "requirements-review", to: "review-approved" },
    { from: "review-approved", fromPort: "true", to: "post-review-approved" },
    { from: "fix", to: "security-review" },
    { from: "fix", to: "quality-review" },
    { from: "fix", to: "requirements-review" },
    { from: "review-approved", fromPort: "false", to: "retry" },
    { from: "retry", fromPort: "continue", to: "fix" },
    { from: "retry", fromPort: "exhausted", to: "post-review-exhausted" },
    { from: "post-review-approved", to: "complete-success" },
    { from: "post-review-exhausted", to: "exhausted-message" },
    { from: "exhausted-message", to: "complete-failure" },
  ]);
}

export function workflowDefinitionTemplates({
  includeReview,
  includeLeakReview = false,
  provider = "claude",
  profileReference,
}: TemplateOptions): WorkflowDefinitionTemplate[] {
  return [
    {
      id: DEFAULT_WORKFLOW_TEMPLATE_ID,
      name: "Ticket workflow",
      description:
        "The current production delivery flow from ticket assignment through PR publication.",
      definition: defaultWorkflowDefinitionV2({
        includeReview,
        includeLeakReview,
        provider,
        profileReference,
      }),
    },
    {
      id: "human-approved-plan",
      name: "Human-approved plan",
      description:
        "Plans first, waits for approval, then implements the approved plan.",
      definition: humanApprovedPlanDefinition(provider, profileReference),
    },
    {
      id: "review-fix-after-pr",
      name: "Review & fix after PR",
      description:
        "Responds to failed checks or requested changes on workflow-owned pull requests.",
      definition: reviewFixAfterPrDefinition(provider, profileReference),
    },
    {
      id: "reviewed-ticket-workflow",
      name: "Reviewed ticket workflow",
      description:
        "Implements a ticket, runs three parallel reviews, and retries visible fixes up to three times.",
      definition: reviewedTicketDefinition(provider, profileReference),
    },
    {
      id: "post-pr-review",
      name: "Post-PR review",
      description:
        "Reviews ready and updated pull requests in parallel, publishes findings, and completes an exact-head check.",
      definition: postPrReviewDefinition(provider, profileReference),
    },
    {
      id: "post-pr-autofix",
      name: "Post-PR review with autofix",
      description:
        "Reviews an open pull request, fixes findings in a bounded loop, and publishes one final review.",
      definition: postPrAutofixDefinition(provider, profileReference),
    },
    {
      id: "fully-modular",
      name: "Fully modular",
      description:
        "Builds delivery from generic agents, workspace, checks, and a visible Branch.",
      definition: fullyModularDefinition(provider, profileReference),
    },
    {
      id: "webhook-ticket-triage",
      name: "Ticket triage (webhook)",
      description:
        "Triages a support ticket delivered by a signed webhook and opens a fix PR only when the issue is in code. Warning: external ticket input reaches an automatically opened PR with no human gate, so add an approval step before open_pr or point it only at a trusted sender.",
      definition: webhookTicketTriageDefinition(provider, profileReference),
    },
  ];
}

export function workflowDefinitionTemplate(
  id: string,
  options: TemplateOptions,
): WorkflowDefinitionTemplate | null {
  return (
    workflowDefinitionTemplates(options).find(
      (template) => template.id === id,
    ) ?? null
  );
}
