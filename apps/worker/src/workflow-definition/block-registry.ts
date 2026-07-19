import {
  BLOCK_TYPE_SPECS,
  isWorkflowAddressablePathSegment,
  type BlockOutput,
  type VcsProviderKind,
  type WorkflowBlockAvailability,
  type WorkflowBlockAdditionalInputContract,
  type WorkflowBlockContract,
  type WorkflowBlockGroup,
  type WorkflowBlockInputContract,
  type WorkflowBlockPresentation,
  type WorkflowBlockType,
  type WorkflowParamValue,
  type WorkflowValueSchema,
} from "@shared/contracts";
import { resolveLlmProvider, type LlmProvider } from "../lib/llm-provider.js";

export interface WorkflowBlockRegistryContext {
  agentProviders: { claude: boolean; codex: boolean };
  llmProviders: { claude: boolean; codex: boolean };
  defaultAgent: { provider: "claude" | "codex"; model: string };
  vcsProviders: VcsProviderKind[];
  vcsBotIdentities: VcsProviderKind[];
  slackConfigured: boolean;
  arthurConfigured: boolean;
}

interface ContractDefinition {
  presentation: WorkflowBlockPresentation;
  defaults: Record<string, WorkflowParamValue>;
  inputs: Record<string, WorkflowBlockInputContract>;
  additionalInputs?: WorkflowBlockAdditionalInputContract[];
  output: WorkflowValueSchema;
  /** Top-level fields guaranteed whenever the block advances through a normal
   * output port. Nested guarantees remain declared by their own schemas. */
  normalOutputRequired?: string[];
  statusVariants: string[];
}

const stringType = (): WorkflowValueSchema => ({ type: "string" });
const numberType = (): WorkflowValueSchema => ({ type: "number" });
const booleanType = (): WorkflowValueSchema => ({ type: "boolean" });
const unknownType = (): WorkflowValueSchema => ({ type: "unknown" });
const nullableType = (value: WorkflowValueSchema): WorkflowValueSchema => ({
  type: "nullable",
  value,
});
const arrayType = (items: WorkflowValueSchema): WorkflowValueSchema => ({ type: "array", items });
const objectType = (
  properties: Record<string, WorkflowValueSchema>,
  required: string[] = Object.keys(properties),
  additionalProperties = false,
): WorkflowValueSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties,
});
const input = (schema: WorkflowValueSchema, required = false): WorkflowBlockInputContract => ({
  required,
  schema,
});
const statusOutput = (
  properties: Record<string, WorkflowValueSchema> = {},
  required: string[] = [],
): WorkflowValueSchema =>
  objectType({ status: stringType(), ...properties }, ["status", ...required]);

function withRequiredFields(
  schema: WorkflowValueSchema,
  required: readonly string[],
): WorkflowValueSchema {
  if (schema.type !== "object") return schema;
  return {
    ...schema,
    required: [
      ...new Set([
        ...schema.required,
        ...required.filter((key) =>
          Object.prototype.hasOwnProperty.call(schema.properties, key),
        ),
      ]),
    ],
  };
}

const workspaceType = objectType(
  {
    id: stringType(),
    repositories: arrayType(stringType()),
  },
  ["id"],
  true,
);
const finalizedBranchType = objectType({
  provider: stringType(),
  repoPath: stringType(),
  branchName: stringType(),
  expectedHead: stringType(),
  pushedHead: stringType(),
});
const commitRefType = objectType({
  provider: stringType(),
  repoPath: stringType(),
  sha: stringType(),
});
const resolvedConflictType = objectType({
  provider: stringType(),
  repoPath: stringType(),
  files: arrayType(stringType()),
});
const branchRefType = objectType({
  provider: stringType(),
  repoPath: stringType(),
  branch: stringType(),
});
const reviewFindingType = objectType({
  file: stringType(),
  description: stringType(),
  severity: stringType(),
});
const workflowPrRefType = objectType({
  provider: stringType(),
  repoPath: stringType(),
  id: numberType(),
  url: stringType(),
  branch: stringType(),
  isNew: booleanType(),
});
const ticketCommentType = objectType(
  {
    author: stringType(),
    body: stringType(),
    createdAt: stringType(),
  },
  ["author", "body", "createdAt"],
);
const humanAnswerType = objectType(
  {
    questions: arrayType(stringType()),
    answer: stringType(),
    answeredBy: stringType(),
    answeredAt: stringType(),
  },
  ["questions", "answer"],
);
const ticketContextType = objectType({
  identifier: stringType(),
  title: stringType(),
  description: stringType(),
  acceptanceCriteria: stringType(),
  labels: arrayType(stringType()),
  comments: arrayType(ticketCommentType),
  priorAnswers: arrayType(humanAnswerType),
});
const ticketTriggerOutputFields = {
  ticket: ticketContextType,
  comments: arrayType(ticketCommentType),
  priorAnswers: arrayType(humanAnswerType),
};

const colors: Record<WorkflowBlockGroup, { color: string; softColor: string }> = {
  trigger: { color: "#D14343", softColor: "#FBECEC" },
  agents: { color: "#7C3AED", softColor: "#F2EBFD" },
  workspace: { color: "#0f7f8b", softColor: "#E7F2F3" },
  control: { color: "#35823f", softColor: "#E9F3EA" },
  ticket: { color: "#2563EB", softColor: "#E9EFFD" },
  vcs: { color: "#3C43E7", softColor: "#ECECFD" },
  human: { color: "#b06a14", softColor: "#F7F0E7" },
  utility: { color: "#64748B", softColor: "#EEF1F5" },
  arthur: { color: "#8b6f8f", softColor: "#F3F0F4" },
};

function presentation(
  group: WorkflowBlockGroup,
  label: string,
  description: string,
  glyph: string,
): WorkflowBlockPresentation {
  return { group, label, description, glyph, ...colors[group] };
}

const definitions: Record<WorkflowBlockType, ContractDefinition> = {
  trigger_ticket_ai: {
    presentation: presentation(
      "trigger",
      "Ticket assigned to AI",
      "Starts when a configured ticket enters the AI workflow state.",
      "▶",
    ),
    defaults: {},
    inputs: {},
    output: statusOutput(
      { ticketKey: stringType(), ...ticketTriggerOutputFields },
      ["ticketKey"],
    ),
    normalOutputRequired: ["ticket", "comments", "priorAnswers"],
    statusVariants: ["fired"],
  },
  trigger_plan_approved: {
    presentation: presentation(
      "trigger",
      "Plan approved",
      "Starts the pinned implementation path after plan approval.",
      "✔",
    ),
    defaults: {},
    inputs: {},
    output: statusOutput(
      {
        ticketKey: stringType(),
        approvedPlan: stringType(),
        approver: stringType(),
        approvedAt: stringType(),
        ...ticketTriggerOutputFields,
      },
      ["ticketKey", "approvedPlan", "approver", "approvedAt"],
    ),
    normalOutputRequired: ["ticket", "comments", "priorAnswers"],
    statusVariants: ["fired"],
  },
  trigger_pr_created: {
    presentation: presentation(
      "trigger",
      "PR created",
      "Starts from an allowed pull or merge request creation event.",
      "⎇",
    ),
    defaults: { providers: ["github", "gitlab"], scope: "workflow_owned" },
    inputs: {},
    output: statusOutput(
      {
        ticketKey: stringType(),
        provider: stringType(),
        repoPath: stringType(),
        prNumber: numberType(),
        prUrl: stringType(),
        headRef: stringType(),
        headSha: stringType(),
        baseRef: stringType(),
        title: stringType(),
        author: stringType(),
        isDraft: booleanType(),
        ...ticketTriggerOutputFields,
      },
      [
        "ticketKey",
        "provider",
        "repoPath",
        "prNumber",
        "prUrl",
        "headRef",
        "headSha",
        "baseRef",
        "title",
        "author",
        "isDraft",
      ],
    ),
    normalOutputRequired: ["ticket", "comments", "priorAnswers"],
    statusVariants: ["fired"],
  },
  trigger_pr_checks_failed: {
    presentation: presentation(
      "trigger",
      "PR checks failed",
      "Starts when external CI reports one or more failed checks.",
      "✗",
    ),
    defaults: {
      providers: ["github", "gitlab"],
      scope: "workflow_owned",
      checkNames: [],
      githubAppSlugs: ["github-actions"],
      gitlabPipelineSources: ["merge_request_event"],
    },
    inputs: {},
    output: statusOutput(
      {
        ticketKey: stringType(),
        provider: stringType(),
        repoPath: stringType(),
        prNumber: numberType(),
        prUrl: stringType(),
        headRef: stringType(),
        headSha: stringType(),
        baseRef: stringType(),
        title: stringType(),
        author: stringType(),
        isDraft: booleanType(),
        failedChecks: arrayType(
          objectType(
            { name: stringType(), conclusion: stringType(), detailsUrl: stringType() },
            ["name", "conclusion"],
          ),
        ),
        ...ticketTriggerOutputFields,
      },
      [
        "ticketKey",
        "provider",
        "repoPath",
        "prNumber",
        "prUrl",
        "headRef",
        "headSha",
        "baseRef",
        "title",
        "author",
        "isDraft",
        "failedChecks",
      ],
    ),
    normalOutputRequired: ["ticket", "comments", "priorAnswers"],
    statusVariants: ["fired"],
  },
  trigger_pr_review: {
    presentation: presentation(
      "trigger",
      "PR review",
      "Starts from an allowed human pull or merge request review.",
      "✎",
    ),
    defaults: {
      providers: ["github"],
      on: ["changes_requested"],
      scope: "workflow_owned",
    },
    inputs: {},
    output: statusOutput(
      {
        ticketKey: stringType(),
        provider: stringType(),
        repoPath: stringType(),
        prNumber: numberType(),
        prUrl: stringType(),
        headRef: stringType(),
        headSha: stringType(),
        baseRef: stringType(),
        title: stringType(),
        author: stringType(),
        isDraft: booleanType(),
        review: objectType(
          { state: stringType(), author: stringType(), body: stringType() },
          ["state", "author", "body"],
        ),
        ...ticketTriggerOutputFields,
      },
      [
        "ticketKey",
        "provider",
        "repoPath",
        "prNumber",
        "prUrl",
        "headRef",
        "headSha",
        "baseRef",
        "title",
        "author",
        "isDraft",
        "review",
      ],
    ),
    normalOutputRequired: ["ticket", "comments", "priorAnswers"],
    statusVariants: ["fired"],
  },
  trigger_pr_merged: {
    presentation: presentation(
      "trigger",
      "PR merged",
      "Starts when an allowed pull or merge request is merged.",
      "◆",
    ),
    defaults: { providers: ["github", "gitlab"], scope: "workflow_owned" },
    inputs: {},
    output: statusOutput(
      {
        ticketKey: stringType(),
        provider: stringType(),
        repoPath: stringType(),
        prNumber: numberType(),
        prUrl: stringType(),
        headRef: stringType(),
        headSha: stringType(),
        mergeSha: stringType(),
        mergedAt: stringType(),
        baseRef: stringType(),
        title: stringType(),
        author: stringType(),
        isDraft: booleanType(),
        ...ticketTriggerOutputFields,
      },
      [
        "ticketKey",
        "provider",
        "repoPath",
        "prNumber",
        "prUrl",
        "headRef",
        "headSha",
        "baseRef",
        "title",
        "author",
        "isDraft",
      ],
    ),
    normalOutputRequired: ["ticket", "comments", "priorAnswers"],
    statusVariants: ["fired"],
  },
  planning_agent: {
    presentation: presentation(
      "agents",
      "Planning agent",
      "Researches the ticket and returns a plan or clarification questions.",
      "✦",
    ),
    defaults: {},
    inputs: {
      ticket: input(ticketContextType),
      comments: input(arrayType(ticketCommentType)),
      priorAnswers: input(arrayType(humanAnswerType)),
    },
    output: statusOutput(
      {
        plan: stringType(),
        questions: arrayType(stringType()),
        suggestedAnswers: arrayType(stringType()),
      },
      [],
    ),
    normalOutputRequired: ["plan"],
    statusVariants: ["ready", "needs_human_input", "failed"],
  },
  implementation_agent: {
    presentation: presentation(
      "agents",
      "Implementation agent",
      "Implements an approved or generated plan in a managed workspace.",
      "⌨",
    ),
    defaults: {},
    inputs: {
      ticket: input(ticketContextType),
      plan: input(stringType()),
    },
    output: statusOutput({
      workspaceId: stringType(),
      branches: arrayType(branchRefType),
      commits: arrayType(commitRefType),
      verification: unknownType(),
      summary: stringType(),
      questions: arrayType(stringType()),
      suggestedAnswers: arrayType(stringType()),
    }),
    normalOutputRequired: ["workspaceId", "branches", "commits", "summary"],
    statusVariants: ["implemented", "needs_human_input", "failed"],
  },
  review_agent: {
    presentation: presentation(
      "agents",
      "Review agent",
      "Reviews the current workspace diff before publication.",
      "☰",
    ),
    defaults: {},
    inputs: {},
    output: statusOutput({
      findings: arrayType(reviewFindingType),
      decision: stringType(),
      feedback: stringType(),
    }),
    normalOutputRequired: ["findings", "decision"],
    statusVariants: ["reviewed", "failed"],
  },
  fix_agent: {
    presentation: presentation(
      "agents",
      "Fix agent",
      "Applies review, CI, or conflict remediation in a managed workspace.",
      "✚",
    ),
    defaults: { maxMinutes: 25 },
    inputs: {},
    output: statusOutput({
      workspaceId: stringType(),
      commits: arrayType(commitRefType),
      resolvedConflicts: arrayType(resolvedConflictType),
      unresolvedConflicts: arrayType(resolvedConflictType),
      summary: stringType(),
      questions: arrayType(stringType()),
      suggestedAnswers: arrayType(stringType()),
    }),
    normalOutputRequired: [
      "workspaceId",
      "commits",
      "resolvedConflicts",
      "unresolvedConflicts",
      "summary",
    ],
    statusVariants: ["fixed", "needs_human_input", "failed"],
  },
  generic_agent: {
    presentation: presentation(
      "agents",
      "Generic agent",
      "Runs a configurable agent prompt with an optional declared output schema.",
      "❖",
    ),
    defaults: { prompt: "", workspaceMode: "none" },
    inputs: {
      prompt: input(stringType()),
    },
    output: statusOutput(
      {
        body: stringType(),
        questions: arrayType(stringType()),
        suggestedAnswers: arrayType(stringType()),
      },
      [],
    ),
    normalOutputRequired: ["body"],
    statusVariants: ["completed", "needs_human_input", "failed"],
  },
  prepare_workspace: {
    presentation: presentation(
      "workspace",
      "Prepare workspace",
      "Selects repositories and creates or reuses a managed code workspace.",
      "⊞",
    ),
    defaults: {},
    inputs: {},
    output: statusOutput({
      sandboxId: stringType(),
      repositories: arrayType(stringType()),
      workspace: workspaceType,
      questions: arrayType(stringType()),
    }),
    normalOutputRequired: ["sandboxId", "repositories", "workspace"],
    statusVariants: ["ok", "needs_human_input", "failed"],
  },
  finalize_workspace: {
    presentation: presentation(
      "workspace",
      "Finalize workspace",
      "Preflights and publishes committed workspace changes.",
      "⇉",
    ),
    defaults: {},
    inputs: {},
    additionalInputs: [
      {
        keyPattern: "^checks\\.[A-Za-z0-9_-]+$",
        schema: stringType(),
      },
    ],
    output: statusOutput({
      publicationAttemptId: stringType(),
      repositories: arrayType(finalizedBranchType),
      unmetChecks: arrayType(stringType()),
    }),
    normalOutputRequired: ["publicationAttemptId", "repositories"],
    statusVariants: ["finalized", "failed"],
  },
  run_pre_pr_checks: {
    presentation: presentation(
      "utility",
      "Pre-PR checks",
      "Runs the product's configured pre-publication validation and fix cycle.",
      "✓",
    ),
    defaults: { maxFixCycles: 3 },
    inputs: {},
    output: statusOutput({
      ok: booleanType(),
      fixCycles: numberType(),
      summary: stringType(),
    }),
    normalOutputRequired: ["ok", "fixCycles", "summary"],
    statusVariants: ["ok", "failed"],
  },
  run_checks: {
    presentation: presentation(
      "utility",
      "Run checks",
      "Runs configured or explicit validation commands in the workspace.",
      "✓",
    ),
    defaults: { commands: [] },
    inputs: {},
    output: statusOutput({
      ok: booleanType(),
      results: arrayType(unknownType()),
      failures: arrayType(unknownType()),
    }),
    normalOutputRequired: ["ok", "results", "failures"],
    statusVariants: ["ok", "failed"],
  },
  call_llm: {
    presentation: presentation(
      "utility",
      "Call LLM",
      "Runs a focused non-agent LLM transform with an optional output schema.",
      "λ",
    ),
    defaults: { prompt: "" },
    inputs: { prompt: input(stringType()), system: input(stringType(), false) },
    output: statusOutput({ output: stringType() }),
    normalOutputRequired: ["output"],
    statusVariants: ["ok", "failed"],
  },
  fetch_pr_context: {
    presentation: presentation(
      "vcs",
      "Fetch PR context",
      "Loads review comments, check results, and conflict state for the PR or MR.",
      "⇊",
    ),
    defaults: {},
    inputs: {},
    output: statusOutput({ contexts: arrayType(unknownType()) }),
    normalOutputRequired: ["contexts"],
    statusVariants: ["ok", "failed"],
  },
  open_pr: {
    presentation: presentation(
      "vcs",
      "Open PR/MR",
      "Creates or reuses pull or merge requests from a successful Finalize output.",
      "⇪",
    ),
    defaults: {},
    inputs: { publicationAttemptId: input(stringType(), true) },
    output: statusOutput({
      prs: arrayType(workflowPrRefType),
      prUrl: stringType(),
      prNumber: numberType(),
    }),
    normalOutputRequired: ["prs"],
    statusVariants: ["ok", "failed"],
  },
  update_ticket_status: {
    presentation: presentation(
      "ticket",
      "Update ticket status",
      "Moves the ticket to a configured provider status.",
      "▤",
    ),
    defaults: { target: "ai_review" },
    inputs: { target: input(stringType()) },
    output: statusOutput({ target: stringType() }),
    normalOutputRequired: ["target"],
    statusVariants: ["ok", "failed"],
  },
  post_ticket_comment: {
    presentation: presentation(
      "ticket",
      "Post ticket comment",
      "Posts questions, plans, or status updates to the ticket.",
      "❝",
    ),
    defaults: { body: "" },
    inputs: { body: input(stringType()) },
    output: statusOutput({ commentUrl: nullableType(stringType()) }),
    normalOutputRequired: ["commentUrl"],
    statusVariants: ["ok", "failed"],
  },
  post_pr_comment: {
    presentation: presentation(
      "vcs",
      "Post PR comment",
      "Posts a summary or response to the pull or merge request.",
      "❞",
    ),
    defaults: { body: "", target: "all" },
    inputs: { body: input(stringType()) },
    output: statusOutput({ comments: arrayType(unknownType()) }),
    normalOutputRequired: ["comments"],
    statusVariants: ["ok", "failed"],
  },
  send_slack_message: {
    presentation: presentation(
      "utility",
      "Send Slack message",
      "Notifies the configured Slack channel about a workflow milestone.",
      "✉",
    ),
    defaults: { message: "" },
    inputs: { message: input(stringType()) },
    output: statusOutput(),
    statusVariants: ["ok", "skipped", "failed"],
  },
  send_plan_approval: {
    presentation: presentation(
      "human",
      "Send plan for approval",
      "Creates a durable approval item and ends this path.",
      "☑",
    ),
    defaults: { mirrorComment: true },
    inputs: {
      plan: input(stringType(), true),
      assumptions: input(arrayType(stringType()), false),
    },
    output: statusOutput({ approvalRequestId: stringType() }),
    normalOutputRequired: ["approvalRequestId"],
    statusVariants: ["awaiting_approval", "failed"],
  },
  human_question: {
    presentation: presentation(
      "human",
      "Human question",
      "Parks execution until the ticket owner answers scoped questions.",
      "?",
    ),
    defaults: { questions: [] },
    inputs: {
      questions: input(arrayType(stringType())),
      suggestedAnswers: input(arrayType(stringType()), false),
    },
    output: statusOutput({
      questions: arrayType(stringType()),
      suggestedAnswers: arrayType(stringType()),
      answer: stringType(),
    }),
    statusVariants: ["needs_human_input", "answered", "failed"],
  },
  arthur_injection_check: {
    presentation: presentation(
      "arthur",
      "Prompt injection check",
      "Scans untrusted content with the optional Arthur Engine integration.",
      "◬",
    ),
    defaults: {},
    inputs: { content: input(stringType()) },
    output: statusOutput({ findings: arrayType(unknownType()), reason: stringType() }),
    statusVariants: ["ok", "flagged", "skipped", "failed"],
  },
  branch: {
    presentation: presentation(
      "control",
      "Branch",
      "Chooses one of two paths using the restricted condition language.",
      "⋔",
    ),
    defaults: { condition: "" },
    inputs: {},
    output: statusOutput({ path: stringType(), reason: stringType(), error: stringType() }),
    statusVariants: ["ok", "failed"],
  },
  loop: {
    presentation: presentation(
      "control",
      "Loop",
      "Repeats one cycle up to a bounded maximum attempt count.",
      "↻",
    ),
    defaults: { maxAttempts: 3, onExhaust: "fail" },
    inputs: {},
    output: statusOutput({ attempt: numberType(), answer: stringType() }, ["attempt"]),
    statusVariants: ["ok", "exhausted"],
  },
  terminate: {
    presentation: presentation(
      "control",
      "Terminate",
      "Stops the current path with an explicit terminal outcome.",
      "■",
    ),
    defaults: { terminalStatus: "done" },
    inputs: {},
    output: statusOutput(),
    statusVariants: ["waiting_for_human", "failed", "skipped", "done"],
  },
};

const vcsBlocks = new Set<WorkflowBlockType>([
  "trigger_pr_created",
  "trigger_pr_checks_failed",
  "trigger_pr_review",
  "trigger_pr_merged",
  "prepare_workspace",
  "finalize_workspace",
  "run_pre_pr_checks",
  "run_checks",
  "fetch_pr_context",
  "open_pr",
  "post_pr_comment",
]);

const agentBlocks = new Set<WorkflowBlockType>([
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "fix_agent",
  "generic_agent",
]);

const available: WorkflowBlockAvailability = { available: true, unavailableReason: null };

function unavailable(unavailableReason: string): WorkflowBlockAvailability {
  return { available: false, unavailableReason };
}

function availabilityFor(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
  context: WorkflowBlockRegistryContext,
): WorkflowBlockAvailability {
  const definitionIssue = workflowBlockDefinitionIssue(type, params);
  if (definitionIssue) return unavailable(definitionIssue);
  if (type === "send_slack_message" && !context.slackConfigured) {
    return unavailable("Slack messaging is not configured.");
  }
  if (type === "arthur_injection_check" && !context.arthurConfigured) {
    return unavailable("Arthur Engine is not configured.");
  }
  const selectedProviders = Array.isArray(params.providers)
    ? params.providers.filter(
      (provider): provider is VcsProviderKind => provider === "github" || provider === "gitlab",
    )
    : [];
  if (
    type === "trigger_pr_review" &&
    selectedProviders.includes("gitlab") &&
    !(Array.isArray(params.on) && params.on.includes("commented"))
  ) {
    return unavailable(
      'GitLab review triggers must include "commented"; GitLab does not emit a reliable changes-requested review event.',
    );
  }
  if (vcsBlocks.has(type) && context.vcsProviders.length === 0) {
    return unavailable("No version-control provider is configured.");
  }
  if (vcsBlocks.has(type) && selectedProviders.length > 0) {
    if (
      !selectedProviders.some((provider) => context.vcsProviders.includes(provider))
    ) {
      return unavailable(
        `Selected VCS providers are not configured: ${selectedProviders.join(", ")}.`,
      );
    }
  }
  if (type === "trigger_pr_review") {
    const states = Array.isArray(params.on) ? params.on : [];
    if (states.includes("commented")) {
      const missingBotIdentities = selectedProviders.filter(
        (provider) =>
          context.vcsProviders.includes(provider) &&
          !context.vcsBotIdentities.includes(provider),
      );
      if (missingBotIdentities.length > 0) {
        const variables = missingBotIdentities.map((provider) =>
          provider === "github" ? "GITHUB_BOT_LOGIN" : "GITLAB_BOT_LOGIN",
        );
        const label = missingBotIdentities[0] === "github" ? "GitHub" : "GitLab";
        return unavailable(
          context.vcsProviders.length === 1
            ? `Commented ${label} review triggers require ${variables[0]} (or VCS_BOT_LOGIN in a single-provider deployment) to prevent recursive bot reviews.`
            : missingBotIdentities.length === 1
              ? `Commented review triggers require a configured ${variables[0]} to prevent recursive bot reviews.`
              : `Commented review triggers require configured ${variables.join(" and ")} values to prevent recursive bot reviews.`,
        );
      }
    }
  }
  if (type === "call_llm") {
    const explicitProvider: LlmProvider | undefined =
      params.provider === "claude" || params.provider === "codex"
        ? params.provider
        : undefined;
    const explicitModel =
      typeof params.model === "string" && params.model.trim() !== ""
        ? params.model.trim()
        : undefined;
    const runtimeProvider =
      explicitModel === undefined
        ? (explicitProvider ?? context.defaultAgent.provider)
        : explicitProvider;
    const requested = resolveLlmProvider(
      explicitModel ?? context.defaultAgent.model,
      runtimeProvider,
    );
    if (!context.llmProviders[requested]) {
      return unavailable(
        requested === "codex"
          ? "Codex API credentials are not configured for Call LLM."
          : "Claude API credentials are not configured for Call LLM.",
      );
    }
  }
  if (agentBlocks.has(type)) {
    const requested =
      params.provider === "claude" || params.provider === "codex"
        ? params.provider
        : context.defaultAgent.provider;
    if (!context.agentProviders[requested]) {
      return unavailable(
        requested === "codex"
          ? "Codex credentials are not configured."
          : "Claude credentials are not configured.",
      );
    }
  }
  return available;
}

type ParsedDeclaredSchema =
  | { ok: true; schema: WorkflowValueSchema }
  | { ok: false; reason: string };

const unsupportedJsonSchemaValidationKeywords = new Set([
  "$defs",
  "$ref",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "dependentRequired",
  "dependencies",
  "definitions",
  "else",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "then",
  "uniqueItems",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function parseJsonValueSchema(
  raw: unknown,
  path: string,
  depth = 0,
): ParsedDeclaredSchema {
  if (depth > 32) return { ok: false, reason: `${path} is nested too deeply.` };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      reason:
        path === "outputSchema"
          ? "outputSchema must be a JSON Schema object."
          : `${path} must be a JSON Schema object.`,
    };
  }

  const schema = raw as Record<string, unknown>;
  if (schema.type === "integer") {
    return { ok: false, reason: `${path} has unsupported type "integer".` };
  }
  const unsupportedKeyword = Object.keys(schema).find((key) =>
    unsupportedJsonSchemaValidationKeywords.has(key),
  );
  if (unsupportedKeyword) {
    return {
      ok: false,
      reason: `${path} uses unsupported validation keyword "${unsupportedKeyword}".`,
    };
  }
  switch (schema.type) {
    case "string":
      return { ok: true, schema: stringType() };
    case "number":
      return { ok: true, schema: numberType() };
    case "boolean":
      return { ok: true, schema: booleanType() };
    case "null":
      return { ok: true, schema: { type: "null" } };
    case "array": {
      const items = parseJsonValueSchema(schema.items, `${path}.items`, depth + 1);
      return items.ok ? { ok: true, schema: arrayType(items.schema) } : items;
    }
    case "object": {
      if (
        schema.properties !== undefined &&
        (schema.properties === null ||
          typeof schema.properties !== "object" ||
          Array.isArray(schema.properties))
      ) {
        return { ok: false, reason: `${path}.properties must be an object.` };
      }
      const rawProperties = (schema.properties ?? {}) as Record<string, unknown>;
      const properties: Record<string, WorkflowValueSchema> = {};
      for (const [key, childRaw] of Object.entries(rawProperties)) {
        if (!isWorkflowAddressablePathSegment(key)) {
          return {
            ok: false,
            reason: `${path} property "${key}" is not addressable.`,
          };
        }
        const child = parseJsonValueSchema(childRaw, `${path}.properties.${key}`, depth + 1);
        if (!child.ok) return child;
        properties[key] = child.schema;
      }
      if (
        schema.required !== undefined &&
        (!Array.isArray(schema.required) ||
          schema.required.some(
            (key) =>
              typeof key !== "string" ||
              !Object.prototype.hasOwnProperty.call(properties, key),
          ))
      ) {
        return {
          ok: false,
          reason: `${path}.required must contain only declared property names.`,
        };
      }
      if (
        schema.additionalProperties !== undefined &&
        typeof schema.additionalProperties !== "boolean"
      ) {
        return { ok: false, reason: `${path}.additionalProperties must be a boolean.` };
      }
      return {
        ok: true,
        schema: objectType(
          properties,
          (schema.required as string[] | undefined) ?? [],
          schema.additionalProperties !== false,
        ),
      };
    }
    default:
      return {
        ok: false,
        reason:
          typeof schema.type === "string"
            ? `${path} has unsupported type "${schema.type}".`
            : `${path} must declare a supported type.`,
      };
  }
}

function declaredOutputSchema(
  params: Record<string, WorkflowParamValue>,
): ParsedDeclaredSchema | null {
  const raw = params.outputSchema;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return parseJsonValueSchema(JSON.parse(raw), "outputSchema");
  } catch {
    return { ok: false, reason: "outputSchema is not valid JSON." };
  }
}

/** Definition-local registry issue, separate from environment availability so
 * pinned deployed definitions can execute after credentials/configuration
 * change while malformed authored contracts still fail closed. */
export function workflowBlockDefinitionIssue(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
): string | null {
  if (type !== "generic_agent" && type !== "call_llm") return null;
  const result = declaredOutputSchema(params);
  if (result && !result.ok) return result.reason;
  if (type === "generic_agent" && result?.ok) {
    if (result.schema.type !== "object") {
      return "outputSchema must declare an object for Generic Agent.";
    }
    for (const reserved of ["status", "data"] as const) {
      if (Object.prototype.hasOwnProperty.call(result.schema.properties, reserved)) {
        return `outputSchema property "${reserved}" is reserved by Generic Agent.`;
      }
    }
  }
  return null;
}

function resolvedOutput(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
  fallback: WorkflowValueSchema,
): WorkflowValueSchema {
  const declared = declaredOutputSchema(params);
  if (type === "generic_agent" && declared !== null) {
    if (declared.ok && declared.schema.type === "object") {
      return objectType(
        {
          status: stringType(),
          ...declared.schema.properties,
          // Compatibility alias for definitions authored against PR #118's
          // nested shape. New bindings address declared fields at top level.
          data: declared.schema,
        },
        ["status"],
        declared.schema.additionalProperties,
      );
    }
    return statusOutput({ data: unknownType() });
  }
  if (type === "call_llm" && declared !== null) {
    return statusOutput({ output: declared.ok ? declared.schema : unknownType() });
  }
  if (
    params.scope === "any" &&
    (type === "trigger_pr_created" ||
      type === "trigger_pr_checks_failed" ||
      type === "trigger_pr_review" ||
      type === "trigger_pr_merged") &&
    fallback.type === "object"
  ) {
    const properties = { ...fallback.properties };
    delete properties.ticketKey;
    delete properties.ticket;
    delete properties.comments;
    delete properties.priorAnswers;
    return {
      ...fallback,
      properties,
      required: fallback.required.filter((field) => field !== "ticketKey"),
    };
  }
  return fallback;
}

function resolvedBindingOutput(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
  definition: ContractDefinition,
  output: WorkflowValueSchema,
): WorkflowValueSchema {
  const declared = declaredOutputSchema(params);
  const dynamicField =
    declared?.ok === true
      ? type === "generic_agent"
        ? "data"
        : type === "call_llm"
          ? "output"
          : null
      : null;
  const declaredRequiredFields =
    type === "generic_agent" && declared?.ok === true && declared.schema.type === "object"
      ? declared.schema.required
      : [];
  return withRequiredFields(output, [
    ...(definition.normalOutputRequired ?? []),
    ...declaredRequiredFields,
    ...(dynamicField === null ? [] : [dynamicField]),
  ]);
}

function validateValueAgainstSchema(
  schema: WorkflowValueSchema,
  value: unknown,
  path: string,
): string[] {
  switch (schema.type) {
    case "unknown":
      return [];
    case "string":
    case "number":
    case "boolean":
      return typeof value === schema.type ? [] : [`${path} must be a ${schema.type}.`];
    case "null":
      return value === null ? [] : [`${path} must be null.`];
    case "nullable":
      return value === null ? [] : validateValueAgainstSchema(schema.value, value, path);
    case "array":
      if (!Array.isArray(value)) return [`${path} must be an array.`];
      return value.flatMap((item, index) =>
        validateValueAgainstSchema(schema.items, item, `${path}[${index}]`),
      );
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return [`${path} must be an object.`];
      }
      const record = value as Record<string, unknown>;
      const issues: string[] = [];
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
          issues.push(`${path}.${key} is required.`);
        }
      }
      for (const [key, child] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          issues.push(...validateValueAgainstSchema(child, record[key], `${path}.${key}`));
        }
      }
      if (!schema.additionalProperties) {
        for (const key of Object.keys(record)) {
          if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
            issues.push(`${path}.${key} is not declared by the contract.`);
          }
        }
      }
      return issues;
    }
  }
}

/** Validate an executor result against the same serializable contract exposed
 * to the editor. Kept reusable so executor tests can detect contract drift. */
export function validateBlockOutputAgainstContract(
  contract: WorkflowBlockContract,
  output: BlockOutput,
): string[] {
  return validateBlockOutputShape(
    contract.output.statusVariants,
    contract.output.schema,
    output,
  );
}

function validateBlockOutputShape(
  statusVariants: readonly string[],
  schema: WorkflowValueSchema,
  output: BlockOutput,
): string[] {
  const issues = statusVariants.includes(output.status)
    ? []
    : [`output.status must be one of: ${statusVariants.join(", ")}.`];
  issues.push(...validateValueAgainstSchema(schema, output, "output"));
  return issues;
}

/** Runtime validation for a block whose output contract depends on authored
 * params. This resolves the same dynamic schema exposed by the registry, but
 * deliberately does not require an environment context because availability
 * is unrelated to validating an already-produced value. */
export function validateBlockOutputForDefinition(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
  output: BlockOutput,
  options: { requireNormalOutput?: boolean } = {},
): string[] {
  const definitionIssue = workflowBlockDefinitionIssue(type, params);
  if (definitionIssue) return [`output contract is invalid: ${definitionIssue}`];
  const definition = definitions[type];
  const resolved = resolvedOutput(type, params, definition.output);
  return validateBlockOutputShape(
    definition.statusVariants,
    options.requireNormalOutput
      ? resolvedBindingOutput(type, params, definition, resolved)
      : resolved,
    output,
  );
}

export function resolveWorkflowBlockContract(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
  context: WorkflowBlockRegistryContext,
): WorkflowBlockContract {
  const definition = definitions[type];
  const defaults = defaultsForContext(type, definition.defaults, context);
  const spec = BLOCK_TYPE_SPECS[type];
  const output = resolvedOutput(type, params, definition.output);
  return {
    type,
    presentation: definition.presentation,
    defaults: {
      ...(agentBlocks.has(type)
        ? { provider: context.defaultAgent.provider, model: context.defaultAgent.model }
        : {}),
      ...defaults,
    },
    ports: [...spec.ports],
    allowsFailurePort: spec.allowsFailurePort,
    inputs: definition.inputs,
    additionalInputs: definition.additionalInputs ?? [],
    output: {
      schema: output,
      bindingSchema: resolvedBindingOutput(type, params, definition, output),
      statusVariants: [...definition.statusVariants],
    },
    availability: availabilityFor(type, params, context),
  };
}

export function buildWorkflowBlockRegistry(
  context: WorkflowBlockRegistryContext,
): Record<WorkflowBlockType, WorkflowBlockContract> {
  return Object.fromEntries(
    (Object.keys(definitions) as WorkflowBlockType[]).map((type) => [
      type,
      resolveWorkflowBlockContract(
        type,
        defaultsForContext(type, definitions[type].defaults, context),
        context,
      ),
    ]),
  ) as Record<WorkflowBlockType, WorkflowBlockContract>;
}

function defaultsForContext(
  type: WorkflowBlockType,
  defaults: Record<string, WorkflowParamValue>,
  context: WorkflowBlockRegistryContext,
): Record<string, WorkflowParamValue> {
  if (
    type === "trigger_pr_review" &&
    !context.vcsProviders.includes("github") &&
    context.vcsProviders.includes("gitlab")
  ) {
    return { ...defaults, providers: ["gitlab"], on: ["commented"] };
  }
  return defaults;
}
