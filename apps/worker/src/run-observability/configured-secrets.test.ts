import { describe, expect, it } from "vitest";
import { integrationManifests } from "@integrations/registry";
import { environmentSecretValues } from "./configured-secrets.js";

describe("environmentSecretValues", () => {
  it("includes every non-empty secret-named value, including short values", () => {
    expect(
      environmentSecretValues({
        API_TOKEN: "abc",
        DATABASE_PASSWORD: "pw",
        OAUTH_SECRET: "x",
        EMPTY_SECRET: "",
        PUBLIC_URL: "https://example.com",
      }),
    ).toEqual(["abc", "pw", "x"]);
  });

  // Red when: a database connection string (it carries the password) or the
  // webhook trigger encryption key is left out because its name holds none of
  // the secret words.
  it("includes the database connection strings and the webhook trigger encryption key", () => {
    expect(
      environmentSecretValues({
        DATABASE_URL: "postgres://app:pw1@db.example/main",
        DATABASE_URL_UNPOOLED: "postgres://app:pw2@db.example/main",
        POSTGRES_URL: "postgres://app:pw3@db.example/main",
        POSTGRES_PRISMA_URL: "postgres://app:pw4@db.example/main",
        WEBHOOK_TRIGGER_ENCRYPTION_KEY: "encryption-key-value",
        DASHBOARD_ORIGIN: "https://dash.example",
      }),
    ).toEqual([
      "postgres://app:pw1@db.example/main",
      "postgres://app:pw2@db.example/main",
      "postgres://app:pw3@db.example/main",
      "postgres://app:pw4@db.example/main",
      "encryption-key-value",
    ]);
  });

  // Red when: a platform credential or an integration's environment-sourced
  // secret is not caught by the environment rule. Workflow scope has only this
  // half of the known set, so a name the rule misses is a secret printed into
  // a replay before any step can catch it. The platform names are the ones the
  // MCP sanitizer used to list by hand; the integration names are read from
  // the manifests, so a new integration's secret is covered the day it ships.
  it("covers every platform credential and every integration secret variable", () => {
    const names = [
      "ANTHROPIC_API_KEY",
      "CODEX_API_KEY",
      "CODEX_CHATGPT_OAUTH_TOKEN",
      "VERCEL_TOKEN",
      "CRON_SECRET",
      "WEBHOOK_TRIGGER_ENCRYPTION_KEY",
      "BETTER_AUTH_SECRET",
      "SSO_CLIENT_SECRET",
      "RESEND_API_KEY",
      "RESEND_WEBHOOK_SECRET",
      "INTEGRATION_SECRETS_KEY",
      ...integrationManifests.flatMap((manifest) =>
        manifest.connection.fields.filter((field) => field.secret).map((field) => field.env),
      ),
    ];
    expect(names.length).toBeGreaterThan(11);

    const environment = Object.fromEntries(names.map((name) => [name, `value-of-${name}`]));
    expect(environmentSecretValues(environment).sort()).toEqual(
      names.map((name) => `value-of-${name}`).sort(),
    );
  });
});
