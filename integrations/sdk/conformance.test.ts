/**
 * The conformance check S1 runs over every integration package. Each test
 * builds a manifest or runtime by hand that breaks one rule, and names the
 * rule; the expected codes come from the rule, never from running the check.
 * The whole file also runs under the zod the production bundle resolves
 * (`pnpm run test:zod4`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkIntegrationConformance,
  readProviderFailure,
  VCS_BOT_LOGIN_FIELD,
  ISSUE_TRACKER_BOARD_FIELDS,
  VCS_LEGACY_BOT_LOGIN_FIELD,
  z,
  type ConformanceCode,
} from "./index";
import { fixtureManifest, otelFixtureManifest } from "./fixture-manifest";
import { fixtureRuntime, otelFixtureRuntime } from "./fixture-runtime";

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

/**
 * The foil. It traces with no per-run handle, no package, no file and no hook,
 * which is what keeps `agent_tracing` implementable by something that is not
 * the provider it was designed from.
 */
test("a tracing provider that needs nothing but an endpoint conforms too", () => {
  assert.deepEqual(issues(otelFixtureManifest, otelFixtureRuntime), []);
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
  // `custom` and `resend` are routes under /webhooks today, and
  // `capabilities` is the static route beside /api/v1/integrations/:id;
  // `vcs` and `memory` are capability ids; `health` and `settings` are core
  // screens and words the core-reference gate would find everywhere.
  for (const id of ["custom", "resend", "capabilities", "vcs", "memory", "health", "settings"]) {
    const { manifest, runtime } = validIntegration();
    manifest.id = id;
    manifest.blocks[0].type = `${id}_lookup`;
    runtime.blocks = { [`${id}_lookup`]: runtime.blocks.acme_lookup };
    hasIssue(manifest, runtime, "id_reserved", "id");
  }
});

test("an id a core health section still holds is refused until that section moves out", () => {
  // The health page keeps one section per id, and an integration's checks are
  // keyed under its id: two sections called `database` could disagree about the
  // same deployment. Each of these rows leaves this list in the stage that
  // moves the provider out of core, which is why `slack`, `github` and now
  // `jira` are not among them any more: S9, S11 and S12 each deleted core's
  // section and the package took the name.
  for (const id of ["database", "email"]) {
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
  for (const type of ["lookup", "other_lookup", "acme_Lookup", "acme_", "acmelookup", "acme__lookup"]) {
    const { manifest, runtime } = validIntegration();
    manifest.blocks[0].type = type;
    runtime.blocks = { [type]: runtime.blocks.acme_lookup };
    hasIssue(manifest, runtime, "block_type_invalid", "blocks[0].type");
  }
});

test("a block type storage accepts is not refused here", () => {
  // A stored definition may carry `acme_2fa_check` (isStorableWorkflowBlockType)
  // and the registry generator registers it, so conformance refusing it would
  // be a third rule for the same string, and the strictest one would win in CI.
  for (const type of ["acme_2fa_check", "acme_lookup_v2"]) {
    const { manifest, runtime } = validIntegration();
    manifest.blocks[0].type = type;
    runtime.blocks = { [type]: runtime.blocks.acme_lookup };
    assert.deepEqual(codes(manifest, runtime), [], type);
  }
});

test("a block with a second output port is refused, naming the stage that lifts it", () => {
  // The workflow graph reads a block's ports from core's generated catalog,
  // which holds no integration block, so it resolves every one of them to a
  // single port named "out". A second port would be offered in the editor,
  // refused at publish as an unknown port, and would propagate to nothing at
  // run time: a dead branch inside a green run.
  // An empty list is already refused by the manifest schema, which requires one.
  for (const ports of [["out", "empty"], ["result"]]) {
    const { manifest, runtime } = validIntegration();
    manifest.blocks[0].contract.ports = ports;
    hasIssue(manifest, runtime, "block_ports_unsupported", "blocks[0].contract.ports");
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
    headers: z.record(z.string()).optional(),
  });
  if (zodMajor === 4) {
    hasIssue(manifest, runtime, "block_params_schema_one_argument_record", "blocks[0].paramsSchema.headers");
  } else {
    assert.deepEqual(codes(manifest, runtime), []);
  }
});

test("a record keyed by an enum is refused under either zod, because the two disagree on it", () => {
  // zod 3 reads z.record(z.enum([...]), v) as a partial record and zod 4 as an
  // exhaustive one, so `{}` parses in the tests and fails in production. The
  // check has to fire in both runs: the zod 3 run is the one a developer sees.
  const { manifest, runtime } = validIntegration();
  manifest.blocks[0].paramsSchema = z.object({
    limits: z.record(z.enum(["daily", "weekly"]), z.number()).optional(),
  });
  hasIssue(manifest, runtime, "block_params_schema_enum_record", "blocks[0].paramsSchema.limits");
});

test("a block's defaults parse against its own params schema", () => {
  // A new node starts with its defaults and the editor has no form for an
  // integration block's parameters, so defaults the schema refuses make a
  // block nobody can save.
  const { manifest, runtime } = validIntegration();
  manifest.blocks[0].paramsSchema = z.object({ limit: z.number().int().max(50) });
  manifest.blocks[0].defaults = { limit: 500 };
  hasIssue(manifest, runtime, "block_defaults_invalid", "blocks[0].defaults");

  const absent = validIntegration();
  absent.manifest.blocks[0].paramsSchema = z.object({ channel: z.string() });
  hasIssue(absent.manifest, absent.runtime, "block_defaults_invalid", "blocks[0].defaults");
});

test("repositories belongs to a vcs integration and names a bare lowercase host", () => {
  const without = validIntegration();
  without.manifest.repositories = { nestedPaths: true };
  hasIssue(without.manifest, without.runtime, "repositories_invalid", "repositories");

  for (const host of ["https://git.acme.test", "Git.Acme.test", "git.acme.test/"]) {
    const { manifest, runtime } = validIntegration();
    manifest.capabilities = ["messaging", "vcs"];
    runtime.capabilities.vcs = () => ({});
    manifest.repositories = { host };
    hasIssue(manifest, runtime, "repositories_invalid", "repositories.host");
  }

  const valid = validVcsIntegration();
  valid.manifest.repositories = { host: "git.acme.test:8443", nestedPaths: true };
  assert.deepEqual(codes(valid.manifest, valid.runtime), []);
});

/** A vcs integration with everything the capability asks of a manifest. */
function validVcsIntegration(): { manifest: Loose; runtime: Loose } {
  const integration = validIntegration();
  integration.manifest.capabilities = ["messaging", "vcs"];
  integration.runtime.capabilities.vcs = () => ({});
  integration.manifest.connection.fields.push({
    key: VCS_BOT_LOGIN_FIELD,
    label: "Bot username",
    env: "ACME_BOT_LOGIN",
    secret: false,
    optional: true,
  });
  return integration;
}

test("a vcs integration declares where its automation account's login is set", () => {
  const without = validVcsIntegration();
  without.manifest.connection.fields = without.manifest.connection.fields.filter(
    (field: { key: string }) => field.key !== VCS_BOT_LOGIN_FIELD,
  );
  hasIssue(without.manifest, without.runtime, "vcs_bot_login_missing", "connection.fields");

  const secret = validVcsIntegration();
  secret.manifest.connection.fields.at(-1).secret = true;
  hasIssue(secret.manifest, secret.runtime, "vcs_bot_login_missing", "connection.fields[3].secret");

  // The legacy single-provider login is the one field allowed on a variable
  // core reserves, and only with its own key on a vcs integration.
  const legacy = validVcsIntegration();
  legacy.manifest.connection.fields.push({
    ...VCS_LEGACY_BOT_LOGIN_FIELD,
    label: "Legacy bot username",
    secret: false,
    optional: true,
  });
  assert.deepEqual(codes(legacy.manifest, legacy.runtime), []);

  const legacyElsewhere = validIntegration();
  legacyElsewhere.manifest.connection.fields.push({
    ...VCS_LEGACY_BOT_LOGIN_FIELD,
    label: "Legacy bot username",
    secret: false,
    optional: true,
  });
  hasIssue(
    legacyElsewhere.manifest,
    legacyElsewhere.runtime,
    "connection_env_reserved",
    "connection.fields[3].env",
  );

  // Nothing is asked of an integration that serves no version control.
  assert.deepEqual(codes(validIntegration().manifest, validIntegration().runtime), []);
});

test("a connection needs one required field, or says it needs nothing", () => {
  // Core treats a connection whose every field is optional as complete from
  // the start: without this, such an integration reads Connected on every
  // deployment, and a memory provider would replace the built-in store there.
  const allOptional = validIntegration();
  for (const field of allOptional.manifest.connection.fields) (field as { optional?: boolean }).optional = true;
  hasIssue(allOptional.manifest, allOptional.runtime, "connection_required_field_missing", "connection.fields");

  // A default fills the field, and a value required only when stored is not
  // asked of the environment, so neither makes the connection need anything.
  const filled = validIntegration();
  for (const field of filled.manifest.connection.fields as Array<Record<string, unknown>>) {
    if (field.secret === true) {
      field.optional = true;
      field.requiredWhenStored = true;
    } else {
      field.default = "https://example.com";
      delete field.format;
    }
  }
  hasIssue(filled.manifest, filled.runtime, "connection_required_field_missing", "connection.fields");

  const none = validIntegration();
  (none.manifest.connection as { fields: unknown[] }).fields = [];
  hasIssue(none.manifest, none.runtime, "connection_required_field_missing", "connection.fields");

  // Said out loud, it conforms.
  const declared = validIntegration();
  (declared.manifest.connection as { fields: unknown[]; connectionless?: true }).fields = [];
  (declared.manifest.connection as { connectionless?: true }).connectionless = true;
  assert.ok(!codes(declared.manifest, declared.runtime).some((code) => code.startsWith("connection_")));

  // And it cannot be said beside a field the integration cannot work without.
  const contradiction = validIntegration();
  (contradiction.manifest.connection as { connectionless?: true }).connectionless = true;
  hasIssue(
    contradiction.manifest,
    contradiction.runtime,
    "connection_connectionless_has_required",
    "connection.connectionless",
  );
});

test("identity marks a secret, and only a boolean", () => {
  const plain = validIntegration();
  plain.manifest.connection.fields[0].identity = true;
  hasIssue(plain.manifest, plain.runtime, "connection_identity_not_secret", "connection.fields[0].identity");

  const typo = validIntegration();
  typo.manifest.connection.fields[1].identity = "yes";
  hasIssue(typo.manifest, typo.runtime, "manifest_invalid", "connection.fields[1].identity");

  const valid = validIntegration();
  valid.manifest.connection.fields[1].identity = true;
  assert.deepEqual(codes(valid.manifest, valid.runtime), []);
});

test("a two-argument z.record nested anywhere passes", () => {
  const { manifest, runtime } = validIntegration();
  manifest.blocks[0].paramsSchema = z.object({
    nested: z.array(z.object({ labels: z.record(z.string(), z.string()).optional() })).optional(),
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
  reserved.manifest.capabilities = ["messaging", "agent_tools"];
  reserved.runtime.capabilities.agent_tools = () => ({});
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

test("a page's legacy path is one lowercase segment, declared once", () => {
  // The dashboard turns each into a permanent redirect ahead of its own
  // routes, so a path with a second segment, a query or a capital letter is
  // one nobody's bookmark holds, and a path declared twice is a redirect that
  // cannot say where it goes.
  const valid = validIntegration();
  valid.manifest.pages[0].legacyPaths = ["/overview-old"];
  assert.deepEqual(issues(valid.manifest, valid.runtime), []);

  for (const path of ["overview", "/Overview", "/a/b", "/a?x=1", "/", "/-a"]) {
    const { manifest, runtime } = validIntegration();
    manifest.pages[0].legacyPaths = [path];
    hasIssue(manifest, runtime, "page_legacy_path_invalid", "pages[0].legacyPaths[0]");
  }
  const twice = validIntegration();
  twice.manifest.pages[0].legacyPaths = ["/old"];
  twice.manifest.pages.push({ id: "second", label: "Second", legacyPaths: ["/old"] });
  twice.runtime.api = {};
  hasIssue(twice.manifest, twice.runtime, "duplicate", "pages[1].legacyPaths[0]");
});

test("a webhook slot with nothing to receive a request is refused", () => {
  // The slot was reserved until S9 designed it. Declaring it now means core
  // routes `/webhooks/<id>` here, so a slot that cannot receive anything is an
  // integration whose provider gets a 500 rather than an answer.
  const { manifest, runtime } = validIntegration();
  runtime.webhook = { deliver: async () => {} };
  hasIssue(manifest, runtime, "webhook_receive_missing", "runtime.webhook.receive");
});

test("a page reader belongs to a page the manifest declares", () => {
  const { manifest, runtime } = validIntegration();
  runtime.api = { nowhere: async () => ({}) };
  hasIssue(manifest, runtime, "page_reader_undeclared", "runtime.api.nowhere");
});

test("run state is declared and served together", () => {
  const declaredOnly = validIntegration();
  declaredOnly.manifest.runState = true;
  hasIssue(declaredOnly.manifest, declaredOnly.runtime, "run_state_missing", "runtime.beginRun");

  const servedOnly = validIntegration();
  servedOnly.runtime.beginRun = async () => ({ taskId: "t1" });
  hasIssue(servedOnly.manifest, servedOnly.runtime, "run_state_undeclared", "runtime.beginRun");
});

test("a tracker says how it reads an authored query, and only a tracker does", () => {
  const tracker = validIntegration();
  tracker.manifest.capabilities = ["messaging", "issue_tracker"];
  tracker.runtime.capabilities = { ...tracker.runtime.capabilities, issue_tracker: () => ({}) };
  hasIssue(tracker.manifest, tracker.runtime, "issue_tracker_query_rule_missing", "runtime.issueTrackerQueryRule");
  tracker.runtime.issueTrackerQueryRule = { problem: () => null };
  assert.ok(!codes(tracker.manifest, tracker.runtime).includes("issue_tracker_query_rule_missing"));

  const notATracker = validIntegration();
  notATracker.runtime.issueTrackerQueryRule = { problem: () => null };
  hasIssue(notATracker.manifest, notATracker.runtime, "issue_tracker_query_rule_undeclared", "runtime.issueTrackerQueryRule");
});

test("a tracker declares its board fields under the keys core reads", () => {
  // Core reads the project and the transition ids by these keys, never by a
  // tracker's own names; a tracker that spelled them its own way would work
  // its board with no project check and every move by bare name.
  const asTracker = () => {
    const tracker = validIntegration();
    tracker.manifest.capabilities = ["messaging", "issue_tracker"];
    tracker.runtime.capabilities = { ...tracker.runtime.capabilities, issue_tracker: () => ({}) };
    tracker.runtime.issueTrackerQueryRule = { problem: () => null };
    return tracker;
  };
  const project = { key: ISSUE_TRACKER_BOARD_FIELDS.projectKey, label: "Project", env: "ACME_PROJECT", secret: false };

  const missing = asTracker();
  hasIssue(missing.manifest, missing.runtime, "issue_tracker_board_field_invalid", "connection.fields");

  const declared = asTracker();
  (declared.manifest.connection.fields as unknown[]).push(project, {
    key: ISSUE_TRACKER_BOARD_FIELDS.aiTransitionId,
    label: "AI transition",
    env: "ACME_AI_TRANSITION",
    secret: false,
    optional: true,
  });
  assert.ok(!codes(declared.manifest, declared.runtime).includes("issue_tracker_board_field_invalid"));

  // A transition id core must be able to do without cannot be required.
  const required = asTracker();
  (required.manifest.connection.fields as unknown[]).push(project, {
    key: ISSUE_TRACKER_BOARD_FIELDS.backlogTransitionId,
    label: "Backlog transition",
    env: "ACME_BACKLOG_TRANSITION",
    secret: false,
  });
  const index = required.manifest.connection.fields.length - 1;
  hasIssue(required.manifest, required.runtime, "issue_tracker_board_field_invalid", `connection.fields[${index}]`);
});

test("a field a graph must read is one the block's output declares", () => {
  const fine = validIntegration();
  fine.manifest.blocks[0].output.mustRead = ["status", "count"];
  assert.deepEqual(issues(fine.manifest, fine.runtime), []);

  const unknown = validIntegration();
  unknown.manifest.blocks[0].output.mustRead = ["verdict"];
  hasIssue(unknown.manifest, unknown.runtime, "block_must_read_undeclared", "blocks[0].output.mustRead[0]");
});

test("an input default names ticket fields, and only a text input has one", () => {
  const fine = validIntegration();
  fine.manifest.blocks[0].inputs = {
    content: { required: true, schema: { type: "string" }, defaultFromSubject: ["description", "comments"] },
  };
  assert.deepEqual(issues(fine.manifest, fine.runtime), []);

  const unknownField = validIntegration();
  unknownField.manifest.blocks[0].inputs = {
    content: { required: true, schema: { type: "string" }, defaultFromSubject: ["assignee"] },
  };
  hasIssue(
    unknownField.manifest,
    unknownField.runtime,
    "block_input_default_invalid",
    "blocks[0].inputs.content.defaultFromSubject",
  );

  const notText = validIntegration();
  notText.manifest.blocks[0].inputs = {
    limit: { required: true, schema: { type: "number" }, defaultFromSubject: ["description"] },
  };
  hasIssue(notText.manifest, notText.runtime, "block_input_default_invalid", "blocks[0].inputs.limit.defaultFromSubject");
});

test("every issue says in words what is wrong", () => {
  const { manifest, runtime } = validIntegration();
  runtime.blocks = {};
  const [issue] = issues(manifest, runtime);
  assert.ok(issue);
  assert.match(issue.message, /acme_lookup/);
});

/**
 * The fixture is the example an author copies, and its handles make the trip
 * every handle makes: minted in a provider answer, stored as JSON in an
 * envelope, compared later with one parsed from a fresh answer.
 */
function fixtureRepository(answer: () => Response): Loose {
  const ctx = {
    connection: { baseUrl: "https://fixture.example", apiToken: "token", appId: 1 },
    http: { fetch: async () => answer() },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: new AbortController().signal,
  };
  return (fixtureRuntime as Loose).capabilities.vcs(ctx, { repoPath: "acme/app", baseBranch: "main" });
}

test("the fixture's handles compare equal after a JSON round trip", async () => {
  const head = {
    headSha: "abc",
    baseRef: "main",
    state: "open",
    checks: { state: "red", failed: [{ name: "build", conclusion: "failure", handle: { run: 7, job: 3 } }] },
  };
  const repository = fixtureRepository(() => Response.json(head));
  const { sameHandle } = (fixtureRuntime as Loose).vcsHandles;

  const handle = (await repository.getPRHead(1)).checks.failed[0].handle;
  const stored = JSON.parse(JSON.stringify(handle));

  assert.equal(sameHandle(handle, structuredClone(handle)), true);
  assert.equal(sameHandle(stored, (await repository.getPRHead(1)).checks.failed[0].handle), true);
  assert.equal(sameHandle(handle, { run: 7, job: 4 }), false);
  assert.equal(sameHandle(handle, undefined), false);
});

test("the fixture closes only a pull request it cannot read, never a refused credential", async () => {
  const refusedWith = async (status: number, headers: Record<string, string> = {}) =>
    fixtureRepository(() => new Response("{}", { status, headers }))
      .getPRHead(1)
      .catch((error: Error) => error);

  assert.equal((await refusedWith(404)).name, "PullRequestUnreadableError");
  assert.equal((await refusedWith(403)).name, "PullRequestUnreadableError");
  // A token without the scope refuses every pull request alike: the
  // connection is at fault, and the delivery waits for it to be repaired.
  const scope = { "www-authenticate": 'Bearer realm="fixture", error="insufficient_scope"' };
  assert.notEqual((await refusedWith(403, scope)).name, "PullRequestUnreadableError");
  assert.notEqual((await refusedWith(403, { "retry-after": "30" })).name, "PullRequestUnreadableError");
  assert.notEqual((await refusedWith(401)).name, "PullRequestUnreadableError");
  assert.notEqual((await refusedWith(502)).name, "PullRequestUnreadableError");
});

/** The valid integration with one operator setting and a webhook that reads only its token. */
function withSettingAndWebhook() {
  const { manifest, runtime } = validIntegration();
  manifest.settings = [
    {
      key: "allowedUserIds",
      description: "Who may run a command.",
      type: "string-list",
      default: [],
      env: "ACME_ALLOWED_USER_IDS",
    },
  ];
  manifest.webhook = { requires: ["apiToken"], label: "/acme command" };
  runtime.webhook = { receive: async () => ({ kind: "refused", status: 401, reason: "unsigned" }) };
  return { manifest, runtime };
}

test("an operator setting and a webhook that reads part of the connection conform", () => {
  const { manifest, runtime } = withSettingAndWebhook();
  assert.deepEqual(issues(manifest, runtime), []);
});

test("a setting key that could not spell back its stored key is refused", () => {
  for (const key of ["AllowedUsers", "allowed_users", "allowed-users", ""]) {
    const { manifest, runtime } = withSettingAndWebhook();
    manifest.settings[0].key = key;
    hasIssue(manifest, runtime, "setting_invalid", "settings[0].key");
  }
});

test("a setting declared twice is refused", () => {
  const { manifest, runtime } = withSettingAndWebhook();
  manifest.settings.push({ ...manifest.settings[0], env: undefined });
  hasIssue(manifest, runtime, "duplicate", "settings[1].key");
});

test("two settings that would be stored under one key are refused", () => {
  // `allowedIDs` and `allowedIds` are different keys in the manifest and the
  // same row, ACME_ALLOWED_IDS, in the settings store.
  const { manifest, runtime } = withSettingAndWebhook();
  manifest.settings = [
    { key: "allowedIDs", description: "One.", type: "string-list", default: [] },
    { key: "allowedIds", description: "Two.", type: "string-list", default: [] },
  ];
  hasIssue(manifest, runtime, "duplicate", "settings[1].key");
});

test("a setting stored under one of core's own keys is refused", () => {
  // `mcp` + `enabled` is `MCP_ENABLED`, core's switch for the whole transport.
  // The id is reserved as well; the setting rule stands on its own.
  const { manifest, runtime } = withSettingAndWebhook();
  manifest.id = "mcp";
  manifest.settings[0].key = "enabled";
  hasIssue(manifest, runtime, "setting_invalid", "settings[0].key");
});

test("a setting's variable may be neither core's, nor badly named, nor a connection field's", () => {
  for (const env of ["DATABASE_URL", "acme_allowed", "ACME_API_TOKEN"]) {
    const { manifest, runtime } = withSettingAndWebhook();
    manifest.settings[0].env = env;
    hasIssue(manifest, runtime, "setting_invalid", "settings[0].env");
  }
});

test("webhook.requires names fields this connection has, and something to serve", () => {
  const unknown = withSettingAndWebhook();
  unknown.manifest.webhook.requires = ["signingSecret"];
  hasIssue(unknown.manifest, unknown.runtime, "webhook_requires_invalid", "webhook.requires[0]");

  const empty = withSettingAndWebhook();
  empty.manifest.webhook.requires = [];
  hasIssue(empty.manifest, empty.runtime, "webhook_requires_invalid", "webhook.requires");

  const noWebhook = withSettingAndWebhook();
  delete noWebhook.runtime.webhook;
  hasIssue(noWebhook.manifest, noWebhook.runtime, "webhook_requires_invalid", "webhook.requires");

  // The card names what is answered on part of the connection, so it has to
  // have a name.
  const unnamed = withSettingAndWebhook();
  delete (unnamed.manifest.webhook as { label?: string }).label;
  hasIssue(unnamed.manifest, unnamed.runtime, "webhook_requires_invalid", "webhook.label");
});

test("the fixture hands a refused token to core as the provider's answer, not as fatal", async () => {
  // Authors copy this fixture. A FatalError on every 401 stopped the retries
  // of whichever core step called the adapter, whatever that step would have
  // decided about a refused credential; the answer itself lets core decide.
  const failure = await fixtureRepository(() => new Response("{}", { status: 401 }))
    .getPRHead(1)
    .catch((error: Error) => error);

  assert.notEqual(failure.name, "FatalError");
  const verdict = readProviderFailure(failure);
  assert.equal(verdict.kind, "refused");
  assert.equal(verdict.kind === "refused" ? verdict.status : null, 401);
});
