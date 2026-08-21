import { z } from "zod";

export interface PrePrCheckRepositoryConfig {
  provider: "github" | "gitlab";
  repoPath: string;
  /**
   * Provisioning commands run before this repository's checks: toolchain
   * installs the sandbox image does not ship. Optional and absent from every
   * config stored before this field existed, so it must stay defaultable.
   */
  setup?: string[];
  commands: string[];
}

export interface PrePrCheckConfig {
  repositories: PrePrCheckRepositoryConfig[];
}

export const emptyPrePrCheckConfig: PrePrCheckConfig = { repositories: [] };

/** @deprecated legacy shape; use repoScriptsConfigSchema */
export const prePrCheckConfigSchema = z
  .object({
    repositories: z.array(
      z
        .object({
          provider: z.enum(["github", "gitlab"]),
          repoPath: z.string().trim().min(1),
          // No .min(1): a repository without provisioning is the normal case,
          // and every config stored before this field omits the key entirely.
          setup: z.array(z.string().trim().min(1)).default([]),
          commands: z.array(z.string().trim().min(1)).min(1),
        })
        .strict(),
    ).default([]),
  })
  .strict();

export function describePrePrCheckIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Repository scripts: the generic successor to pre-PR checks. A repository
// stops being "commands run before a PR" and becomes named groups of
// commands (test, lint, verify...) that any block can select from. This
// contract is additive: prePrCheckConfigSchema above stays exactly as it was
// so existing consumers keep working, and stored legacy configs (the old
// { commands: string[] } shape) parse straight through repoScriptsConfigSchema
// without a migration, normalized to groups.checks.
// ---------------------------------------------------------------------------

export interface RepoScriptsGroupConfig {
  commands: string[]; // default []
  extends?: string[]; // names of sibling groups within the same repository entry
}

export interface RepoScriptsRepositoryConfig {
  provider: "github" | "gitlab";
  repoPath: string; // trimmed, min 1
  setup?: string[]; // default []
  env?: string[]; // default []; NAMES of worker env vars, each /^[A-Z][A-Z0-9_]*$/
  groups: Record<string, RepoScriptsGroupConfig>; // min 1 entry; group name /^[a-z][a-z0-9-]*$/, max 40 chars
  gateGroups?: string[]; // group names required at the publication gate; absent = all groups
  commandTimeoutMinutes?: number; // int >= 1; per-command timeout override
}

export interface RepoScriptsConfig {
  repositories: RepoScriptsRepositoryConfig[]; // default []
  batchTimeoutMinutes?: number; // int >= 1; whole-batch limit override
}

export const emptyRepoScriptsConfig: RepoScriptsConfig = { repositories: [] };

const repoScriptsCommandSchema = z.string().trim().min(1);

// Group names are user-facing identifiers (referenced from extends, gateGroups,
// and eventually a block's group picker), so they get the same shape as any
// other short slug: lowercase, digits, hyphens, capped so it stays readable
// in a dropdown.
const repoScriptsGroupNameSchema = z
  .string()
  .max(40, "group name must be at most 40 characters")
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "group name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens",
  );

// Env entries are NAMES, never values: the actual secret lives in the worker's
// own environment and is looked up by name at execution time, so it never
// gets stored in this config or persisted anywhere near a run record.
const repoScriptsEnvNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "env var name must be SCREAMING_SNAKE_CASE");

// A group with neither its own commands nor anything to extend would run
// nothing, so it is rejected here regardless of its siblings.
const repoScriptsGroupConfigSchema = z
  .object({
    commands: z.array(repoScriptsCommandSchema).default([]),
    extends: z.array(repoScriptsGroupNameSchema).optional(),
  })
  .strict()
  .superRefine((group, ctx) => {
    const hasCommands = group.commands.length > 0;
    const hasExtends = (group.extends?.length ?? 0) > 0;
    if (!hasCommands && !hasExtends) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "group must declare at least one command or extend at least one other group",
      });
    }
  });

const repoScriptsGroupsSchema = z
  .record(repoScriptsGroupNameSchema, repoScriptsGroupConfigSchema)
  .refine((groups) => Object.keys(groups).length >= 1, {
    message: "groups must contain at least one entry",
  });

const repoScriptsProviderSchema = z.enum(["github", "gitlab"]);
const repoScriptsRepoPathSchema = z.string().trim().min(1);
const repoScriptsSetupSchema = z.array(repoScriptsCommandSchema).default([]);
const repoScriptsTimeoutMinutesSchema = z.number().int().min(1);

// Depth-first search over the extends graph, looking for a back edge to a
// group still on the current path (grey). Unknown references are skipped
// here: they are already reported by the "unknown extends reference" check
// below, and walking into them would either throw or produce a confusing
// second issue for the same typo.
function findExtendsCycle(groups: Record<string, RepoScriptsGroupConfig>): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];

  function visit(name: string): string[] | null {
    color.set(name, GRAY);
    path.push(name);
    for (const ref of groups[name]?.extends ?? []) {
      if (!(ref in groups)) continue;
      const refColor = color.get(ref) ?? WHITE;
      if (refColor === GRAY) {
        const cycleStart = path.indexOf(ref);
        return [...path.slice(cycleStart), ref];
      }
      if (refColor === WHITE) {
        const found = visit(ref);
        if (found) return found;
      }
    }
    path.pop();
    color.set(name, BLACK);
    return null;
  }

  for (const name of Object.keys(groups)) {
    if ((color.get(name) ?? WHITE) === WHITE) {
      const found = visit(name);
      if (found) return found;
    }
  }
  return null;
}

// Cross-field checks that need the whole repository entry at once: whether
// extends/gateGroups point at a real sibling group, and whether extends forms
// a cycle. These cannot live on the group schema itself because a group does
// not know its siblings' names while it is being parsed in isolation.
function checkRepoScriptsCrossReferences(
  repo: RepoScriptsRepositoryConfig,
  ctx: z.RefinementCtx,
): void {
  const groupNames = new Set(Object.keys(repo.groups));

  for (const [name, group] of Object.entries(repo.groups)) {
    for (const ref of group.extends ?? []) {
      if (!groupNames.has(ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["groups", name, "extends"],
          message: `unknown group referenced in extends: "${ref}"`,
        });
      }
    }
  }

  for (const ref of repo.gateGroups ?? []) {
    if (!groupNames.has(ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gateGroups"],
        message: `unknown group referenced in gateGroups: "${ref}"`,
      });
    }
  }

  const cyclePath = findExtendsCycle(repo.groups);
  if (cyclePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["groups"],
      message: `cycle detected in extends: ${cyclePath.join(" -> ")}`,
    });
  }
}

// New-shape repository entry, before the cross-reference/cycle refinement is
// layered on top (that refinement is shared with the legacy branch below, so
// it is applied once to the union rather than twice).
const repoScriptsNewRepositoryRawSchema = z
  .object({
    provider: repoScriptsProviderSchema,
    repoPath: repoScriptsRepoPathSchema,
    setup: repoScriptsSetupSchema,
    env: z.array(repoScriptsEnvNameSchema).default([]),
    groups: repoScriptsGroupsSchema,
    gateGroups: z.array(repoScriptsGroupNameSchema).optional(),
    commandTimeoutMinutes: repoScriptsTimeoutMinutesSchema.optional(),
  })
  .strict();

// Legacy shape: a stored repository entry with a flat commands array and no
// groups key at all. This is what every config saved before repository
// scripts existed looks like, so it must keep parsing forever. It normalizes
// to a single "checks" group rather than erroring or requiring a migration.
const repoScriptsLegacyRepositorySchema = z
  .object({
    provider: repoScriptsProviderSchema,
    repoPath: repoScriptsRepoPathSchema,
    setup: repoScriptsSetupSchema,
    commands: z.array(repoScriptsCommandSchema).min(1),
  })
  .strict()
  .transform(
    (legacy): RepoScriptsRepositoryConfig => ({
      provider: legacy.provider,
      repoPath: legacy.repoPath,
      setup: legacy.setup,
      env: [],
      groups: { checks: { commands: legacy.commands } },
    }),
  );

// The union tries the new shape first, then the legacy shape; the two are
// mutually exclusive because both are .strict() and only one of
// groups/commands is accepted at the top level. Either branch lands on the
// same canonical shape, so the cross-reference/cycle refinement is applied
// once, after normalization.
const repoScriptsRepositoryEntrySchema = z
  .union([repoScriptsNewRepositoryRawSchema, repoScriptsLegacyRepositorySchema])
  .superRefine(checkRepoScriptsCrossReferences);

/**
 * The frozen new-shape config contract for repository scripts. Accepts both
 * the new shape (named groups) and the legacy pre-PR checks shape (a flat
 * commands array) anywhere in repositories[], and always outputs the
 * canonical new shape: legacy entries come out normalized to
 * groups.checks.commands.
 */
export const repoScriptsConfigSchema = z
  .object({
    repositories: z.array(repoScriptsRepositoryEntrySchema).default([]),
    batchTimeoutMinutes: repoScriptsTimeoutMinutesSchema.optional(),
  })
  .strict();

/**
 * Depth-first expansion of a group's `extends` chain into a flat command
 * list: dependencies run before the group's own commands, and a command that
 * appears more than once (shared by two extended groups, or repeated by the
 * group itself) only runs at its first occurrence. Callers pass already
 * schema-validated repositories, so the extends graph is guaranteed to be a
 * DAG; this does not re-check for cycles.
 */
export function expandGroupCommands(
  repo: RepoScriptsRepositoryConfig,
  groupNames: string[],
): string[] {
  const seen = new Set<string>();
  const commands: string[] = [];

  function visitGroup(name: string): void {
    const group = repo.groups[name];
    if (!group) {
      throw new Error(`unknown group: "${name}"`);
    }
    for (const dep of group.extends ?? []) {
      visitGroup(dep);
    }
    for (const command of group.commands) {
      if (!seen.has(command)) {
        seen.add(command);
        commands.push(command);
      }
    }
  }

  for (const name of groupNames) {
    visitGroup(name);
  }

  return commands;
}

/**
 * The groups a publication gate must run: gateGroups when configured,
 * otherwise every group on the repository, in the order they were declared.
 */
export function resolveGateGroups(repo: RepoScriptsRepositoryConfig): string[] {
  return repo.gateGroups ?? Object.keys(repo.groups);
}
