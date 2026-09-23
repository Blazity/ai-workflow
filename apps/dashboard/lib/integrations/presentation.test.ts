// The sentences an admin reads about an integration, and the request a save
// sends. Written from docs/qa/integrations-scenarios.md (J1, J2, J4, J5, J7),
// never from the component that renders them.
import assert from "node:assert/strict";
import test from "node:test";

import type {
  IntegrationConnectionFieldDto,
  IntegrationDto,
  IntegrationState,
} from "@shared/contracts";

import {
  blockAvailabilityOf,
  buildSaveRequest,
  conflictDifferenceLines,
  disableConsequence,
  enableConsequence,
  integrationImpactLines,
  disconnectConsequence,
  fieldHint,
  missingRequiredFields,
  readableProviderText,
  sourceSwitchRefusal,
  statusChip,
  statusDetailLines,
  testOutcomeLines,
  testRefusal,
  unlocksLines,
  verificationLine,
} from "./presentation";

const URL_FIELD: IntegrationConnectionFieldDto = {
  key: "baseUrl",
  label: "Site URL",
  env: "DEMO_BASE_URL",
  secret: false,
  optional: false,
  format: "url",
  envSet: false,
  storedSecretSet: false,
};

const TOKEN_FIELD: IntegrationConnectionFieldDto = {
  key: "apiToken",
  label: "API token",
  env: "DEMO_API_TOKEN",
  secret: true,
  optional: false,
  format: "text",
  envSet: false,
  storedSecretSet: false,
};

function state(overrides: Partial<IntegrationState> = {}): IntegrationState {
  return {
    integrationId: "demo",
    enabled: true,
    source: "stored",
    status: "connected",
    connection: "connected",
    verification: { state: "never_tested" },
    failure: null,
    usable: true,
    environment: { setVariables: [], missingVariables: [], complete: false },
    stored: {
      latestVersion: 3,
      activeVersion: 3,
      missingFields: [],
      complete: true,
      prepared: null,
    },
    pin: { integrationId: "demo", configFingerprint: "abc123abc123" },
    secretsKeyAvailable: true,
    ...overrides,
  };
}

function integration(overrides: Partial<IntegrationDto> = {}): IntegrationDto {
  return {
    id: "demo",
    name: "Demo",
    description: "A deterministic provider.",
    capabilities: ["messaging"],
    blocks: [{ type: "demo_echo", label: "Demo echo" }],
    pages: [{ id: "overview", label: "Overview" }],
    fields: [URL_FIELD, { ...TOKEN_FIELD, storedSecretSet: true }],
    state: state(),
    ...overrides,
  };
}

test("an integration a human switched off says Disabled, not Connected", () => {
  // The resolver reports `connection: "connected"` with `status: "disabled"`,
  // because the credentials are fine and somebody reached for the kill switch.
  // Reading `connection` here would tell an operator everything is running.
  const chip = statusChip(state({ enabled: false, status: "disabled", usable: false }));
  assert.equal(chip.label, "Disabled");
  assert.equal(chip.tone, "off");
});

test("values nobody ever tested are not reported as tested, and carry no time", () => {
  const line = verificationLine({ state: "never_tested" });
  assert.match(line, /Nothing has ever tested/);
  assert.doesNotMatch(line, /\d{4}/, "a never-tested connection has no date to show");
});

test("a verdict from before the values changed says it proves nothing about them", () => {
  const line = verificationLine({ state: "stale", at: "2026-09-18T10:00:00.000Z" });
  assert.match(line, /says nothing about what is in use now/);
});

test("a partial environment names the variables that are not set", () => {
  const lines = statusDetailLines(
    integration({
      state: state({
        source: "environment",
        status: "failing",
        connection: "failing",
        usable: false,
        environment: {
          setVariables: ["DEMO_BASE_URL"],
          missingVariables: ["DEMO_API_TOKEN"],
          complete: false,
        },
        stored: {
          latestVersion: 0,
          activeVersion: null,
          missingFields: [],
          complete: false,
          prepared: null,
        },
        failure: {
          reason: "environment_incomplete",
          message: "Some of the variables this integration needs are not set",
          missingVariables: ["DEMO_API_TOKEN"],
        },
      }),
    }),
  );
  assert.match(lines.join(" "), /DEMO_API_TOKEN/);
});

test("a fresh deployment is told what the integration needs, not that its values came from somewhere", () => {
  const lines = statusDetailLines(
    integration({
      // Nothing was ever saved, so no field carries a stored value either.
      fields: [URL_FIELD, TOKEN_FIELD],
      state: state({
        source: "environment",
        status: "not_connected",
        connection: "not_connected",
        usable: false,
        stored: {
          latestVersion: 0,
          activeVersion: null,
          missingFields: [],
          complete: false,
          prepared: null,
        },
      }),
    }),
  );
  const rendered = lines.join(" ");
  assert.match(rendered, /Nothing configures it on this deployment yet/);
  assert.match(rendered, /It needs its Site URL and API token\./);
  assert.doesNotMatch(
    rendered,
    /Values come from/,
    "naming a source for a connection that has none would be a lie",
  );
});

/** Slack on a deployment that set `SLACK_SIGNING_SECRET` and nothing else. */
function commandOnlySlack(overrides: Partial<IntegrationDto> = {}): IntegrationDto {
  return integration({
    id: "slack",
    name: "Slack",
    capabilities: ["messaging"],
    fields: [
      { ...TOKEN_FIELD, key: "botToken", label: "Bot token", env: "CHAT_SDK_SLACK_TOKEN" },
      { ...URL_FIELD, key: "channelId", label: "Channel id", env: "CHAT_SDK_CHANNEL_ID", format: "text" },
      {
        ...TOKEN_FIELD,
        key: "signingSecret",
        label: "Signing secret",
        env: "SLACK_SIGNING_SECRET",
        optional: true,
        envSet: true,
      },
    ],
    state: state({
      integrationId: "slack",
      source: "environment",
      status: "failing",
      connection: "failing",
      usable: false,
      environment: {
        setVariables: ["SLACK_SIGNING_SECRET"],
        missingVariables: ["CHAT_SDK_SLACK_TOKEN", "CHAT_SDK_CHANNEL_ID"],
        complete: false,
      },
      failure: {
        reason: "environment_incomplete",
        message: "Set CHAT_SDK_SLACK_TOKEN, CHAT_SDK_CHANNEL_ID on this deployment, or store the values from the dashboard",
        missingVariables: ["CHAT_SDK_SLACK_TOKEN", "CHAT_SDK_CHANNEL_ID"],
      },
    }),
    webhook: { label: "/ai-workflow slash command", requires: ["signingSecret"], served: true },
    ...overrides,
  });
}

test("a deployment that registered only the slash command is told the command works and what the rest needs", () => {
  // Failing is true of the connection (no bot token, no channel, so nothing is
  // posted), and alone it would send the admin to fix a command that works.
  const rendered = statusDetailLines(commandOnlySlack()).join(" ");
  assert.match(rendered, /The \/ai-workflow slash command is still answered here: it needs only the Signing secret\./);
  assert.match(rendered, /Everything else Slack does \(messaging\) waits until the rest of the connection works\./);
  assert.match(rendered, /Not set here: CHAT_SDK_SLACK_TOKEN and CHAT_SDK_CHANNEL_ID\./);
});

test("a Connected Slack without its signing secret says the command is not answered", () => {
  const rendered = statusDetailLines(
    commandOnlySlack({
      state: state({ integrationId: "slack", source: "environment" }),
      webhook: { label: "/ai-workflow slash command", requires: ["signingSecret"], served: false },
    }),
  ).join(" ");
  assert.match(rendered, /The \/ai-workflow slash command is not answered here: it needs the Signing secret, which is not set or cannot be read\./);
});

test("a webhook that agrees with the rest of the integration adds nothing to the card", () => {
  for (const [usable, served, status] of [
    [true, true, "connected"],
    [false, false, "failing"],
  ] as const) {
    const rendered = statusDetailLines(
      commandOnlySlack({
        state: state({ integrationId: "slack", usable, status, connection: status }),
        webhook: { label: "/ai-workflow slash command", requires: ["signingSecret"], served },
      }),
    ).join(" ");
    assert.doesNotMatch(rendered, /slash command/, `${status}, served ${served}`);
  }
  const off = statusDetailLines(
    commandOnlySlack({ state: state({ enabled: false, status: "disabled", usable: false }) }),
  ).join(" ");
  assert.doesNotMatch(off, /slash command/, "switched off says so once, above");
});

test("values saved beside a working environment are said to be stored, tested and not in use", () => {
  // The worker keeps a connected environment as the source. "Accepted" alone
  // read as "in use", and an admin who then revoked the old credential
  // stopped every run.
  const beside = integration({
    state: state({ source: "environment", environment: { setVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"], missingVariables: [], complete: true } }),
  });
  const rendered = testOutcomeLines({ ok: true }, beside, "save").join(" ");
  assert.match(rendered, /stored and tested, and not in use: runs still use this deployment's environment variables/);
  assert.match(rendered, /Use the stored values/);
  assert.match(rendered, /Keep the old credential/);

  const inUse = testOutcomeLines({ ok: true }, integration(), "save").join(" ");
  assert.equal(inUse, "Demo accepted these values.");
  // A Test of what is in use is about the environment itself: no switch to offer.
  assert.doesNotMatch(testOutcomeLines({ ok: true }, beside, "test").join(" "), /not in use/);
});

/** The last health scan, holding one entry for the Demo integration. */
function scanWith(mode: string, checks: { label: string; mode: string; message?: string }[] = []) {
  return {
    generatedAt: "2026-09-23T09:00:00.000Z",
    summary: {
      total: 1, live: 0, down: 1, notConfigured: 0, criticalDown: 0,
      checksTotal: 0, checksLive: 0, checksDown: 0, checksDegraded: 0,
    },
    integrations: [
      {
        id: "demo", label: "Demo", group: "execution", envVars: [], critical: false,
        mode, ping: null,
        checks: checks.map((check, index) => ({
          id: `c${index}`, description: "", critical: true, envVars: [], evidenceSource: "probe", ...check,
        })),
      },
    ],
  } as never;
}

// Red when: a card reads Connected beside a fresh scan that found the
// integration down, with nothing to say they disagree (QA, Arthur).
test("a Connected card says when the latest health scan found it down, naming the check", () => {
  const rendered = statusDetailLines(
    integration(),
    scanWith("down", [{ label: "Auth", mode: "down", message: "timeout after 4005 ms" }]),
  ).join(" ");
  assert.match(
    rendered,
    /The health scan of Sep 23, 2026, 9:00:00 AM UTC found Demo down \(Auth: timeout after 4005 ms\)\. The status here comes from the values in use and the last test; press Test to check again\./,
  );
});

test("a scan that agrees, or a card that is not Connected, adds no line", () => {
  assert.doesNotMatch(statusDetailLines(integration(), scanWith("live")).join(" "), /health scan/);
  assert.doesNotMatch(statusDetailLines(integration(), null).join(" "), /health scan/);
  const failing = integration({
    state: state({ status: "failing", connection: "failing", usable: false, failure: { reason: "credential_rejected", message: "401" } }),
  });
  assert.doesNotMatch(statusDetailLines(failing, scanWith("down")).join(" "), /health scan/);
});

test("a save that failed its test is reported as stored and not in use", () => {
  const lines = statusDetailLines(
    integration({
      state: state({
        stored: {
          latestVersion: 4,
          activeVersion: 3,
          missingFields: [],
          complete: true,
          prepared: {
            version: 4,
            at: "2026-09-18T10:00:00.000Z",
            failure: { reason: "credential_rejected", message: "401 unauthorised" },
          },
        },
      }),
    }),
  );
  assert.match(lines.join(" "), /did not pass their test and are not in use.*401 unauthorised/);
});

test("the card says which blocks and screens connecting would add", () => {
  const lines = unlocksLines(integration());
  assert.match(lines.join(" "), /Demo echo block/);
  assert.match(lines.join(" "), /Overview screen/);
  assert.match(lines.join(" "), /messaging capability/);
});

test("a stored secret says blank keeps it, so nobody retypes a token to fix a URL", () => {
  const hint = fieldHint({ ...TOKEN_FIELD, storedSecretSet: true }, state(), false);
  assert.match(hint, /Leave this blank to keep it/);
});

test("without the secrets key a secret field says which variable to set, before anything is typed", () => {
  const hint = fieldHint(TOKEN_FIELD, state({ secretsKeyAvailable: false }), false);
  assert.match(hint, /INTEGRATION_SECRETS_KEY/);
});

test("a secret field says what it is before its state, like every other field", () => {
  // Red when: a secret's description is dropped and the admin reads only
  // "Nothing is stored yet" under a field named "API key" (QA, Mem0).
  const described = { ...TOKEN_FIELD, description: "From Settings, API keys, in your Demo account." };
  for (const hint of [
    fieldHint(described, state(), false),
    fieldHint({ ...described, storedSecretSet: true }, state(), false),
    fieldHint(described, state({ secretsKeyAvailable: false }), false),
    fieldHint({ ...described, storedSecretSet: true }, state(), true),
  ]) {
    assert.match(hint, /^From Settings, API keys, in your Demo account\. /);
  }
});

test("a secret marked for erasure says so rather than saying blank keeps it", () => {
  const hint = fieldHint({ ...TOKEN_FIELD, storedSecretSet: true }, state(), true);
  assert.match(hint, /will be removed/);
  assert.doesNotMatch(hint, /blank to keep/);
});

test("correcting a URL sends the URL and no secret at all", () => {
  // INT-052. An untouched secret input holds nothing to send, and sending an
  // empty string for it would read as "store an empty token".
  const request = buildSaveRequest({
    fields: [URL_FIELD, { ...TOKEN_FIELD, storedSecretSet: true }],
    values: { baseUrl: "https://demo.example ", apiToken: "" },
    clearedSecrets: [],
    state: state(),
  });
  assert.deepEqual(request.values, { baseUrl: "https://demo.example" });
  assert.deepEqual(request.clearSecrets, []);
  assert.equal(request.expectedVersion, 3);
});

test("a typed secret is sent, trimmed of the newline a paste brings with it", () => {
  const request = buildSaveRequest({
    fields: [URL_FIELD, TOKEN_FIELD],
    values: { baseUrl: "https://demo.example", apiToken: "tok-1\n" },
    clearedSecrets: [],
    state: state(),
  });
  assert.equal(request.values.apiToken, "tok-1");
});

test("erasing a secret is its own instruction and never an empty value", () => {
  const request = buildSaveRequest({
    fields: [URL_FIELD, { ...TOKEN_FIELD, storedSecretSet: true }],
    values: { baseUrl: "https://demo.example", apiToken: "" },
    clearedSecrets: ["apiToken"],
    state: state(),
  });
  assert.deepEqual(request.clearSecrets, ["apiToken"]);
  assert.equal("apiToken" in request.values, false);
});

test("a required secret already stored is not reported as missing", () => {
  const empty = missingRequiredFields({
    fields: [URL_FIELD, { ...TOKEN_FIELD, storedSecretSet: true }],
    values: { baseUrl: "https://demo.example", apiToken: "" },
    clearedSecrets: [],
    state: state(),
  });
  assert.deepEqual(empty, []);
});

test("a required secret being erased with nothing typed in its place is missing", () => {
  const empty = missingRequiredFields({
    fields: [URL_FIELD, { ...TOKEN_FIELD, storedSecretSet: true }],
    values: { baseUrl: "https://demo.example", apiToken: "" },
    clearedSecrets: ["apiToken"],
    state: state(),
  });
  assert.deepEqual(empty, ["API token"]);
});

test("a required field holding only whitespace is missing", () => {
  const empty = missingRequiredFields({
    fields: [URL_FIELD, { ...TOKEN_FIELD, storedSecretSet: true }],
    values: { baseUrl: "   ", apiToken: "" },
    clearedSecrets: [],
    state: state(),
  });
  assert.deepEqual(empty, ["Site URL"]);
});

test("a failed Test of the environment in use says runs that need it stop", () => {
  const failing = integration({
    state: state({
      source: "environment",
      status: "failing",
      connection: "failing",
      usable: false,
      environment: { setVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"], missingVariables: [], complete: true },
      failure: { reason: "credential_rejected", message: "401 unauthorised" },
    }),
  });
  const rendered = testOutcomeLines(
    { ok: false, failure: { reason: "credential_rejected", message: "401 unauthorised" } },
    failing,
    "test",
  ).join(" ");
  assert.match(rendered, /runs that need it stop until the variables are corrected/);
});

test("a refused credential leaves the working connection in place and says so", () => {
  const lines = testOutcomeLines(
    { ok: false, failure: { reason: "credential_rejected", message: "401 unauthorised" } },
    integration(),
    "save",
  );
  assert.match(lines.join(" "), /401 unauthorised/);
  assert.match(lines.join(" "), /connection that was already working carries on/);
});

test("a provider that could not be reached is told apart from one that said no", () => {
  const lines = testOutcomeLines(
    { ok: false, failure: { reason: "provider_unreachable", message: "The provider did not answer" } },
    integration(),
    "save",
  );
  assert.match(lines.join(" "), /not the credential being refused/);
});

test("a Test the provider did not answer says the connection is as it was, not that values are stored", () => {
  // Nothing was saved by pressing Test, so "the values are stored and will be
  // used once a test passes" described a save that never happened.
  const lines = testOutcomeLines(
    { ok: false, failure: { reason: "provider_unreachable", message: "The provider did not answer" } },
    integration({ state: state({ source: "stored" }) }),
    "test",
  ).join(" ");
  assert.match(lines, /not the credential being refused, so the connection is as it was; try again in a moment/);
  assert.doesNotMatch(lines, /The values are stored/);
});

test("a Test that the provider refuses turns the stored values in use Failing, and says so", () => {
  // The worker resolves a refused Test of the values in use as Failing, and
  // runs stop on it. "Nothing changed: a test that fails changes no value" was
  // true of the values and false of everything an admin cares about.
  const failing = integration({
    state: state({ source: "stored", status: "failing", connection: "failing", usable: false }),
  });

  const refused = testOutcomeLines(
    { ok: false, failure: { reason: "credential_rejected", message: "401 Unauthorized" } },
    failing,
    "test",
  ).join(" ");
  assert.match(
    refused,
    /These are the values in use, and Demo refused them: the integration is now Failing, and runs that need it stop until new values are saved or a later Test passes\./,
  );
  assert.doesNotMatch(refused, /Nothing changed/);

  const malformed = testOutcomeLines(
    { ok: false, failure: { reason: "value_malformed", message: "The API token holds a line break" } },
    failing,
    "test",
  ).join(" ");
  assert.match(
    malformed,
    /one of them cannot be sent as it is: the integration is now Failing, and runs that need it stop until corrected values are saved\./,
  );
});

test("a refusal on a deployment with nothing connected does not claim something carries on", () => {
  const lines = testOutcomeLines(
    { ok: false, failure: { reason: "credential_rejected", message: "401 unauthorised" } },
    integration({
      state: state({ status: "not_connected", connection: "not_connected", usable: false }),
    }),
    "save",
  );
  assert.match(lines.join(" "), /still not connected/);
  assert.doesNotMatch(lines.join(" "), /carries on/);
});

test("disconnecting with a complete environment says the deployment keeps working", () => {
  const lines = disconnectConsequence(
    integration({
      state: state({
        environment: {
          setVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"],
          missingVariables: [],
          complete: true,
        },
      }),
    }),
  );
  assert.match(lines.join(" "), /goes back to those values and keeps working/);
  assert.doesNotMatch(lines.join(" "), /runs that need it fail/);
});

test("disconnecting with nothing else configured says everything using it stops", () => {
  const lines = disconnectConsequence(integration());
  assert.match(lines.join(" "), /becomes Not connected/);
  assert.match(lines.join(" "), /runs that need it fail/);
});

test("disabling says runs fail and that the stored values survive it", () => {
  const lines = disableConsequence(integration());
  assert.match(lines.join(" "), /A run that uses Demo fails naming it/);
  assert.match(lines.join(" "), /enabling it again finds exactly these values/);
});

test("an integration with no blocks is not said to grey any out, on or off", () => {
  // Jira has no blocks; "Jira's blocks grey out" and "its blocks return" sent
  // an admin looking for blocks that do not exist.
  const tracker = integration({ blocks: [] });
  const said = [
    ...disableConsequence(tracker),
    enableConsequence(tracker),
    ...disconnectConsequence(tracker),
  ].join(" ");
  assert.doesNotMatch(said, /blocks/);
});

test("the cost of a change names repositories only for version control", () => {
  const impact = {
    changesFingerprint: false,
    stops: "none",
    unmeasuredCapabilities: [],
    enabledDefinitions: [],
    inFlightRuns: 0,
    repositories: [],
  } as const;
  // "Repositories using Jira: none" read as a finding about Jira.
  const tracker = integrationImpactLines(integration({ name: "Jira", capabilities: ["issue_tracker"] }), impact, "disable");
  assert.doesNotMatch(tracker.join(" "), /[Rr]epositories/);
  const vcs = integrationImpactLines(integration({ name: "GitHub", capabilities: ["vcs"] }), impact, "disable");
  assert.match(vcs.join(" "), /Repositories using GitHub: none\./);
  const unread = integrationImpactLines(
    integration({ name: "GitHub", capabilities: ["vcs"] }),
    { ...impact, repositories: null },
    "disable",
  );
  assert.match(unread.join(" "), /Affected repositories: unknown/);
});

test("enabling again goes back to where the values come from", () => {
  const fromEnvironment = integration({ blocks: [], state: state({ source: "environment" }) });
  assert.match(enableConsequence(fromEnvironment), /goes back to this deployment's environment variables/);
  assert.doesNotMatch(enableConsequence(fromEnvironment), /stored/);
  assert.match(enableConsequence(integration({ blocks: [] })), /goes back to the values stored for it/);
});

test("switching to an environment that does not configure the integration is refused by name", () => {
  const refusal = sourceSwitchRefusal(
    integration({
      state: state({
        environment: {
          setVariables: ["DEMO_BASE_URL"],
          missingVariables: ["DEMO_API_TOKEN"],
          complete: false,
        },
      }),
    }),
    "environment",
  );
  assert.match(String(refusal), /DEMO_API_TOKEN/);
});

test("a source that does not configure the integration does not claim the values came from it", () => {
  // The state right after a first save failed its test: the source is still the
  // environment, and the environment sets nothing.
  const lines = statusDetailLines(
    integration({
      state: state({
        source: "environment",
        status: "not_connected",
        connection: "not_connected",
        usable: false,
        environment: {
          setVariables: [],
          missingVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"],
          complete: false,
        },
        stored: {
          latestVersion: 1,
          activeVersion: null,
          missingFields: [],
          complete: true,
          prepared: {
            version: 1,
            at: "2026-09-19T03:44:00.000Z",
            failure: { reason: "credential_rejected", message: "401 unauthorised" },
          },
        },
      }),
    }),
  );
  const rendered = lines.join(" ");
  assert.match(rendered, /which does not configure it: DEMO_BASE_URL and DEMO_API_TOKEN are not set/);
  assert.doesNotMatch(rendered, /Values come from this deployment's environment variables\./);
});

test("values saved but never activated are not reported as nothing stored", () => {
  const refusal = sourceSwitchRefusal(
    integration({
      state: state({
        source: "environment",
        stored: {
          latestVersion: 1,
          activeVersion: null,
          missingFields: [],
          complete: true,
          prepared: {
            version: 1,
            at: "2026-09-19T03:44:00.000Z",
            failure: { reason: "credential_rejected", message: "401 unauthorised" },
          },
        },
      }),
    }),
    "stored",
  );
  assert.match(String(refusal), /has not passed a test/);
  assert.doesNotMatch(String(refusal), /Nothing is stored here yet/);
});

test("switching to stored values nobody saved says to save and test them first", () => {
  const refusal = sourceSwitchRefusal(
    integration({
      fields: [URL_FIELD, TOKEN_FIELD],
      state: state({
        source: "environment",
        stored: {
          latestVersion: 0,
          activeVersion: null,
          missingFields: [],
          complete: false,
          prepared: null,
        },
      }),
    }),
    "stored",
  );
  assert.match(String(refusal), /save them first/);
});

test("a complete environment can be switched to", () => {
  const refusal = sourceSwitchRefusal(
    integration({
      state: state({
        environment: {
          setVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"],
          missingVariables: [],
          complete: true,
        },
      }),
    }),
    "environment",
  );
  assert.equal(refusal, null);
});

test("a provider answering with a login page gets one bounded sentence", () => {
  // Seen at the gate: a 401 answered with ~2 KB of HTML, rendered whole into
  // the status line.
  const html = `<!doctype html><html><head><title>Sign in</title></head><body>${"<p>Please sign in to continue.</p>".repeat(60)}</body></html>`;
  const line = readableProviderText(html);
  assert.ok(line.length <= 240, `the status line stays a line, got ${line.length} characters`);
  assert.doesNotMatch(line, /</, "no markup reaches the screen");
  assert.match(line, /Please sign in to continue/, "what it actually said survives");
});

test("a forwarded error keeps its first line and loses the stack and the internal URL", () => {
  const line = readableProviderText(
    "TypeError: fetch failed at http://localhost:3110/api/v1/integrations/demo/test\n    at async POST (/app/route.js:1:1)\n    at async run",
  );
  assert.doesNotMatch(line, /localhost:3110/);
  assert.doesNotMatch(line, /at async/);
  assert.match(line, /^TypeError: fetch failed/);
});

test("a provider that answered nothing readable still gets a sentence", () => {
  assert.match(readableProviderText("   \n  "), /said nothing this screen can show/);
});

test("testing what is in use is refused while nothing is configured, and names why", () => {
  const refusal = testRefusal(
    integration({
      state: state({
        source: "environment",
        status: "not_connected",
        connection: "not_connected",
        usable: false,
        environment: {
          setVariables: [],
          missingVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"],
          complete: false,
        },
        stored: {
          latestVersion: 0,
          activeVersion: null,
          missingFields: [],
          complete: false,
          prepared: null,
        },
      }),
    }),
  );
  assert.match(String(refusal), /nothing to test/);
  assert.match(String(refusal), /DEMO_BASE_URL and DEMO_API_TOKEN are not set/);
});

test("a connection that is in use can always be tested", () => {
  assert.equal(testRefusal(integration()), null);
  assert.equal(
    testRefusal(integration({ state: state({ status: "failing", connection: "failing" }) })),
    null,
    "a failing connection is exactly the one worth retesting",
  );
});

test("a conflict names the field that differs, with both values, and leaves the rest alone", () => {
  const lines = conflictDifferenceLines({
    fields: [
      { ...URL_FIELD, storedValue: "https://theirs.example" },
      {
        key: "projectKey",
        label: "Project key",
        env: "DEMO_PROJECT_KEY",
        secret: false,
        optional: false,
        format: "text",
        envSet: false,
        storedValue: "NEW-9",
        storedSecretSet: false,
      },
    ],
    values: { baseUrl: "https://mine.example", projectKey: "NEW-9" },
    clearedSecrets: [],
    state: state(),
  });
  assert.deepEqual(lines, [
    'Site URL is now "https://theirs.example" here, and you typed "https://mine.example".',
  ]);
});

test("a conflict over a secret says what saving would do to the stored one", () => {
  const lines = conflictDifferenceLines({
    fields: [{ ...TOKEN_FIELD, storedSecretSet: true }],
    values: { apiToken: "mine" },
    clearedSecrets: [],
    state: state(),
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /a value is stored here now, and saving replaces it/);
  assert.doesNotMatch(lines[0]!, /mine/, "a secret is never read back, not even to compare it");
});

test("a conflict that changed nothing says saving again is harmless", () => {
  const lines = conflictDifferenceLines({
    fields: [{ ...URL_FIELD, storedValue: "https://same.example" }],
    values: { baseUrl: "https://same.example" },
    clearedSecrets: [],
    state: state(),
  });
  assert.match(lines.join(" "), /Nothing you typed differs/);
});

test("disconnecting an integration that is also switched off does not promise it keeps working", () => {
  const environment = {
    setVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"],
    missingVariables: [],
    complete: true,
  };
  const working = disconnectConsequence(integration({ state: state({ environment }) })).join(" ");
  assert.match(working, /keeps working/);

  const off = disconnectConsequence(
    integration({ state: state({ environment, enabled: false, status: "disabled", usable: false }) }),
  ).join(" ");
  assert.doesNotMatch(off, /keeps working/, "it is switched off, so nothing runs either way");
  assert.match(off, /stays switched off here/);
});

test("the blocks of an integration stay in the editor, greyed out, rather than leaving it", () => {
  // The screen the skeptic walked shows them with the reason on the block. The
  // three sentences that said they leave were the lie.
  const said = [
    ...disableConsequence(integration()),
    ...disconnectConsequence(integration()),
    ...statusDetailLines(
      integration({ state: state({ enabled: false, status: "disabled", usable: false }) }),
    ),
  ].join(" ");
  assert.doesNotMatch(said, /leave the (workflow )?editor/);
  assert.match(said, /grey out in the workflow editor/);
});

test("a card promises only the blocks this build can run, and says why about the rest", () => {
  const demo = integration({
    blocks: [
      { type: "demo_echo", label: "Demo echo" },
      { type: "demo_lookup", label: "Demo lookup" },
    ],
  });
  const availability = blockAvailabilityOf(
    {
      demo_echo: { availability: { available: true, unavailableReason: null } },
      demo_lookup: {
        availability: {
          available: false,
          unavailableReason: "Core still owns the messaging capability.",
        },
      },
    },
    [demo],
  );
  const lines = unlocksLines(demo, availability).join(" ");
  assert.match(lines, /Adds the Demo echo block to the workflow editor\./);
  assert.doesNotMatch(lines, /Adds the Demo echo and Demo lookup/);
  assert.match(lines, /Demo lookup stays unavailable in the editor: Core still owns/);
});

test("without an answer about the blocks the card describes them instead of promising", () => {
  const lines = unlocksLines(integration()).join(" ");
  assert.match(lines, /the workflow editor says which of them this build can run/);
});

test("an integration nobody connected still says what connecting would bring", () => {
  // Its blocks are refused in the palette for one reason: it is not connected.
  // Reading that back as "Demo echo stays unavailable" leaves the one card that
  // should sell the connection saying nothing but that it is not connected.
  const demo = integration({
    blocks: [
      { type: "demo_echo", label: "Demo echo" },
      { type: "demo_lookup", label: "Demo lookup" },
    ],
    state: state({
      status: "not_connected",
      connection: "not_connected",
      usable: false,
      stored: {
        latestVersion: 0,
        activeVersion: null,
        missingFields: [],
        complete: false,
        prepared: null,
      },
    }),
  });
  const availability = new Map([
    ["demo_echo", { available: false, unavailableReason: "Demo is not connected." }],
    ["demo_lookup", { available: false, unavailableReason: "Demo is not connected." }],
  ]);
  const lines = unlocksLines(demo, availability).join(" ");
  assert.match(lines, /Brings the Demo echo and Demo lookup blocks/);
  assert.doesNotMatch(lines, /stays unavailable/);
});

test("a failed test of environment values does not send the admin to edit the form", () => {
  // Walked on the running screen: the deployment reads its environment, the
  // provider refused that token, and the advice was "correct the values above
  // and save again", which edits values nothing is reading.
  const failing = integration({
    state: state({
      source: "environment",
      status: "failing",
      connection: "failing",
      usable: false,
      environment: {
        setVariables: ["DEMO_BASE_URL", "DEMO_API_TOKEN"],
        missingVariables: [],
        complete: true,
      },
    }),
  });
  const outcome = {
    ok: false,
    failure: { reason: "credential_rejected" as const, message: "401 Unauthorized" },
  };
  const tested = testOutcomeLines(outcome, failing, "test").join(" ");
  assert.match(tested, /environment variables, not the values typed above/);
  assert.doesNotMatch(tested, /Correct the values above and save again/);

  const saved = testOutcomeLines(outcome, failing, "save").join(" ");
  assert.match(saved, /Correct the values above and save again/, "a save did send exactly those values");
});
