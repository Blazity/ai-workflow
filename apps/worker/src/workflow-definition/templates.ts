import type {
  HarnessProvider,
  HarnessProfileReference,
  WorkflowDefinitionTemplate,
  WorkflowDefinitionV2,
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
        condition: {
          kind: "eq",
          left: {
            kind: "path",
            reference: "steps.checks.output.outcome",
          },
          right: { kind: "lit", value: "passed" },
        },
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

export function workflowDefinitionTemplates({
  includeReview,
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
      id: "fully-modular",
      name: "Fully modular",
      description:
        "Builds delivery from generic agents, workspace, checks, and a visible Branch.",
      definition: fullyModularDefinition(provider, profileReference),
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
