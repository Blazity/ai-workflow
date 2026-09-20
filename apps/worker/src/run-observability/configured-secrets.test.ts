import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configuredReplaySecrets } from "./configured-secrets.js";

describe("configuredReplaySecrets", () => {
  it("includes every non-empty secret-named value, including short values", () => {
    expect(
      configuredReplaySecrets({
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
      configuredReplaySecrets({
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

  // Red when: a credential the MCP result sanitizer redacts at serve time
  // (`configuredSecretValues` in services/settings/runtime-settings.ts) is not
  // a configured secret here, so a briefing could store a value MCP then
  // rewrites, and the dashboard and MCP would show two texts. Read from that
  // function's source rather than from a list copied beside it: a twentieth
  // secret added there is exactly the case a copied list cannot catch.
  it("covers every credential the MCP result sanitizer redacts", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../services/settings/runtime-settings.ts", import.meta.url)),
      "utf8",
    );
    const start = source.indexOf("export function configuredSecretValues");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    const mcpSecretNames = [...body.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]!);
    expect(mcpSecretNames.length).toBeGreaterThanOrEqual(19);

    const environment = Object.fromEntries(mcpSecretNames.map((name) => [name, `value-of-${name}`]));
    expect(configuredReplaySecrets(environment).sort()).toEqual(
      mcpSecretNames.map((name) => `value-of-${name}`).sort(),
    );
  });
});
