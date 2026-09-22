import { z } from "zod";
import { WORKFLOW_SUBJECT_FIELDS } from "@shared/contracts";
import { INTEGRATION_CAPABILITIES } from "./capabilities";
import { connectionValueProblem } from "./manifest";

/**
 * The check every integration package passes in CI (S1 runs it over each one).
 * It takes the manifest and the runtime as `unknown` because its job is the
 * package the compiler did not hold to the contract: plain JavaScript, a cast,
 * or a manifest that parses under zod 3 and crashes under the zod 4 the
 * production bundle loads.
 *
 * It returns every issue it finds rather than stopping at the first, except
 * when the manifest does not parse at all: then the parse issues are the
 * report, since every later rule reads fields that are not there.
 */
export type ConformanceCode =
  | "manifest_invalid"
  | "id_invalid"
  | "id_reserved"
  | "duplicate"
  | "connection_env_invalid"
  | "connection_env_reserved"
  | "connection_secret_unflagged"
  | "connection_secret_default"
  | "connection_default_invalid"
  | "capability_unknown"
  | "capability_reserved"
  | "capability_adapter_missing"
  | "block_type_invalid"
  | "block_ports_unsupported"
  | "block_params_schema_missing"
  | "block_params_schema_one_argument_record"
  | "block_executor_missing"
  | "block_must_read_undeclared"
  | "block_input_default_invalid"
  | "connection_test_missing"
  | "health_checks_missing"
  | "health_probe_missing"
  | "page_id_invalid"
  | "page_reader_undeclared"
  | "run_state_missing"
  | "run_state_undeclared"
  | "implementation_undeclared"
  | "webhook_receive_missing"
  | "reserved_slot_used";

export interface ConformanceIssue {
  readonly code: ConformanceCode;
  /** Where, as `blocks[0].paramsSchema.headers` or `runtime.blocks.acme_lookup`. */
  readonly path: string;
  /** What is wrong and what to do, for the developer reading the CI log. */
  readonly message: string;
}

/** The health check core adds to every integration's section; a manifest may
 *  not declare one under the same id. */
export const RESERVED_HEALTH_CHECK_ID = "connection";

/**
 * Ids core's own health sections occupy while core still reports them.
 *
 * The health page holds one section per id, and an integration's checks and
 * probes are keyed under its id, so an integration called `jira` would draw a
 * second Jira row that could disagree with core's. This list shrinks: the
 * stage that moves a provider out of core (S8 to S12) deletes its row here in
 * the same change that deletes core's section, which is how the provider's own
 * integration comes to be allowed to take the name.
 */
export const CORE_HEALTH_SECTION_IDS: readonly string[] = [
  "custom-webhooks",
  "dashboard-auth",
  "database",
  "email",
  "sso",
];

/**
 * Ids an integration may not take. Each is a word core already uses as an
 * identifier or a string (a capability, a route under `/webhooks` that is not
 * an integration, a screen, a concept), so the core-reference gate of S1
 * could not tell the integration's name from core's own code, and some would
 * shadow a URL.
 */
export const RESERVED_INTEGRATION_IDS: readonly string[] = [
  ...Object.keys(INTEGRATION_CAPABILITIES),
  ...CORE_HEALTH_SECTION_IDS,
  // Routes under /webhooks today that belong to core, not to an integration.
  "custom",
  "resend",
  // Worker route roots and dashboard sections.
  "api",
  "approvals",
  "auth",
  "checks",
  "cost",
  "cron",
  "editor",
  "evals",
  "health",
  "mcp",
  "profiles",
  "prompts",
  "settings",
  "trace",
  // Concepts core names everywhere, and the agent providers the harness owns.
  "agent",
  "agents",
  "block",
  "blocks",
  "claude",
  "codex",
  "connection",
  "core",
  "default",
  "fixture",
  "fixtures",
  "integration",
  "integrations",
  "llm",
  "none",
  "repositories",
  "repository",
  "run",
  "runs",
  "sandbox",
  "schedule",
  "sdk",
  "status",
  "system",
  "template",
  "test",
  "ticket",
  "tickets",
  "trigger",
  "triggers",
  "unknown",
  "user",
  "users",
  "webhook",
  "webhooks",
  "workflow",
  "workflows",
];

/**
 * Environment variables core reads for itself: its database, its session and
 * SSO secrets, its cron and webhook keys, the agent and model credentials the
 * harness owns, the platform's own variables, and the key integration secrets
 * are stored under. A field on one of these would read Connected from core's
 * own configuration and hand its value back through the dashboard, and a name
 * such as DATABASE_URL carries no credential word to catch it.
 *
 * The provider variables core reads today (JIRA_*, GITHUB_*, GITLAB_*) are
 * deliberately absent: they belong to the integrations that take them over in
 * S10 to S12. GENAI_ENGINE_* left with Arthur in S8, CHAT_SDK_* and SLACK_*
 * with Slack in S9. S1 asserts this list
 * stays equal to the core-owned names in
 * `apps/worker/src/infra/runtime-env.ts`.
 */
export const RESERVED_ENVIRONMENT_VARIABLES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CODEX_API_KEY",
  "CODEX_CHATGPT_OAUTH_TOKEN",
  "CODEX_PRICING_TTL_MS",
  "CODEX_PRICING_URL",
  "COMMIT_AUTHOR",
  "COMMIT_EMAIL",
  "CRON_SECRET",
  "DASHBOARD_AUTH_EMAIL",
  "DASHBOARD_AUTH_PASSWORD",
  "DASHBOARD_ORG_SLUG",
  "DASHBOARD_ORIGIN",
  "DASHBOARD_TRUSTED_ORIGINS",
  "DATABASE_URL",
  "HOME",
  "INTEGRATION_SECRETS_KEY",
  "ISSUE_TRACKER_KIND",
  "LOG_LEVEL",
  "MCP_ALLOW_PUBLIC_DCR",
  "MCP_DOGFOOD_FIXTURE_PREFIX",
  "MCP_SERVER_VERSION",
  "PATH",
  "POST_PR_GATE_CONFIG_PATH",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "RESEND_WEBHOOK_SECRET",
  "SERVERLESS",
  "SSO_ALLOWED_DOMAIN",
  "SSO_CLIENT_ID",
  "SSO_CLIENT_SECRET",
  "SSO_ISSUER",
  "VCS_BOT_LOGIN",
  "VCS_KIND",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID",
  "VERCEL_TOKEN",
  "WEBHOOK_TRIGGER_ENCRYPTION_KEY",
  "WORKFLOW_SCHEDULING_GOLDEN_SINK",
];

const ID = /^[a-z][a-z0-9]{2,31}$/;
const ENV = /^[A-Z][A-Z0-9_]*$/;
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const RESERVED_PAGE_IDS = new Set(["connection"]);
/**
 * Slots the contract names and no stage has designed yet. Empty today: S9
 * released `webhook`, the last one. Kept because the next reserved slot is one
 * line here and a message that names its stage, rather than a silent `never`
 * whose refusal reads as a type error nobody can place.
 */
const RESERVED_RUNTIME_SLOTS: Record<string, string> = {};
const CREDENTIAL_WORDS = new Set([
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "CREDENTIAL",
  "CREDENTIALS",
  "APIKEY",
  "DSN",
]);
const CREDENTIAL_PAIRS = new Set([
  "PRIVATE_KEY",
  "API_KEY",
  "SIGNING_KEY",
  "CONNECTION_STRING",
]);

const text = z.string().min(1);

// Structure only. The rules with their own codes (patterns, duplicates,
// secrets, capabilities) are checked after the parse, so each can say exactly
// what is wrong. Written with the zod API that zod 3 and zod 4 share.
const manifestSchema = z.object({
  id: z.string(),
  name: text,
  description: text,
  docsUrl: z.string().optional(),
  connection: z.object({
    fields: z.array(
      z.object({
        key: text,
        label: text,
        description: z.string().optional(),
        env: z.string(),
        secret: z.boolean(),
        optional: z.boolean().optional(),
        default: z.string().optional(),
        format: z.enum(["text", "multiline", "url", "integer"]).optional(),
      }),
    ),
  }),
  capabilities: z.array(z.string()),
  blocks: z.array(
    z.object({
      type: z.string(),
      paramsSchema: z.unknown(),
      contract: z.object({ ports: z.array(text).min(1), allowsFailurePort: z.boolean() }),
      ui: z.object({ label: text, description: text, glyph: text, color: text, softColor: text }),
      defaults: z.record(z.string(), z.unknown()).optional(),
      inputs: z.record(z.string(), z.unknown()).optional(),
      additionalInputs: z.array(z.unknown()).optional(),
      output: z.object({
        properties: z.record(z.string(), z.unknown()),
        required: z.array(z.string()).optional(),
        statusVariants: z.array(text).min(1),
        mustRead: z.array(z.string()).optional(),
      }),
      requires: z
        .object({ capabilities: z.array(z.string()).optional(), llm: z.boolean().optional() })
        .optional(),
    }),
  ),
  pages: z.array(z.object({ id: z.string(), label: text })),
  health: z.array(z.object({ id: text, label: text, description: text, critical: z.boolean() })),
  runState: z.boolean().optional(),
});

type ParsedManifest = z.infer<typeof manifestSchema>;
type Report = (code: ConformanceCode, path: string, message: string) => void;
type Runtime = Record<string, unknown>;

export function checkIntegrationConformance(
  manifest: unknown,
  runtime: unknown,
): readonly ConformanceIssue[] {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => {
      const path = formatPath(issue.path);
      return {
        code: "manifest_invalid" as const,
        path,
        message: `The manifest does not parse at ${path || "its root"}: ${issue.message}.`,
      };
    });
  }
  const issues: ConformanceIssue[] = [];
  const report: Report = (code, path, message) => issues.push({ code, path, message });
  const declared = parsed.data;
  const implemented = isRecord(runtime) ? runtime : {};

  checkIdentity(declared, report);
  checkConnection(declared, report);
  if (typeof implemented.testConnection !== "function") {
    report(
      "connection_test_missing",
      "runtime.testConnection",
      "The runtime has no testConnection; without one nobody can tell whether the values an admin entered work.",
    );
  }
  checkCapabilities(declared, implemented, report);
  checkBlocks(declared, implemented, report);
  checkHealth(declared, implemented, report);
  checkPages(declared, implemented, report);
  checkRunState(declared, implemented, report);
  checkRuntimeSlots(implemented, report);
  return issues;
}

function checkIdentity(manifest: ParsedManifest, report: Report) {
  if (!ID.test(manifest.id)) {
    report(
      "id_invalid",
      "id",
      `Integration id "${manifest.id}" must be 3 to 32 lowercase letters and digits, starting with a letter.`,
    );
  } else if (RESERVED_INTEGRATION_IDS.includes(manifest.id)) {
    report(
      "id_reserved",
      "id",
      `Integration id "${manifest.id}" is a word core already uses; choose the provider's own name.`,
    );
  }
}

function checkConnection(manifest: ParsedManifest, report: Report) {
  const keys = new Set<string>();
  const envs = new Set<string>();
  manifest.connection.fields.forEach((field, index) => {
    const path = `connection.fields[${index}]`;
    if (keys.has(field.key)) {
      report("duplicate", `${path}.key`, `Connection field key "${field.key}" is declared twice.`);
    }
    keys.add(field.key);
    if (!ENV.test(field.env)) {
      report(
        "connection_env_invalid",
        `${path}.env`,
        `Connection field "${field.key}" needs an environment variable name in UPPER_SNAKE_CASE, not "${field.env}".`,
      );
    } else if (
      RESERVED_ENVIRONMENT_VARIABLES.includes(field.env) &&
      !(
        field.env === "VCS_BOT_LOGIN" &&
        field.key === "legacyBotLogin" &&
        manifest.capabilities.includes("vcs")
      )
    ) {
      report(
        "connection_env_reserved",
        `${path}.env`,
        `${field.env} is core's own variable; a field on it would read core's configuration as this integration's connection. Choose a name of the provider's own.`,
      );
    } else if (envs.has(field.env)) {
      report("duplicate", `${path}.env`, `Environment variable ${field.env} is declared by two fields.`);
    }
    envs.add(field.env);
    if (!field.secret && namesCredential(field.key, field.env)) {
      report(
        "connection_secret_unflagged",
        `${path}.secret`,
        `Connection field "${field.key}" (${field.env}) carries a credential and must be declared secret: true.`,
      );
    }
    if (field.default === undefined) return;
    if (field.secret) {
      report(
        "connection_secret_default",
        `${path}.default`,
        `Secret field "${field.key}" has a default; a secret in source code is a leaked secret.`,
      );
    } else if (connectionValueProblem(field.default, field.format) !== null) {
      report(
        "connection_default_invalid",
        `${path}.default`,
        `The default of "${field.key}" is not a valid ${field.format} value.`,
      );
    }
  });
}

function checkCapabilities(manifest: ParsedManifest, runtime: Runtime, report: Report) {
  const adapters = isRecord(runtime.capabilities) ? runtime.capabilities : {};
  manifest.capabilities.forEach((capability, index) => {
    const path = `capabilities[${index}]`;
    if (!checkCapabilityId(capability, path, report)) return;
    if (typeof adapters[capability] !== "function") {
      report(
        "capability_adapter_missing",
        path,
        `Capability "${capability}" is declared but the runtime has no adapter factory for it.`,
      );
    }
  });
  for (const key of Object.keys(adapters)) {
    if (!manifest.capabilities.includes(key)) {
      report(
        "implementation_undeclared",
        `runtime.capabilities.${key}`,
        `The runtime has an adapter for "${key}", which the manifest does not declare.`,
      );
    }
  }
}

/** Reports an unknown or reserved capability id; true when the id has a port. */
function checkCapabilityId(capability: string, path: string, report: Report): boolean {
  if (!Object.hasOwn(INTEGRATION_CAPABILITIES, capability)) {
    report(
      "capability_unknown",
      path,
      `"${capability}" is not a capability core knows: ${Object.keys(INTEGRATION_CAPABILITIES).join(", ")}.`,
    );
    return false;
  }
  const { reservedFor } = INTEGRATION_CAPABILITIES[capability as keyof typeof INTEGRATION_CAPABILITIES];
  if (reservedFor !== null) {
    report(
      "capability_reserved",
      path,
      `Capability "${capability}" is reserved: its port is designed in ${reservedFor}.`,
    );
    return false;
  }
  return true;
}

function checkBlocks(manifest: ParsedManifest, runtime: Runtime, report: Report) {
  const executors = isRecord(runtime.blocks) ? runtime.blocks : {};
  const types = new Set<string>();
  const prefix = `${manifest.id}_`;
  manifest.blocks.forEach((block, index) => {
    const path = `blocks[${index}]`;
    if (!block.type.startsWith(prefix) || !SNAKE.test(block.type.slice(prefix.length))) {
      report(
        "block_type_invalid",
        `${path}.type`,
        `Block type "${block.type}" must be "${prefix}" followed by a snake_case name.`,
      );
    }
    if (types.has(block.type)) {
      report("duplicate", `${path}.type`, `Block type "${block.type}" is declared twice.`);
    }
    types.add(block.type);
    if (block.contract.ports.length !== 1 || block.contract.ports[0] !== "out") {
      report(
        "block_ports_unsupported",
        `${path}.contract.ports`,
        `Block "${block.type}" declares ${JSON.stringify(block.contract.ports)}; an integration block has exactly one port named "out". ` +
          "The workflow graph reads ports from core's generated catalog, which holds no integration block, so it resolves every one of them to a single port named \"out\": a second port is offered in the editor, refused at publish as an unknown port, and propagates to nothing at run time. " +
          "Until the graph learns a manifest's ports (ADR-010), branch downstream on the block's status output.",
      );
    }
    if (isZodSchema(block.paramsSchema)) {
      for (const at of oneArgumentRecords(block.paramsSchema, `${path}.paramsSchema`, new Set())) {
        report(
          "block_params_schema_one_argument_record",
          at,
          `Block "${block.type}" uses z.record with one argument at ${at}. zod 4, which production runs, crashes on it at the first parse; write z.record(z.string(), value).`,
        );
      }
    } else {
      report(
        "block_params_schema_missing",
        `${path}.paramsSchema`,
        `Block "${block.type}" needs a params schema written with the z exported by @integrations/sdk.`,
      );
    }
    for (const [position, field] of (block.output.mustRead ?? []).entries()) {
      if (field === "status" || Object.hasOwn(block.output.properties, field)) continue;
      report(
        "block_must_read_undeclared",
        `${path}.output.mustRead[${position}]`,
        `Block "${block.type}" says a graph must read "${field}", which its output does not declare. Name "status" or one of its output properties.`,
      );
    }
    for (const [name, input] of Object.entries(block.inputs ?? {})) {
      if (!isRecord(input) || input.defaultFromSubject === undefined) continue;
      const fields = input.defaultFromSubject;
      const schema = isRecord(input.schema) ? input.schema : {};
      const known = new Set<unknown>(WORKFLOW_SUBJECT_FIELDS);
      if (
        !Array.isArray(fields) ||
        fields.length === 0 ||
        !fields.every((field) => known.has(field)) ||
        schema.type !== "string"
      ) {
        report(
          "block_input_default_invalid",
          `${path}.inputs.${name}.defaultFromSubject`,
          `Block "${block.type}" input "${name}" defaults to ${JSON.stringify(fields)}. A default names one or more of ${WORKFLOW_SUBJECT_FIELDS.join(", ")}, and only a text input can have one.`,
        );
      }
    }
    block.requires?.capabilities?.forEach((capability, position) => {
      checkCapabilityId(capability, `${path}.requires.capabilities[${position}]`, report);
    });
    if (typeof executors[block.type] !== "function") {
      report(
        "block_executor_missing",
        path,
        `Block "${block.type}" is declared but the runtime has no executor for it.`,
      );
    }
  });
  for (const key of Object.keys(executors)) {
    if (!types.has(key)) {
      report(
        "implementation_undeclared",
        `runtime.blocks.${key}`,
        `The runtime has an executor for "${key}", which the manifest does not declare.`,
      );
    }
  }
}

function checkHealth(manifest: ParsedManifest, runtime: Runtime, report: Report) {
  const probes = isRecord(runtime.health) ? runtime.health : {};
  if (manifest.health.length === 0) {
    report(
      "health_checks_missing",
      "health",
      "The manifest declares no health check; declare at least one so the health page can say whether the integration works.",
    );
  }
  const ids = new Set<string>();
  manifest.health.forEach((check, index) => {
    const path = `health[${index}]`;
    if (ids.has(check.id)) report("duplicate", `${path}.id`, `Health check "${check.id}" is declared twice.`);
    // Core adds one check of its own to every integration's section, saying
    // where the connection comes from and whether it is complete. A declared
    // check under that id would be a second row with the same id, probed by
    // this integration's probe.
    if (check.id === RESERVED_HEALTH_CHECK_ID) {
      report(
        "id_reserved",
        `${path}.id`,
        `Health check id "${RESERVED_HEALTH_CHECK_ID}" belongs to core, which reports the connection itself; name this check after what it verifies.`,
      );
    }
    ids.add(check.id);
    if (typeof probes[check.id] !== "function") {
      report(
        "health_probe_missing",
        path,
        `Health check "${check.id}" is declared but the runtime has no probe for it.`,
      );
    }
  });
  for (const key of Object.keys(probes)) {
    if (!ids.has(key)) {
      report(
        "implementation_undeclared",
        `runtime.health.${key}`,
        `The runtime has a probe for "${key}", which the manifest does not declare.`,
      );
    }
  }
}

function checkPages(manifest: ParsedManifest, runtime: Runtime, report: Report) {
  const ids = new Set<string>();
  manifest.pages.forEach((page, index) => {
    const path = `pages[${index}].id`;
    if (!SLUG.test(page.id) || RESERVED_PAGE_IDS.has(page.id)) {
      report(
        "page_id_invalid",
        path,
        `Page id "${page.id}" must be lowercase words joined by hyphens, and not "connection", which is the core tab.`,
      );
    } else if (ids.has(page.id)) {
      report("duplicate", path, `Page id "${page.id}" is declared twice.`);
    }
    ids.add(page.id);
  });
  // A reader for a page nobody declared is code the cockpit can never reach,
  // and the mistake is almost always a renamed page.
  const readers = isRecord(runtime.api) ? runtime.api : {};
  for (const key of Object.keys(readers)) {
    if (ids.has(key)) continue;
    report(
      "page_reader_undeclared",
      `runtime.api.${key}`,
      `The runtime reads data for a page "${key}", which the manifest does not declare. A page with no tab is never rendered, so nothing would ever call it.`,
    );
  }
}

/**
 * Run state is declared and served together. A manifest that declares it with
 * no `beginRun` hands every use `null`, and a `beginRun` nobody declared is
 * never called, so both halves fail here rather than at the first run that
 * needed the handle.
 */
function checkRunState(manifest: ParsedManifest, runtime: Runtime, report: Report) {
  const declared = manifest.runState === true;
  const implemented = typeof runtime.beginRun === "function";
  if (declared && !implemented) {
    report(
      "run_state_missing",
      "runtime.beginRun",
      "The manifest declares runState, so the runtime needs beginRun to create it. Without one every use of this integration in a run is handed null.",
    );
  }
  if (!declared && implemented) {
    report(
      "run_state_undeclared",
      "runtime.beginRun",
      "The runtime has beginRun, which core calls only for a manifest that declares runState: true. Declare it, or delete the function.",
    );
  }
}

function checkRuntimeSlots(runtime: Runtime, report: Report) {
  for (const [slot, owner] of Object.entries(RESERVED_RUNTIME_SLOTS)) {
    if (runtime[slot] !== undefined) {
      report("reserved_slot_used", `runtime.${slot}`, `runtime.${slot} is reserved for ${owner}.`);
    }
  }
  const webhook = runtime.webhook;
  if (webhook !== undefined) {
    const receive = (webhook as { receive?: unknown } | null)?.receive;
    if (typeof receive !== "function") {
      report(
        "webhook_receive_missing",
        "runtime.webhook.receive",
        "The runtime declares a webhook with nothing to receive a request. Give it receive(request, ctx), or delete the slot: core answers 404 for an integration that declares none.",
      );
    }
  }
}

function namesCredential(key: string, env: string): boolean {
  const fromKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return [fromKey, env.toUpperCase()].some((name) => {
    const words = name.split(/[^A-Z0-9]+/).filter(Boolean);
    return words.some(
      (word, index) =>
        CREDENTIAL_WORDS.has(word) ||
        (index > 0 && CREDENTIAL_PAIRS.has(`${words[index - 1]}_${word}`)),
    );
  });
}


// zod schemas are walked through their definitions, which differ between the
// two major versions: zod 3 keeps `_def` with `typeName` and a `shape()`
// function on objects; zod 4 keeps `_zod.def` with `type` and a `shape` object.

type ZodLike = { safeParse: unknown; _def?: unknown; _zod?: { def?: unknown } };

function isZodSchema(value: unknown): value is ZodLike {
  return (
    isRecord(value) &&
    typeof value.safeParse === "function" &&
    (isRecord(value._def) || isRecord((value._zod as { def?: unknown } | undefined)?.def))
  );
}

function definitionOf(schema: ZodLike): Record<string, unknown> {
  const def = schema._zod?.def ?? schema._def;
  return isRecord(def) ? def : {};
}

function oneArgumentRecords(schema: unknown, path: string, seen: Set<unknown>): string[] {
  if (!isZodSchema(schema) || seen.has(schema)) return [];
  seen.add(schema);
  const def = definitionOf(schema);
  const found: string[] = [];
  const isRecordSchema = def.typeName === "ZodRecord" || def.type === "record";
  if (isRecordSchema && !isZodSchema(def.valueType)) found.push(path);
  const shape = typeof def.shape === "function" ? (def.shape as () => unknown)() : def.shape;
  if (isRecord(shape)) {
    for (const [key, child] of Object.entries(shape)) {
      found.push(...oneArgumentRecords(child, `${path}.${key}`, seen));
    }
  }
  for (const [key, value] of Object.entries(def)) {
    if (key === "shape") continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) found.push(...oneArgumentRecords(child, path, seen));
  }
  return found;
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
