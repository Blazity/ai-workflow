/**
 * Every product-behaviour switch this deployment has, as data.
 *
 * One list, in the package both applications share, so the worker resolves a
 * setting and the dashboard renders it from the same description instead of
 * two lists drifting apart. A key is in here because an operator can
 * reasonably change it from the dashboard; credentials, provider identity,
 * database and auth URLs stay in the environment and are deliberately absent.
 *
 * Until the cleanup stage the environment is still the source a missing row
 * falls back to, so `environmentVariable` names the variable each key is
 * resolved from today and `default` repeats what that variable's schema
 * defaults to. A key with no variable (the repository catalog switch) has
 * only the default and whatever row the dashboard writes.
 */

/** The panels the dashboard groups these into. */
export type SettingsGroup =
  | "general"
  | "capacity"
  | "attachments"
  | "features"
  | "mcp"
  | "checks"
  | "harness"
  | "issue-tracker"
  | "triggers"
  | "repositories";

/** The shapes a stored value may take. */
export type SettingType = "boolean" | "integer" | "string" | "string-list";

/** Any value a setting may hold, stored or resolved. */
export type SettingValue = boolean | number | string | readonly string[] | null;

/**
 * When a change reaches a run.
 *
 * "next run" is the only honest answer for every key the workflow body reads:
 * a run carries its settings from its start so a replay sees what the first
 * execution saw, and a mid-run change would otherwise flip a branch the log
 * already recorded. "immediate" is for the keys only a request, a cron tick or
 * the MCP transport reads, where each entry loads its own snapshot anyway.
 */
export type SettingsInFlightRule = "immediate" | "next run";

export interface SettingDefinition {
  readonly key: string;
  readonly group: SettingsGroup;
  readonly type: SettingType;
  /** The value used when nothing is stored and the variable is unset. */
  readonly default: SettingValue;
  readonly description: string;
  readonly appliesToRunsInFlight: SettingsInFlightRule;
  /** Whether the trigger-owned configuration work may later override this. */
  readonly overridablePerTrigger: boolean;
  /** The variable a missing row still falls back to, until the cleanup stage. */
  readonly environmentVariable: string | null;
  /** For a string setting whose value is one of a fixed set. */
  readonly enumValues?: readonly string[];
  /** For an integer setting, the smallest value its schema accepts today. */
  readonly minimum?: number;
}

export const SETTINGS_REGISTRY = [
  {
    key: "DASHBOARD_ORG_NAME",
    group: "general",
    type: "string",
    default: "AI Workflow",
    description: "Display name of the organization the dashboard mints invites for.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "DASHBOARD_ORG_NAME",
  },
  {
    key: "DASHBOARD_ORG_SLUG",
    group: "general",
    type: "string",
    default: "ai-workflow",
    description:
      "Slug of the dashboard organization. Also names the agent's memory scope, so a run reads it at its start.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "DASHBOARD_ORG_SLUG",
  },
  {
    key: "GITHUB_BASE_BRANCH",
    group: "general",
    type: "string",
    default: "main",
    description: "Branch new GitHub work branches are cut from when a repository names none.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "GITHUB_BASE_BRANCH",
  },
  {
    key: "GITLAB_BASE_BRANCH",
    group: "general",
    type: "string",
    default: "main",
    description: "Branch new GitLab work branches are cut from when a repository names none.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "GITLAB_BASE_BRANCH",
  },
  {
    key: "MAX_CONCURRENT_AGENTS",
    group: "capacity",
    type: "integer",
    default: 3,
    minimum: 1,
    description: "How many runs may hold an agent slot at once. Every dispatch path shares it.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "MAX_CONCURRENT_AGENTS",
  },
  {
    key: "JOB_TIMEOUT_MS",
    group: "capacity",
    type: "integer",
    default: 1_800_000,
    minimum: 1,
    description: "Wall clock a single agent phase may take before the run gives up on it.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "JOB_TIMEOUT_MS",
  },
  {
    key: "V2_MAX_BLOCK_CONCURRENCY",
    group: "capacity",
    type: "integer",
    default: null,
    minimum: 1,
    description:
      "Operational ceiling on blocks of one run dispatched at once. Unset means the code-owned bound; this only ever lowers it.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "V2_MAX_BLOCK_CONCURRENCY",
  },
  {
    key: "POLL_INTERVAL_MS",
    group: "capacity",
    type: "integer",
    default: 300_000,
    minimum: 1,
    description: "Cadence the scheduled tick polls the issue tracker at.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "POLL_INTERVAL_MS",
  },
  {
    key: "ATTACHMENT_MAX_FILE_SIZE_MB",
    group: "attachments",
    type: "integer",
    default: 25,
    minimum: 1,
    description: "Largest single ticket attachment the agent will download.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "ATTACHMENT_MAX_FILE_SIZE_MB",
  },
  {
    key: "ATTACHMENT_MAX_TOTAL_SIZE_MB",
    group: "attachments",
    type: "integer",
    default: 100,
    minimum: 1,
    description: "Total attachment bytes one run may download.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "ATTACHMENT_MAX_TOTAL_SIZE_MB",
  },
  {
    key: "ATTACHMENT_MAX_COUNT",
    group: "attachments",
    type: "integer",
    default: 20,
    minimum: 1,
    description: "How many attachments of one ticket the agent will download.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "ATTACHMENT_MAX_COUNT",
  },
  {
    key: "ATTACHMENT_DOWNLOAD_TIMEOUT_MS",
    group: "attachments",
    type: "integer",
    default: 30_000,
    minimum: 1,
    description: "Per-attachment download timeout.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "ATTACHMENT_DOWNLOAD_TIMEOUT_MS",
  },
  {
    key: "ENABLE_REVIEW_PHASE",
    group: "features",
    type: "boolean",
    default: false,
    description:
      "Shapes the built-in workflow templates with a review phase. A saved definition's blocks decide the rest.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "ENABLE_REVIEW_PHASE",
  },
  {
    key: "ENABLE_LEAK_REVIEW",
    group: "features",
    type: "boolean",
    default: false,
    description:
      "Shapes the built-in workflow templates with a leak review before the branch is pushed.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "ENABLE_LEAK_REVIEW",
  },
  {
    key: "ENABLE_REPO_MEMORY",
    group: "features",
    type: "boolean",
    default: false,
    description:
      "The kill switch for per-repository agent memory: gates every read and every write, and leaves stored documents untouched when off.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "ENABLE_REPO_MEMORY",
  },
  {
    key: "ENABLE_ORG_MEMORY_PROMOTION",
    group: "features",
    type: "boolean",
    default: false,
    description:
      "Promotes facts two repositories of one owner agree on into an organization document. No effect unless repository memory is on.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "ENABLE_ORG_MEMORY_PROMOTION",
  },
  {
    key: "ENABLE_REPO_ROUTING_MEMORY",
    group: "features",
    type: "boolean",
    default: false,
    description:
      "Remembers which repository a human resolved a ticket label to. No effect unless repository memory is on.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "ENABLE_REPO_ROUTING_MEMORY",
  },
  {
    key: "REVIEW_LEDGER_ENABLED",
    group: "features",
    type: "boolean",
    default: false,
    description: "Tracks every open review thread on a pull request as a work item with a stable alias.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "REVIEW_LEDGER_ENABLED",
  },
  {
    key: "MCP_ENABLED",
    group: "features",
    type: "boolean",
    default: false,
    description: "Serves the remote MCP endpoint. Off means the transport refuses every request.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "MCP_ENABLED",
  },
  {
    key: "MCP_ALLOW_PUBLIC_DCR",
    group: "mcp",
    type: "boolean",
    default: false,
    description: "Allows dynamic client registration without a dashboard session.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "MCP_ALLOW_PUBLIC_DCR",
  },
  {
    key: "MCP_AUDIT_RETENTION_DAYS",
    group: "mcp",
    type: "integer",
    default: 365,
    minimum: 1,
    description: "How long MCP audit rows are kept.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "MCP_AUDIT_RETENTION_DAYS",
  },
  {
    key: "MCP_MAX_REQUEST_BYTES",
    group: "mcp",
    type: "integer",
    default: 1_048_576,
    minimum: 1,
    description: "Largest MCP request body accepted.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "MCP_MAX_REQUEST_BYTES",
  },
  {
    key: "MCP_MAX_RESULT_BYTES",
    group: "mcp",
    type: "integer",
    default: 524_288,
    minimum: 1,
    description: "Largest MCP tool result returned. Must stay at or below the request limit.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "MCP_MAX_RESULT_BYTES",
  },
  {
    key: "MCP_TOOL_TIMEOUT_MS",
    group: "mcp",
    type: "integer",
    default: 30_000,
    minimum: 1_000,
    description: "Wall clock one MCP tool call may take.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "MCP_TOOL_TIMEOUT_MS",
  },
  {
    key: "MCP_READ_RATE_LIMIT_PER_MINUTE",
    group: "mcp",
    type: "integer",
    default: 120,
    minimum: 1,
    description: "Read calls one MCP client may make per minute.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "MCP_READ_RATE_LIMIT_PER_MINUTE",
  },
  {
    key: "MCP_MUTATION_RATE_LIMIT_PER_MINUTE",
    group: "mcp",
    type: "integer",
    default: 20,
    minimum: 1,
    description: "Mutating calls one MCP client may make per minute.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "MCP_MUTATION_RATE_LIMIT_PER_MINUTE",
  },
  {
    key: "PRE_PR_COMMAND_TIMEOUT_MINUTES",
    group: "checks",
    type: "integer",
    default: 10,
    minimum: 1,
    description:
      "Per-command wall clock for repository checks when the repository names none of its own.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "PRE_PR_COMMAND_TIMEOUT_MINUTES",
  },
  {
    key: "PRE_PR_CHECKS_ALLOWED_ENV",
    group: "checks",
    type: "string-list",
    default: [],
    description:
      "Variable names the worker is willing to forward into a tenant's check commands. A name absent here is refused at save time.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "PRE_PR_CHECKS_ALLOWED_ENV",
  },
  {
    key: "AGENT_KIND",
    group: "harness",
    type: "string",
    enumValues: ["claude", "codex"],
    default: "claude",
    description:
      "Which coding agent a deployment defaults to. A harness profile still decides the agent of a given run.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "AGENT_KIND",
  },
  {
    key: "CLAUDE_MODEL",
    group: "harness",
    type: "string",
    default: null,
    description: "Default Claude model when no harness profile pins one.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "CLAUDE_MODEL",
  },
  {
    key: "CODEX_MODEL",
    group: "harness",
    type: "string",
    default: null,
    description: "Default Codex model when no harness profile pins one.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
    environmentVariable: "CODEX_MODEL",
  },
  {
    key: "COLUMN_AI",
    group: "issue-tracker",
    type: "string",
    default: "AI",
    description: "Board column a ticket enters to be assigned to the agent.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: true,
    environmentVariable: "COLUMN_AI",
  },
  {
    key: "COLUMN_AI_REVIEW",
    group: "issue-tracker",
    type: "string",
    default: "AI Review",
    description: "Board column a finished ticket is moved to for human review.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: true,
    environmentVariable: "COLUMN_AI_REVIEW",
  },
  {
    key: "COLUMN_BACKLOG",
    group: "issue-tracker",
    type: "string",
    default: "Backlog",
    description: "Board column a ticket is bounced back to when the agent needs clarification.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: true,
    environmentVariable: "COLUMN_BACKLOG",
  },
  {
    key: "TRIGGER_RATE_LIMIT_MAX",
    group: "triggers",
    type: "integer",
    default: null,
    minimum: 1,
    description:
      "Default start budget for a trigger node that declares none. Unset means unlimited.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: true,
    environmentVariable: "TRIGGER_RATE_LIMIT_MAX",
  },
  {
    key: "TRIGGER_RATE_LIMIT_WINDOW",
    group: "triggers",
    type: "string",
    enumValues: ["minute", "hour", "day", "month"],
    default: null,
    description: "The window the default trigger start budget is counted over.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: true,
    environmentVariable: "TRIGGER_RATE_LIMIT_WINDOW",
  },
  {
    key: "catalog.activated",
    group: "repositories",
    type: "boolean",
    default: false,
    description:
      "Whether the repository catalog decides access. While off the agent sees everything the installation sees. Set only from the Repositories page.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: null,
  },
] as const satisfies readonly SettingDefinition[];

type RegistryEntry = (typeof SETTINGS_REGISTRY)[number];

/** Every key the registry declares, as a union. */
export type SettingKey = RegistryEntry["key"];

type ValueOfType<E> = E extends { enumValues: readonly (infer V extends string)[] }
  ? V
  : E extends { type: "boolean" }
    ? boolean
    : E extends { type: "integer" }
      ? number
      : E extends { type: "string" }
        ? string
        : E extends { type: "string-list" }
          ? readonly string[]
          : never;

/** A key whose default is null has no value at all until one is set. */
type ValueOfEntry<E> = E extends { default: null }
  ? ValueOfType<E> | null
  : ValueOfType<E>;

/**
 * One resolved value per key, derived from the registry so a key added above
 * is a compile error everywhere it is not handled.
 */
export type SettingsSnapshot = {
  readonly [E in RegistryEntry as E["key"]]: ValueOfEntry<E>;
};

const definitionsByKey = new Map<string, SettingDefinition>(
  SETTINGS_REGISTRY.map((definition) => [definition.key, definition]),
);

/** The definition of one key, or undefined when the key is not a setting. */
export function findSettingDefinition(key: string): SettingDefinition | undefined {
  return definitionsByKey.get(key);
}

/** Why one entry of a patch was refused. Never carries the value itself. */
export interface SettingValidationIssue {
  readonly key: string;
  readonly reason:
    | "unknown_key"
    | "wrong_type"
    | "not_allowed_value"
    | "below_minimum"
    | "null_not_allowed"
    /** A pair the environment schema refuses to boot with. Decided against the
     *  values that would be in force after the write, not against the patch
     *  alone, so it lives with the store rather than in this file. */
    | "above_request_limit";
}

function matchesType(definition: SettingDefinition, value: unknown): boolean {
  switch (definition.type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "string":
      return typeof value === "string";
    case "string-list":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  }
}

/**
 * Check one patch against the registry.
 *
 * Returns every refusal rather than the first, so a form that submits a whole
 * group is told about all of its bad fields at once. An empty result means the
 * patch may be written as it is.
 */
export function validateSettingsPatch(
  patch: Readonly<Record<string, unknown>>,
): SettingValidationIssue[] {
  const issues: SettingValidationIssue[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const definition = findSettingDefinition(key);
    if (!definition) {
      issues.push({ key, reason: "unknown_key" });
      continue;
    }
    if (value === null) {
      if (definition.default !== null) issues.push({ key, reason: "null_not_allowed" });
      continue;
    }
    if (!matchesType(definition, value)) {
      issues.push({ key, reason: "wrong_type" });
      continue;
    }
    if (definition.enumValues && !definition.enumValues.includes(value as string)) {
      issues.push({ key, reason: "not_allowed_value" });
      continue;
    }
    if (definition.minimum !== undefined && (value as number) < definition.minimum) {
      issues.push({ key, reason: "below_minimum" });
    }
  }
  return issues;
}
