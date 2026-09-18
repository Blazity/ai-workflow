/**
 * The conformance check S1 runs over every integration package. Each test
 * builds a manifest or runtime by hand that breaks one rule, and names the
 * rule; the expected codes come from the rule, never from running the check.
 * The whole file also runs under the zod the production bundle resolves
 * (`pnpm run test:zod4`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkIntegrationConformance, z, type ConformanceCode } from "./index";
import { fixtureManifest } from "./fixture-manifest";
import { fixtureRuntime } from "./fixture-runtime";

// Hand-built integrations are deliberately untyped: conformance exists for
// packages the compiler did not hold to the contract.
type Loose = Record<string, any>;

function validIntegration(): { manifest: Loose; runtime: Loose } {
  const manifest = {
    id: "acme",
    name: "Acme",
    description: "Tickets and chat at Acme.",
    connection: {
      fields: [
        { key: "baseUrl", label: "Site URL", env: "ACME_BASE_URL", secret: false, format: "url" },
        { key: "apiToken", label: "API token", env: "ACME_API_TOKEN", secret: true },
        {
          key: "host",
          label: "Host",
          env: "ACME_HOST",
          secret: false,
          optional: true,
          default: "https://acme.example",
          format: "url",
        },
      ],
    },
    capabilities: ["messaging"],
    blocks: [
      {
        type: "acme_lookup",
        paramsSchema: z.object({ limit: z.number().int().default(5) }),
        contract: { ports: ["out"], allowsFailurePort: true },
        ui: {
          label: "Acme lookup",
          description: "Looks something up at Acme.",
          glyph: "A",
          color: "#223344",
          softColor: "#EEF0F2",
        },
        output: { properties: { count: { type: "number" } }, statusVariants: ["ok"] },
      },
    ],
    pages: [{ id: "overview", label: "Overview" }],
    health: [{ id: "auth", label: "Token accepted", description: "Acme accepts the token.", critical: true }],
  };
  const runtime = {
    testConnection: async () => ({ ok: true }),
    capabilities: { messaging: () => ({ notifyForTicket: async () => {} }) },
    blocks: { acme_lookup: async () => ({ kind: "next", output: { status: "ok", count: 0 } }) },
    health: { auth: async () => ({ status: "live" }) },
  };
  return { manifest, runtime };
}

function issues(manifest: unknown, runtime: unknown) {
  return checkIntegrationConformance(manifest, runtime);
}

function codes(manifest: unknown, runtime: unknown): ConformanceCode[] {
  return issues(manifest, runtime).map((issue) => issue.code);
}

function hasIssue(manifest: unknown, runtime: unknown, code: ConformanceCode, path: string) {
  const found = issues(manifest, runtime);
  assert.ok(
    found.some((issue) => issue.code === code && issue.path === path),
    `expected ${code} at ${path}, got ${JSON.stringify(found)}`,
  );
}

const zodMajor = "_zod" in z.string() ? 4 : 3;

test("a conforming integration yields no issues", () => {
  const { manifest, runtime } = validIntegration();
  assert.deepEqual(issues(manifest, runtime), []);
});

test("the fixture integration of this package conforms", () => {
  assert.deepEqual(issues(fixtureManifest, fixtureRuntime), []);
});

test("a manifest that is not an object, or misses a required field, does not parse", () => {
  const { manifest, runtime } = validIntegration();
  assert.deepEqual(codes(null, runtime), ["manifest_invalid"]);
  delete manifest.name;
  hasIssue(manifest, runtime, "manifest_invalid", "name");
});

test("an id outside lowercase letters and digits, or shorter than three, is refused", () => {
  for (const id of ["Acme", "acme-tools", "acme_tools", "ac", "1acme"]) {
    const { manifest, runtime } = validIntegration();
    manifest.id = id;
    hasIssue(manifest, runtime, "id_invalid", "id");
  }
});

test("an id core already uses is refused: webhook routes, capabilities, core words", () => {
  // `custom` and `resend` are routes under /webhooks today; `vcs` and `memory`
  // are capability ids; `health` and `settings` are core screens and words the
  // core-reference gate would find everywhere.
  for (const id of ["custom", "resend", "vcs", "memory", "health", "settings"]) {
    const { manifest, runtime } = validIntegration();
    manifest.id = id;
    manifest.blocks[0].type = `${id}_lookup`;
    runtime.blocks = { [`${id}_lookup`]: runtime.blocks.acme_lookup };
    hasIssue(manifest, runtime, "id_reserved", "id");
  }
});

test("an id a core health section still holds is refused until that section moves out", () => {
  // The health page keeps one section per id, and an integration's checks are
  // keyed under its id: two sections called `github` could disagree about the
  // same deployment. Each of these rows leaves this list in the stage that
  // moves the provider out of core.
  for (const id of ["github", "jira", "slack", "database"]) {
    const { manifest, runtime } = validIntegration();
    manifest.id = id;
    manifest.blocks[0].type = `${id}_lookup`;
    runtime.blocks = { [`${id}_lookup`]: runtime.blocks.acme_lookup };
    hasIssue(manifest, runtime, "id_reserved", "id");
  }
});

test("a health check may not be called connection, which core adds itself", () => {
  const { manifest, runtime } = validIntegration();
  manifest.health = [
    { id: "connection", label: "Connected", description: "Acme answers.", critical: true },
  ];
  runtime.health = { connection: async () => ({ status: "live" }) };
  hasIssue(manifest, runtime, "id_reserved", "health[0].id");
});

test("a block type is the integration id, an underscore and a snake_case name", () => {
  for (const type of ["lookup", "other_lookup", "acme_Lookup", "acme_", "acmelookup"]) {
    const { manifest, runtime } = validIntegration();
    manifest.blocks[0].type = type;
    runtime.blocks = { [type]: runtime.blocks.acme_lookup };
    hasIssue(manifest, runtime, "block_type_invalid", "blocks[0].type");
  }
});

test("two blocks with one type are refused", () => {
  const { manifest, runtime } = validIntegration();
  manifest.blocks.push({ ...manifest.blocks[0] });
  hasIssue(manifest, runtime, "duplicate", "blocks[1].type");
});

test("a block without a zod params schema is refused", () => {
  for (const paramsSchema of [undefined, { type: "object", properties: {} }]) {
    const { manifest, runtime } = validIntegration();
    manifest.blocks[0].paramsSchema = paramsSchema;
    hasIssue(manifest, runtime, "block_params_schema_missing", "blocks[0].paramsSchema");
  }
});

test("a one-argument z.record is refused under the zod production resolves", () => {
  const { manifest, runtime } = validIntegration();
  // One argument is valid zod 3 and a crash on first parse under zod 4, which
  // is what the production bundle loads. Only the zod 4 run can see it: under
  // zod 3 the one-argument form builds the same schema as the two-argument one.
  manifest.blocks[0].paramsSchema = z.object({
    headers: z.record(z.string()),
  });
  if (zodMajor === 4) {
    hasIssue(manifest, runtime, "block_params_schema_one_argument_record", "blocks[0].paramsSchema.headers");
  } else {
    assert.deepEqual(codes(manifest, runtime), []);
  }
});

test("a two-argument z.record nested anywhere passes", () => {
  const { manifest, runtime } = validIntegration();
  manifest.blocks[0].paramsSchema = z.object({
    nested: z.array(z.object({ labels: z.record(z.string(), z.string()).optional() })),
  });
  assert.deepEqual(codes(manifest, runtime), []);
});

test("a declared block without an executor is refused, and an executor needs a declared block", () => {
  const missing = validIntegration();
  missing.runtime.blocks = {};
  hasIssue(missing.manifest, missing.runtime, "block_executor_missing", "blocks[0]");

  const extra = validIntegration();
  extra.runtime.blocks.acme_other = extra.runtime.blocks.acme_lookup;
  hasIssue(extra.manifest, extra.runtime, "implementation_undeclared", "runtime.blocks.acme_other");
});

test("an integration without a connection test is refused", () => {
  const { manifest, runtime } = validIntegration();
  delete runtime.testConnection;
  hasIssue(manifest, runtime, "connection_test_missing", "runtime.testConnection");
});

test("an integration declares at least one health check, and each has a probe", () => {
  const none = validIntegration();
  none.manifest.health = [];
  none.runtime.health = {};
  hasIssue(none.manifest, none.runtime, "health_checks_missing", "health");

  const unprobed = validIntegration();
  unprobed.runtime.health = {};
  hasIssue(unprobed.manifest, unprobed.runtime, "health_probe_missing", "health[0]");

  const extra = validIntegration();
  extra.runtime.health.webhook = extra.runtime.health.auth;
  hasIssue(extra.manifest, extra.runtime, "implementation_undeclared", "runtime.health.webhook");
});

test("every connection field names one valid environment variable of its own", () => {
  const unset = validIntegration();
  delete unset.manifest.connection.fields[1].env;
  hasIssue(unset.manifest, unset.runtime, "manifest_invalid", "connection.fields[1].env");

  for (const env of ["", "acme_api_token", "ACME-API-TOKEN", "1ACME"]) {
    const { manifest, runtime } = validIntegration();
    manifest.connection.fields[1].env = env;
    hasIssue(manifest, runtime, "connection_env_invalid", "connection.fields[1].env");
  }
  const shared = validIntegration();
  shared.manifest.connection.fields[1].env = "ACME_BASE_URL";
  hasIssue(shared.manifest, shared.runtime, "duplicate", "connection.fields[1].env");

  const sameKey = validIntegration();
  sameKey.manifest.connection.fields[1].key = "baseUrl";
  hasIssue(sameKey.manifest, sameKey.runtime, "duplicate", "connection.fields[1].key");
});

test("an environment variable core itself reads is refused", () => {
  // A field on one of these would read Connected from core's own credentials,
  // and a name like DATABASE_URL carries no credential word, so the value
  // would not even be secret.
  for (const env of [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "CRON_SECRET",
    "ANTHROPIC_API_KEY",
    "WEBHOOK_TRIGGER_ENCRYPTION_KEY",
    "INTEGRATION_SECRETS_KEY",
    "LOG_LEVEL",
  ]) {
    const { manifest, runtime } = validIntegration();
    manifest.connection.fields[1] = { key: "borrowed", label: "Borrowed", env, secret: true };
    hasIssue(manifest, runtime, "connection_env_reserved", "connection.fields[1].env");
  }
  // A provider's own variable is not core's, even though core reads it today.
  const own = validIntegration();
  own.manifest.connection.fields[1] = {
    key: "apiToken", label: "Token", env: "JIRA_API_TOKEN", secret: true,
  };
  assert.deepEqual(codes(own.manifest, own.runtime), []);
});

test("a field that carries a credential must be marked secret", () => {
  const credentials: Array<[string, string]> = [
    ["apiToken", "ACME_API_TOKEN"],
    ["webhookSecret", "ACME_WEBHOOK_SECRET"],
    ["privateKey", "ACME_APP_PRIVATE_KEY"],
    ["apiKey", "ACME_API_KEY"],
    ["password", "ACME_PASSWORD"],
    ["credentials", "ACME_CREDENTIALS"],
    ["dsn", "ACME_DSN"],
    ["connectionString", "ACME_CONNECTION_STRING"],
  ];
  for (const [key, env] of credentials) {
    const { manifest, runtime } = validIntegration();
    manifest.connection.fields[1] = { key, label: key, env, secret: false };
    hasIssue(manifest, runtime, "connection_secret_unflagged", "connection.fields[1].secret");
  }
  // A field with no secret flag at all is a manifest that does not parse.
  const unstated = validIntegration();
  delete unstated.manifest.connection.fields[0].secret;
  hasIssue(unstated.manifest, unstated.runtime, "manifest_invalid", "connection.fields[0].secret");
});

test("a secret has no default, and a default satisfies its format", () => {
  const secretDefault = validIntegration();
  secretDefault.manifest.connection.fields[1].default = "changeme";
  hasIssue(secretDefault.manifest, secretDefault.runtime, "connection_secret_default", "connection.fields[1].default");

  const badUrl = validIntegration();
  badUrl.manifest.connection.fields[2].default = "acme.example";
  hasIssue(badUrl.manifest, badUrl.runtime, "connection_default_invalid", "connection.fields[2].default");

  const badInteger = validIntegration();
  badInteger.manifest.connection.fields[2] = {
    key: "appId", label: "App id", env: "ACME_APP_ID", secret: false, optional: true, default: "12a", format: "integer",
  };
  hasIssue(badInteger.manifest, badInteger.runtime, "connection_default_invalid", "connection.fields[2].default");
});

test("a capability is one core knows and has a port; reserved ones are refused until designed", () => {
  const reserved = validIntegration();
  reserved.manifest.capabilities = ["messaging", "memory"];
  reserved.runtime.capabilities.memory = () => ({});
  hasIssue(reserved.manifest, reserved.runtime, "capability_reserved", "capabilities[1]");

  const unknown = validIntegration();
  unknown.manifest.capabilities = ["crm"];
  unknown.runtime.capabilities = { crm: () => ({}) };
  hasIssue(unknown.manifest, unknown.runtime, "capability_unknown", "capabilities[0]");

  const required = validIntegration();
  required.manifest.blocks[0].requires = { capabilities: ["agent_tools"] };
  hasIssue(required.manifest, required.runtime, "capability_reserved", "blocks[0].requires.capabilities[0]");
});

test("a declared capability has an adapter, and an adapter needs a declared capability", () => {
  const missing = validIntegration();
  missing.runtime.capabilities = {};
  hasIssue(missing.manifest, missing.runtime, "capability_adapter_missing", "capabilities[0]");

  const extra = validIntegration();
  extra.runtime.capabilities.issue_tracker = () => ({});
  hasIssue(extra.manifest, extra.runtime, "implementation_undeclared", "runtime.capabilities.issue_tracker");
});

test("a page id is a lowercase slug and never the core connection tab", () => {
  for (const id of ["connection", "Overview", "over view"]) {
    const { manifest, runtime } = validIntegration();
    manifest.pages[0].id = id;
    hasIssue(manifest, runtime, "page_id_invalid", "pages[0].id");
  }
  const twice = validIntegration();
  twice.manifest.pages.push({ id: "overview", label: "Again" });
  hasIssue(twice.manifest, twice.runtime, "duplicate", "pages[1].id");
});

test("a reserved runtime slot cannot be filled before its stage designs it", () => {
  for (const slot of ["webhook", "api"]) {
    const { manifest, runtime } = validIntegration();
    runtime[slot] = async () => ({});
    hasIssue(manifest, runtime, "reserved_slot_used", `runtime.${slot}`);
  }
});

test("every issue says in words what is wrong", () => {
  const { manifest, runtime } = validIntegration();
  runtime.blocks = {};
  const [issue] = issues(manifest, runtime);
  assert.ok(issue);
  assert.match(issue.message, /acme_lookup/);
});
