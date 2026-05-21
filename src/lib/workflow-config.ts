/**
 * workflow-config.ts
 *
 * Loads and validates workflow.config.yaml at startup or on-demand.
 *
 * Config hash: SHA-256 hex digest of a canonical JSON representation of the
 * parsed+validated config object (object keys sorted recursively before
 * JSON.stringify). Stable across Node versions; changes whenever any config
 * value changes.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "../../env.js";

// ---------------------------------------------------------------------------
// js-yaml — already installed as a transitive dep; loaded via CJS interop so
// we don't need @types/js-yaml or the yaml ESM package at runtime.
// ---------------------------------------------------------------------------
const _require = createRequire(import.meta.url);
const jsYaml = _require("js-yaml") as {
  load: (input: string, options?: Record<string, unknown>) => unknown;
  JSON_SCHEMA: unknown;
};
const { load: parseYamlRaw, JSON_SCHEMA } = jsYaml;
/**
 * Parse YAML using the JSON_SCHEMA. This rejects custom tags (e.g. `!!js/function`)
 * and YAML-only scalar types (timestamps, binary, etc.) — only JSON-compatible
 * scalars are accepted. Defensive against attacker-influenced config (e.g. a
 * future PR-time `workflow.config.yaml` read at the target repo head).
 */
function parseYaml(input: string): unknown {
  return parseYamlRaw(input, { schema: JSON_SCHEMA });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SeveritySchema = z.enum(["info", "warning", "critical"]);
const TriggerSchema = z.enum(["opened", "synchronize", "reopened", "labeled"]);
const CheckKindSchema = z.enum(["complexity", "ai_review"]);

const CommentsConfigSchema = z
  .object({
    enabled: z.boolean(),
    severity_threshold: SeveritySchema,
    suggestions: z.boolean().optional(),
    suggestions_threshold: SeveritySchema.optional(),
  })
  .strict();

const CacheConfigSchema = z
  .object({
    mode: z.enum(["none", "per_file_content_hash"]),
    reuse_previous_annotations: z.boolean().optional(),
  })
  .strict();

const CheckConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "id must be kebab-case"),
    kind: CheckKindSchema,
    name: z.string().min(1),
    enabled: z.boolean(),
    blocking: z.boolean(),
    fail_on: SeveritySchema,
    needs: z.array(z.string()).optional(),
    skip_on_dependency_failure: z.boolean().optional(),
    comments: CommentsConfigSchema.optional(),
    cache: CacheConfigSchema.optional(),
    // params are validated by each check's own paramsSchema — accept anything here
    params: z.record(z.unknown()).optional(),
  })
  .strict();

export type CheckConfig = z.infer<typeof CheckConfigSchema>;

const LimitsSchema = z
  .object({
    max_changed_files: z.number().int().positive(),
    max_total_diff_bytes: z.number().int().positive(),
    max_file_content_bytes: z.number().int().positive(),
    max_check_annotations: z.number().int().positive(),
    max_review_comments: z.number().int().positive(),
    max_suggestions: z.number().int().positive(),
  })
  .strict();

/**
 * Discriminated union on `mode` so each variant carries the field it needs:
 * - "all" requires nothing extra
 * - "label" requires `label`
 * - "branch_prefix" requires `branch_prefix`
 * This catches misconfigurations like `mode: label` without a `label` value
 * at config-load time rather than at trigger-evaluation time.
 */
const ScopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({ mode: z.literal("label"), label: z.string().min(1) }).strict(),
  z
    .object({ mode: z.literal("branch_prefix"), branch_prefix: z.string().min(1) })
    .strict(),
]);

const ReviewConfigSchema = z
  .object({
    enabled: z.boolean(),
    scope: ScopeSchema,
    triggers: z.array(TriggerSchema),
    default_ignore: z.array(z.string()),
    limits: LimitsSchema,
    checks: z.array(CheckConfigSchema),
  })
  .strict();

export const WorkflowConfigSchema = z
  .object({
    version: z.literal(1),
    review: ReviewConfigSchema,
  })
  .strict();

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

// ---------------------------------------------------------------------------
// Canonical JSON hash
// ---------------------------------------------------------------------------

/**
 * Recursively sorts object keys before serializing so the hash is stable
 * regardless of insertion order in the parsed YAML object.
 */
function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJsonStringify).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const sorted = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => {
        const v = (value as Record<string, unknown>)[k];
        return JSON.stringify(k) + ":" + canonicalJsonStringify(v);
      });
    return "{" + sorted.join(",") + "}";
  }
  return JSON.stringify(value);
}

function computeConfigHash(config: WorkflowConfig): string {
  const canonical = canonicalJsonStringify(config);
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

function validateCheckSemantics(checks: CheckConfig[], filePath: string): void {
  const seenIds = new Set<string>();

  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]!;

    // Unique IDs
    if (seenIds.has(check.id)) {
      throw new Error(
        `[${filePath}] Duplicate check id "${check.id}" — each check must have a unique id`,
      );
    }
    seenIds.add(check.id);

    // needs must reference earlier checks only (prevents forward references and cycles)
    if (check.needs && check.needs.length > 0) {
      const earlierIds = new Set(checks.slice(0, i).map((c) => c.id));
      for (const dep of check.needs) {
        if (!earlierIds.has(dep)) {
          if (seenIds.has(dep) && dep !== check.id) {
            // dep is a later check (forward reference)
            throw new Error(
              `[${filePath}] Check "${check.id}" has needs "${dep}" which is defined later — needs must only reference earlier checks`,
            );
          }
          throw new Error(
            `[${filePath}] Check "${check.id}" has needs "${dep}" which is not a known check id`,
          );
        }
      }
    }
  }

  // True DAG cycle detection via DFS — independent of declaration order.
  // The order-linear rule above already catches cycles, but explicit cycle
  // detection makes the validation correct for future parallel/topo-sorted
  // execution where declaration order won't be load-bearing.
  detectCycles(checks, filePath);
}

function detectCycles(checks: CheckConfig[], filePath: string): void {
  const graph = new Map<string, string[]>();
  for (const c of checks) {
    graph.set(c.id, c.needs ?? []);
  }

  // Tri-state DFS coloring: 0 = unvisited, 1 = on current path, 2 = fully explored.
  const state = new Map<string, 0 | 1 | 2>();
  for (const c of checks) state.set(c.id, 0);

  const visit = (id: string, path: string[]): void => {
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) {
      const cycleStart = path.indexOf(id);
      const cycle = [...path.slice(cycleStart), id].join(" -> ");
      throw new Error(
        `[${filePath}] Cycle detected in check dependencies: ${cycle}`,
      );
    }
    state.set(id, 1);
    for (const dep of graph.get(id) ?? []) {
      // unknown-id case is already handled by the order-linear pass; skip silently here.
      if (!graph.has(dep)) continue;
      visit(dep, [...path, id]);
    }
    state.set(id, 2);
  };

  for (const c of checks) {
    if (state.get(c.id) === 0) visit(c.id, []);
  }
}

// ---------------------------------------------------------------------------
// Per-check params validation via the check registry
// ---------------------------------------------------------------------------

/**
 * After the structural Zod schema accepts the YAML, each check's `params` is
 * still typed as `Record<string, unknown>`. Walk the registry and parse params
 * through each check's own `paramsSchema` so misconfiguration fails at startup
 * (and not on first webhook delivery, when it's too late to surface to ops).
 *
 * Side effect: replaces each check's `params` with the parsed/typed result, so
 * downstream code (review.ts:runCheckStep) effectively re-parses a no-op.
 */
async function validateCheckParams(
  checks: CheckConfig[],
  filePath: string,
): Promise<void> {
  // Trigger self-registration of built-in checks. These modules call
  // registerCheck() at module-eval time.
  await import("./checks/complexity.js");
  await import("./checks/ai-review.js");
  const { getCheck } = await import("./checks/registry.js");

  for (const check of checks) {
    const impl = getCheck(check.kind);
    if (!impl) {
      // Structural schema already rejects unknown kinds; this is a defense in
      // depth if the registry hasn't been wired up for a declared kind.
      throw new Error(
        `[${filePath}] Check "${check.id}" has kind "${check.kind}" which has no implementation registered`,
      );
    }
    const result = impl.paramsSchema.safeParse(check.params ?? {});
    if (!result.success) {
      const formatted = JSON.stringify(result.error.format(), null, 2);
      throw new Error(
        `[${filePath}] Invalid params for check "${check.id}" (kind=${check.kind}):\n${formatted}`,
      );
    }
    // Replace with the parsed/typed result so downstream consumers get
    // defaults filled in and don't re-validate.
    check.params = result.data as Record<string, unknown>;
  }
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

export interface LoadConfigOptions {
  /** Override the config file path. Falls back to WORKFLOW_CONFIG_PATH env var, then "workflow.config.yaml". */
  path?: string;
  /**
   * When true and review.enabled is true, throws if the active VCS provider's
   * webhook secret env var is unset. Provider is selected by VCS_KIND.
   * Use this from the webhook startup path; do not set it on general code paths.
   */
  requireWebhookSecret?: boolean;
}

export interface LoadConfigResult {
  config: WorkflowConfig;
  /** SHA-256 hex digest of canonical JSON representation of config. */
  configHash: string;
}

export async function loadConfig(opts?: LoadConfigOptions): Promise<LoadConfigResult> {
  const filePath = opts?.path ?? env.WORKFLOW_CONFIG_PATH ?? "workflow.config.yaml";

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `[${filePath}] Failed to read workflow config: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `[${filePath}] Failed to parse YAML: ${(err as Error).message}`,
    );
  }

  const result = WorkflowConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`[${filePath}] Invalid workflow config:\n${details}`);
  }

  const config = result.data;

  validateCheckSemantics(config.review.checks, filePath);
  await validateCheckParams(config.review.checks, filePath);

  if (opts?.requireWebhookSecret && config.review.enabled) {
    // Gate the webhook-secret requirement on the active VCS provider so a
    // GitLab deploy isn't forced to set a GitHub-specific env var.
    switch (env.VCS_KIND) {
      case "github":
        if (!env.GITHUB_WEBHOOK_SECRET) {
          throw new Error(
            `[${filePath}] review.enabled is true but GITHUB_WEBHOOK_SECRET is not set`,
          );
        }
        break;
      case "gitlab":
        // GitLab adapter has no webhook entry yet; no secret to require.
        break;
    }
  }

  const configHash = computeConfigHash(config);

  return { config, configHash };
}
