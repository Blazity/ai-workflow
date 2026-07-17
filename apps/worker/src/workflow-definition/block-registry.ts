import {
  BLOCK_TYPE_SPECS,
  type BlockOutput,
  type VcsProviderKind,
  type WorkflowBlockAvailability,
  type WorkflowBlockContract,
  type WorkflowBlockGroup,
  type WorkflowBlockInputContract,
  type WorkflowBlockPresentation,
  type WorkflowBlockType,
  type WorkflowParamValue,
  type WorkflowValueSchema,
} from "@shared/contracts";

export interface WorkflowBlockRegistryContext {
  agentProviders: { claude: boolean; codex: boolean };
  defaultAgent: { provider: "claude" | "codex"; model: string };
  vcsProviders: VcsProviderKind[];
  slackConfigured: boolean;
  arthurConfigured: boolean;
}

interface ContractDefinition {
  presentation: WorkflowBlockPresentation;
  defaults: Record<string, WorkflowParamValue>;
  inputs: Record<string, WorkflowBlockInputContract>;
  output: WorkflowValueSchema;
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

const ticketType = objectType(
  {
    key: stringType(),
    title: stringType(),
    description: stringType(),
  },
  ["key"],
  true,
);
const workspaceType = objectType(
  {
    id: stringType(),
    repositories: arrayType(stringType()),
  },
  ["id"],
  true,
);
const prType = objectType(
  {
    provider: stringType(),
    repoPath: stringType(),
    number: numberType(),
    url: stringType(),
    headSha: stringType(),
  },
  ["provider", "repoPath", "number", "url"],
  true,
);
const publishedPrType = objectType(
  {
    provider: stringType(),
    repoPath: stringType(),
    id: numberType(),
    url: stringType(),
    isNew: booleanType(),
  },
  ["provider", "repoPath", "id", "url", "isNew"],
);

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
    output: statusOutput({ ticketKey: stringType() }, ["ticketKey"]),
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
      },
      ["ticketKey", "approvedPlan", "approver", "approvedAt"],
    ),
    statusVariants: ["fired"],
  },
  trigger_pr_created: {
    presentation: presentation(
      "trigger",
      "PR created",
      "Starts from an allowed pull or merge request creation event.",
      "⎇",
    ),
    defaults: { providers: ["github", "gitlab"], onlyWorkflowOwned: true },
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
    statusVariants: ["fired"],
  },
  trigger_pr_checks_failed: {
    presentation: presentation(
      "trigger",
      "PR checks failed",
      "Starts when external CI reports one or more failed checks.",
      "✗",
    ),
    defaults: { providers: ["github", "gitlab"] },
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
    statusVariants: ["fired"],
  },
  trigger_pr_review: {
    presentation: presentation(
      "trigger",
      "PR review",
      "Starts from an allowed human pull or merge request review.",
      "✎",
    ),
    defaults: { providers: ["github"], on: ["changes_requested"] },
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
    inputs: { ticket: input(ticketType) },
    output: statusOutput(
      {
        plan: stringType(),
        questions: arrayType(stringType()),
        suggestedAnswers: arrayType(stringType()),
      },
      [],
    ),
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
      ticket: input(ticketType),
      plan: input(stringType()),
      workspace: input(workspaceType, false),
    },
    output: statusOutput({ questions: arrayType(stringType()) }),
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
    inputs: { ticket: input(ticketType), workspace: input(workspaceType) },
    output: statusOutput({ feedback: stringType() }),
    statusVariants: ["ok", "failed"],
  },
  fix_agent: {
    presentation: presentation(
      "agents",
      "Fix agent",
      "Applies review, CI, or conflict remediation in a managed workspace.",
      "✚",
    ),
    defaults: { maxMinutes: 25 },
    inputs: {
      ticket: input(ticketType, false),
      remediationContext: input(arrayType(unknownType())),
      workspace: input(workspaceType, false),
    },
    output: statusOutput({
      summary: stringType(),
      questions: arrayType(stringType()),
      suggestedAnswers: arrayType(stringType()),
    }),
    statusVariants: ["implemented", "needs_human_input", "failed"],
  },
  generic_agent: {
    presentation: presentation(
      "agents",
      "Generic agent",
      "Runs a configurable agent prompt with an optional declared output schema.",
      "❖",
    ),
    defaults: { prompt: "" },
    inputs: {
      prompt: input(stringType()),
      workspace: input(workspaceType, false),
    },
    output: statusOutput(
      {
        body: stringType(),
        questions: arrayType(stringType()),
        suggestedAnswers: arrayType(stringType()),
      },
      [],
    ),
    statusVariants: ["ok", "needs_human_input", "failed"],
  },
  prepare_workspace: {
    presentation: presentation(
      "workspace",
      "Prepare workspace",
      "Selects repositories and creates or reuses a managed code workspace.",
      "⊞",
    ),
    defaults: {},
    inputs: { ticket: input(ticketType) },
    output: statusOutput({
      sandboxId: stringType(),
      repositories: arrayType(stringType()),
      workspace: workspaceType,
      questions: arrayType(stringType()),
    }),
    statusVariants: ["ok", "needs_human_input", "failed"],
  },
  finalize_workspace: {
    presentation: presentation(
      "workspace",
      "Finalize workspace",
      "Preflights and publishes committed workspace changes.",
      "⇉",
    ),
    defaults: { requiredChecks: [] },
    inputs: {
      workspace: input(workspaceType),
      checks: input(arrayType(unknownType()), false),
    },
    output: statusOutput({
      prs: arrayType(publishedPrType),
      unmetChecks: arrayType(stringType()),
    }),
    statusVariants: ["published", "failed"],
  },
  run_pre_pr_checks: {
    presentation: presentation(
      "utility",
      "Pre-PR checks",
      "Runs the product's configured pre-publication validation and fix cycle.",
      "✓",
    ),
    defaults: { maxFixCycles: 3 },
    inputs: { workspace: input(workspaceType) },
    output: statusOutput({
      ok: booleanType(),
      fixCycles: numberType(),
      summary: stringType(),
    }),
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
    inputs: { workspace: input(workspaceType) },
    output: statusOutput({
      ok: booleanType(),
      results: arrayType(unknownType()),
      failures: arrayType(unknownType()),
    }),
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
    inputs: { pr: input(prType) },
    output: statusOutput({ contexts: arrayType(unknownType()) }),
    statusVariants: ["ok", "failed"],
  },
  open_pr: {
    presentation: presentation(
      "vcs",
      "Open PR/MR",
      "Publishes the current workspace and creates or reuses pull or merge requests.",
      "⇪",
    ),
    defaults: {},
    inputs: { workspace: input(workspaceType) },
    output: statusOutput({ prUrl: stringType(), prNumber: numberType() }),
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
    inputs: { ticket: input(ticketType), target: input(stringType()) },
    output: statusOutput({ target: stringType() }, ["target"]),
    statusVariants: ["ok"],
  },
  post_ticket_comment: {
    presentation: presentation(
      "ticket",
      "Post ticket comment",
      "Posts questions, plans, or status updates to the ticket.",
      "❝",
    ),
    defaults: { body: "" },
    inputs: { ticket: input(ticketType), body: input(stringType()) },
    output: statusOutput({ commentUrl: nullableType(stringType()) }),
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
    inputs: { pr: input(prType), body: input(stringType()) },
    output: statusOutput({ comments: arrayType(unknownType()) }),
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
    inputs: { message: input(stringType()), context: input(unknownType(), false) },
    output: statusOutput(),
    statusVariants: ["ok", "skipped"],
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
      ticket: input(ticketType),
      plan: input(stringType()),
      assumptions: input(arrayType(stringType()), false),
    },
    output: statusOutput({ approvalRequestId: stringType() }),
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
      ticket: input(ticketType),
      questions: input(arrayType(stringType())),
      suggestedAnswers: input(arrayType(stringType()), false),
    },
    output: statusOutput({
      questions: arrayType(stringType()),
      suggestedAnswers: arrayType(stringType()),
    }),
    statusVariants: ["needs_human_input", "failed"],
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
    statusVariants: ["ok", "flagged", "skipped"],
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
    output: statusOutput({ attempt: numberType() }, ["attempt"]),
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
  "call_llm",
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
  if (
    (type === "generic_agent" || type === "call_llm") &&
    typeof params.outputSchema === "string" &&
    params.outputSchema.trim() !== ""
  ) {
    try {
      JSON.parse(params.outputSchema);
    } catch {
      return unavailable("outputSchema is not valid JSON.");
    }
  }
  if (type === "send_slack_message" && !context.slackConfigured) {
    return unavailable("Slack messaging is not configured.");
  }
  if (type === "arthur_injection_check" && !context.arthurConfigured) {
    return unavailable("Arthur Engine is not configured.");
  }
  if (vcsBlocks.has(type) && context.vcsProviders.length === 0) {
    return unavailable("No version-control provider is configured.");
  }
  if (vcsBlocks.has(type) && Array.isArray(params.providers)) {
    const selectedProviders = params.providers.filter(
      (provider): provider is VcsProviderKind => provider === "github" || provider === "gitlab",
    );
    if (
      selectedProviders.length > 0 &&
      !selectedProviders.some((provider) => context.vcsProviders.includes(provider))
    ) {
      return unavailable(
        `Selected VCS providers are not configured: ${selectedProviders.join(", ")}.`,
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

function valueSchemaFromJsonSchema(raw: unknown, depth = 0): WorkflowValueSchema {
  if (depth > 32 || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return unknownType();
  }
  const schema = raw as Record<string, unknown>;
  switch (schema.type) {
    case "string":
      return stringType();
    case "number":
    case "integer":
      return numberType();
    case "boolean":
      return booleanType();
    case "null":
      return { type: "null" };
    case "array":
      return arrayType(valueSchemaFromJsonSchema(schema.items, depth + 1));
    case "object": {
      const rawProperties =
        schema.properties !== null &&
        typeof schema.properties === "object" &&
        !Array.isArray(schema.properties)
          ? (schema.properties as Record<string, unknown>)
          : {};
      const properties = Object.fromEntries(
        Object.entries(rawProperties).map(([key, value]) => [
          key,
          valueSchemaFromJsonSchema(value, depth + 1),
        ]),
      );
      const required = Array.isArray(schema.required)
        ? schema.required.filter(
            (key): key is string =>
              typeof key === "string" && Object.prototype.hasOwnProperty.call(properties, key),
          )
        : [];
      return objectType(properties, required, schema.additionalProperties !== false);
    }
    default:
      return unknownType();
  }
}

function declaredOutputSchema(params: Record<string, WorkflowParamValue>): WorkflowValueSchema {
  const raw = params.outputSchema;
  if (typeof raw !== "string" || raw.trim() === "") return unknownType();
  try {
    return valueSchemaFromJsonSchema(JSON.parse(raw));
  } catch {
    return unknownType();
  }
}

function resolvedOutput(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
  fallback: WorkflowValueSchema,
): WorkflowValueSchema {
  if (
    type === "generic_agent" &&
    typeof params.outputSchema === "string" &&
    params.outputSchema.trim() !== ""
  ) {
    return statusOutput({ data: declaredOutputSchema(params) });
  }
  if (
    type === "call_llm" &&
    typeof params.outputSchema === "string" &&
    params.outputSchema.trim() !== ""
  ) {
    return statusOutput({ output: declaredOutputSchema(params) });
  }
  return fallback;
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
  const issues = contract.output.statusVariants.includes(output.status)
    ? []
    : [`output.status must be one of: ${contract.output.statusVariants.join(", ")}.`];
  issues.push(...validateValueAgainstSchema(contract.output.schema, output, "output"));
  return issues;
}

export function resolveWorkflowBlockContract(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue>,
  context: WorkflowBlockRegistryContext,
): WorkflowBlockContract {
  const definition = definitions[type];
  const spec = BLOCK_TYPE_SPECS[type];
  return {
    type,
    presentation: definition.presentation,
    defaults: {
      ...(agentBlocks.has(type)
        ? { provider: context.defaultAgent.provider, model: context.defaultAgent.model }
        : {}),
      ...definition.defaults,
    },
    ports: [...spec.ports],
    allowsFailurePort: spec.allowsFailurePort,
    inputs: definition.inputs,
    output: {
      schema: resolvedOutput(type, params, definition.output),
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
      resolveWorkflowBlockContract(type, definitions[type].defaults, context),
    ]),
  ) as Record<WorkflowBlockType, WorkflowBlockContract>;
}
