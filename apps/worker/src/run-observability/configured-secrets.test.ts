import { describe, expect, it, vi } from "vitest";
import { integrationManifests } from "@integrations/registry";
import { environmentSecretValues, secretForms } from "./configured-secrets.js";

describe("environmentSecretValues", () => {
  it("always includes a credential main listed by name, however short", () => {
    // Core's own by name; an integration's through its manifest's secret
    // fields, which cover every integration variable main listed by hand.
    const integrationSecret = integrationManifests
      .flatMap((manifest) => manifest.connection.fields)
      .find((field) => field.secret)!.env;
    const warn = vi.fn();
    expect(
      environmentSecretValues({ [integrationSecret]: "abc", CRON_SECRET: "x", EMPTY_SECRET: "" }, warn),
    ).toEqual(["abc", "x"]);
    expect(warn).not.toHaveBeenCalled();
  });

  // Red when: a value a person chose, found only by its variable's name, is
  // cut out of every PR body, Jira comment and Slack message because it is a
  // common word.
  it("skips a short value found only by its name, and says so once naming the variable, never the value", () => {
    const warn = vi.fn();
    const environment = {
      DASHBOARD_AUTH_PASSWORD: "admin",
      DATABASE_PASSWORD: "correct-horse-battery",
      PUBLIC_URL: "https://example.com",
    };
    expect(environmentSecretValues(environment, warn)).toEqual(["correct-horse-battery"]);
    environmentSecretValues(environment, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("DASHBOARD_AUTH_PASSWORD");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("admin\"");
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

const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAx7Qk9mZyJ4pQ0m1nZ9wP",
  "q8R2s3T4u5V6w7X8y9Z0a1B2c3D4e5F6g7H8",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const PEM_LINE = "q8R2s3T4u5V6w7X8y9Z0a1B2c3D4e5F6g7H8";

describe("secretForms", () => {
  it("lists every written form a provider echoes a long secret in, longest first", () => {
    const token = "ghp_abc+def/12345678";
    const forms = secretForms([token]);
    expect(forms).toEqual(
      expect.arrayContaining([
        token,
        encodeURIComponent(token),
        Buffer.from(token, "utf8").toString("base64"),
      ]),
    );
    expect([...forms].sort((a, b) => b.length - a.length)).toEqual(forms);
  });

  it("covers a PEM key quoted JSON-escaped and a single line of it, not its header", () => {
    const forms = secretForms([PEM]);
    expect(forms).toContain(JSON.stringify(PEM).slice(1, -1));
    expect(forms).toContain(PEM_LINE);
    expect(forms).not.toContain("-----END RSA PRIVATE KEY-----");
  });

  it("keeps a short secret to its exact value, whose encodings would match by chance", () => {
    expect(secretForms(["ab12"])).toEqual(["ab12"]);
    expect(secretForms([""])).toEqual([]);
  });

  it("encodes base64 over UTF-8 as Buffer does, without Buffer", () => {
    for (const value of ["pässwörd-0123456", "a", "ab", "abc", "zażółć gęślą jaźń"]) {
      const long = value.padEnd(8, "x");
      expect(secretForms([long])).toContain(Buffer.from(long, "utf8").toString("base64"));
    }
  });
});
