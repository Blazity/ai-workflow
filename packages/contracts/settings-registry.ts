/**
 * Every product-behaviour switch this deployment has, as data.
 *
 * One list, in the package both applications share, so the worker resolves a
 * setting and the dashboard renders it from the same description instead of
 * two lists drifting apart. A key is in here because an operator can
 * reasonably change it from the dashboard; credentials, provider identity,
 * database and auth URLs stay in the environment and are deliberately absent.
 *
 * Stored rows decide ordinary settings, with the registry default as the
 * fallback. The three keys marked `requiresRedeploy` are the exception: their
 * running consumers still read the named deployment variable directly.
 */

/** The panels the dashboard groups these into. */
export type SettingsGroup =
  | "general"
  | "capacity"
  | "attachments"
  | "features"
  | "mcp"
  | "checks"
  | "issue-tracker";

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
  /** The fallback when no ordinary row or redeploy-owned variable answers. */
  readonly default: SettingValue;
  readonly description: string;
  readonly appliesToRunsInFlight: SettingsInFlightRule;
  /** Whether the trigger-owned configuration work may later override this. */
  readonly overridablePerTrigger: boolean;
  /** The deployment variable read by a key marked `requiresRedeploy`. */
  readonly environmentVariable?: string;
  /**
   * Whether this deployment still reads the variable itself, so a stored row
   * cannot decide the value alone.
   *
   * Two kinds of key are marked: deployment identity that is read once at
   * module load, before any request exists to resolve a snapshot (the Better
   * Auth instance's organization slug and its public-registration switch), and
   * a key a run reads straight off `process.env` inside a step. Both mean the
   * same thing operationally: the variable has to stay set and a change to it
   * needs a redeploy, so the cleanup stage neither imports it into the store
   * nor asks the operator to remove it.
   *
   * Settings write surfaces refuse these keys because a stored decision would
   * never win. `appliesToRunsInFlight` cannot express that deployment cadence,
   * so the dashboard renders it separately as "after redeploy". Absent means
   * the ordinary case: the value in the store is the value that is read.
   */
  readonly requiresRedeploy?: boolean;
  /** For a string setting whose value is one of a fixed set. */
  readonly enumValues?: readonly string[];
  /** For an integer setting, the smallest value its schema accepts today. */
  readonly minimum?: number;
}

/**
 * Environment names the worker permanently stopped accepting.
 *
 * This is intentionally a frozen literal rather than derived from the
 * registry. Once retired, a later registry edit must not silently make one of
 * these names legal again. Some values moved into Settings and some deleted
 * keys now have another owner; SETUP.md records the replacement for each.
 */
export const RETIRED_ENVIRONMENT_VARIABLES = Object.freeze([
  // Deleted registry keys stay retired so an old deployment cannot revive them through env.
  "DASHBOARD_ORG_NAME",
  "GITHUB_BASE_BRANCH",
  "GITLAB_BASE_BRANCH",
  "MAX_CONCURRENT_AGENTS",
  "JOB_TIMEOUT_MS",
  "V2_MAX_BLOCK_CONCURRENCY",
  "POLL_INTERVAL_MS",
  "ATTACHMENT_MAX_FILE_SIZE_MB",
  "ATTACHMENT_MAX_TOTAL_SIZE_MB",
  "ATTACHMENT_MAX_COUNT",
  "ATTACHMENT_DOWNLOAD_TIMEOUT_MS",
  "ENABLE_REVIEW_PHASE",
  "ENABLE_LEAK_REVIEW",
  "ENABLE_REPO_MEMORY",
  "ENABLE_ORG_MEMORY_PROMOTION",
  "ENABLE_REPO_ROUTING_MEMORY",
  "REVIEW_LEDGER_ENABLED",
  "MCP_ENABLED",
  "MCP_AUDIT_RETENTION_DAYS",
  "MCP_MAX_REQUEST_BYTES",
  "MCP_MAX_RESULT_BYTES",
  "MCP_TOOL_TIMEOUT_MS",
  "MCP_READ_RATE_LIMIT_PER_MINUTE",
  "MCP_MUTATION_RATE_LIMIT_PER_MINUTE",
  "PRE_PR_COMMAND_TIMEOUT_MINUTES",
  "AGENT_KIND",
  "CLAUDE_MODEL",
  "CODEX_MODEL",
  "COLUMN_AI",
  "COLUMN_AI_REVIEW",
  "COLUMN_BACKLOG",
  "TRIGGER_RATE_LIMIT_MAX",
  "TRIGGER_RATE_LIMIT_WINDOW",
] as const);

export const SETTINGS_REGISTRY = [
  {
    key: "DASHBOARD_ORG_NAME",
    group: "general",
    type: "string",
    default: "AI Workflow",
    description: "Display name of the organization the dashboard mints invites for.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
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
    requiresRedeploy: true,
  },
  {
    key: "MAX_CONCURRENT_AGENTS",
    group: "capacity",
    type: "integer",
    default: 3,
    minimum: 1,
    description:
      "How many automatic runs may hold an agent slot at once. Every way a run starts (triggers, the dashboard and workflows.dispatch) checks it.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
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
  },
  {
    key: "ENABLE_REPO_MEMORY",
    group: "features",
    type: "boolean",
    default: false,
    description:
      "Gates repository-memory prompt seeds, distillation, organization promotion and routing memory. The per-ticket workspace memory file is always hydrated and persisted.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
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
  },
  {
    key: "ENABLE_AGENT_BRIEFINGS",
    group: "features",
    type: "boolean",
    // On, because the record only becomes useful once it covers every send: a
    // feature that starts empty answers nothing about the run somebody opens
    // tomorrow.
    default: true,
    description:
      "Records what each model send gave the agent: the prompt section by section with where each piece came from, the harness settings and the repositories in scope. A run reads this once at its start, so switching it off stops the next run rather than one already under way. Every send of a run that started with it off is still marked, as not recorded because capture was off, never as never sent.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
  },
  {
    key: "REVIEW_LEDGER_ENABLED",
    group: "features",
    type: "boolean",
    default: false,
    description: "Tracks every open review thread on a pull request as a work item with a stable alias.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: false,
  },
  {
    key: "MCP_ENABLED",
    group: "features",
    type: "boolean",
    default: false,
    description: "Serves the remote MCP endpoint. Off means the transport refuses every request.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
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
    requiresRedeploy: true,
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
  },
  {
    key: "MCP_TOOL_TIMEOUT_MS",
    group: "mcp",
    type: "integer",
    default: 30_000,
    minimum: 1_000,
    description:
      "Configured wall clock for one MCP tool call. Values above the 240000 ms code ceiling in mcp/execute-tool.ts are clamped.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
  },
  {
    key: "MCP_READ_RATE_LIMIT_PER_MINUTE",
    group: "mcp",
    type: "integer",
    default: 120,
    minimum: 1,
    description: "Read calls allowed per tool per client per minute.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
  },
  {
    key: "MCP_MUTATION_RATE_LIMIT_PER_MINUTE",
    group: "mcp",
    type: "integer",
    default: 20,
    minimum: 1,
    description: "Mutating calls allowed per tool per client per minute.",
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
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
    // The checks runner reads this straight off `process.env`
    // (`allowedRepoEnvNames`, engine/steps/pre-pr-checks-runner.ts), and says so
    // in its own comment: only the operator, in the hosting dashboard, decides
    // the worker may hand a value to a tenant's command. The settings surfaces
    // expose this key read-only; change its variable and redeploy.
    requiresRedeploy: true,
  },
  {
    key: "COLUMN_AI",
    group: "issue-tracker",
    type: "string",
    default: "AI",
    description: "Board column a ticket enters to be assigned to the agent.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: true,
  },
  {
    key: "COLUMN_AI_REVIEW",
    group: "issue-tracker",
    type: "string",
    default: "AI Review",
    description: "Board column a finished ticket is moved to for human review.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: true,
  },
  {
    key: "COLUMN_BACKLOG",
    group: "issue-tracker",
    type: "string",
    default: "Backlog",
    description: "Board column a ticket is bounced back to when the agent needs clarification.",
    appliesToRunsInFlight: "next run",
    overridablePerTrigger: true,
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
