/**
 * Values a deployment runs with on main today, fed in exactly the form main's
 * own parsers accepted them.
 *
 * main deploys itself to production, so a value rule on this branch that
 * refuses one of these turns a working integration Failing on the deploy,
 * with nobody having changed anything. The rule every value check here has to
 * keep: refuse only what could never have worked. Each input below names the
 * line of origin/main (01371a41) that accepted it, and expectations come from
 * those parsers, never from the rules under test.
 *
 * The real registry's manifests, the real resolver and the real reader of the
 * values a run receives: a card that reads Connected while the run's values
 * are refused would be the same outage, only quieter.
 */
import { integrationManifest } from "@integrations/registry";
import type { IntegrationManifest } from "@integrations/sdk";
import { describe, expect, it } from "vitest";

import { readConnectionValues } from "./connection-values.js";
import { environmentReaderFrom, resolveIntegrationState } from "./resolve.js";

function onEnvironment(id: string, env: Record<string, string>) {
  const manifest = integrationManifest(id) as IntegrationManifest;
  const environment = environmentReaderFrom(env);
  return {
    state: resolveIntegrationState({
      manifest,
      environment,
      stored: null,
      secretsKey: { present: false },
    }),
    values: readConnectionValues({
      manifest,
      source: "environment",
      environment,
      active: null,
      secretsKey: { present: false },
    }),
  };
}

const SLACK = { CHAT_SDK_SLACK_TOKEN: "xoxb-1-2-abc", CHAT_SDK_CHANNEL_ID: "C0123" };
const GITHUB = {
  GITHUB_APP_ID: "123",
  GITHUB_INSTALLATION_ID: "456",
  GITHUB_APP_PRIVATE_KEY: Buffer.from("-----BEGIN RSA PRIVATE KEY-----\n...").toString("base64"),
};
const JIRA = {
  JIRA_BASE_URL: "https://acme.atlassian.net",
  JIRA_API_TOKEN: "atl-token-5c0ffee5",
  JIRA_PROJECT_KEY: "AIW",
};

describe("values main ran with stay connected", () => {
  it("a Slack allowlist with a line break between its ids", () => {
    // origin/main apps/worker/src/services/settings/integration-settings.ts:96-99
    // split SLACK_ALLOWED_USER_IDS on commas and trimmed each id, and it is
    // never sent anywhere; the slash command parses it the same way today.
    const { state, values } = onEnvironment("slack", {
      ...SLACK,
      SLACK_ALLOWED_USER_IDS: "U01,\nU02",
    });
    expect(state.status).toBe("connected");
    expect(values.ok && values.values.allowedUserIds).toBe("U01,\nU02");
  });

  // origin/main apps/worker/src/infra/runtime-env.ts:34 and :36 read both ids
  // with z.coerce.number().int().positive(), which is Number() and a check.
  for (const id of ["123", " 123 ", "+123", "123.0", "1e3", "0x7b"]) {
    it(`a GitHub App id written as ${JSON.stringify(id)}`, () => {
      const { state, values } = onEnvironment("github", {
        ...GITHUB,
        GITHUB_APP_ID: id,
        GITHUB_INSTALLATION_ID: id,
      });
      expect(state.status).toBe("connected");
      expect(values.ok && values.values.appId).toBe(Number(id));
      expect(values.ok && values.values.installationId).toBe(Number(id));
    });
  }

  it("a Jira site address with a line break inside it", () => {
    // origin/main apps/worker/src/infra/runtime-env.ts:16 read it with
    // z.string().url(), which parses it the way `fetch` does: the WHATWG URL
    // parser drops every tab and line break, so requests went to the site.
    const { state, values } = onEnvironment("jira", {
      ...JIRA,
      JIRA_BASE_URL: "https://acme.atlas\nsian.net",
    });
    expect(state.status).toBe("connected");
    expect(values.ok).toBe(true);
  });
});

describe("values main refused stay refused", () => {
  it("a GitHub App client id where the numeric App id belongs", () => {
    // origin/main apps/worker/src/infra/runtime-env.ts:34: Number() of it is
    // NaN, and the deployment did not start.
    const { state } = onEnvironment("github", { ...GITHUB, GITHUB_APP_ID: "Iv1.8a61f9b3a7aba766" });
    expect(state.status).toBe("failing");
    expect(state.failure?.reason).toBe("value_malformed");
  });
});
