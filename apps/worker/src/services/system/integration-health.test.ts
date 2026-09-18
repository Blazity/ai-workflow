import { describe, expect, it } from "vitest";
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";

import { PublicHealthProbeError } from "./collect.js";
import {
  environmentReaderFrom,
  resolveIntegrationState,
} from "../integrations/index.js";
import { integrationHealthContributions } from "./integration-health.js";

/**
 * A manifest shaped like a real one: two connection variables, one optional
 * with a default, and two declared checks of which one is required.
 */
function manifest(overrides: Partial<IntegrationManifest> = {}): IntegrationManifest {
  return {
    id: "demo",
    name: "Demo",
    description: "A provider used for tests.",
    connection: {
      fields: [
        { key: "baseUrl", label: "Site URL", env: "DEMO_BASE_URL", secret: false, format: "url" },
        { key: "apiToken", label: "API token", env: "DEMO_API_TOKEN", secret: true },
        {
          key: "channel",
          label: "Default channel",
          env: "DEMO_CHANNEL",
          secret: false,
          optional: true,
          default: "general",
        },
      ],
    },
    capabilities: [],
    blocks: [],
    pages: [],
    health: [
      { id: "auth", label: "Token accepted", description: "The provider accepts the token.", critical: true },
      { id: "delivery", label: "Message delivered", description: "The last message was recorded.", critical: false },
    ],
    ...overrides,
  };
}

/** The real resolver decides the state, so the health page and the Integrations
 *  page can never be tested against two different ideas of the same deployment. */
function stateOf(
  environment: Record<string, string | undefined>,
  overrides: { enabled?: boolean } = {},
): IntegrationState {
  const resolved = resolveIntegrationState({
    manifest: manifest(),
    environment: environmentReaderFrom(environment),
    stored: null,
    secretsKey: { present: false },
  });
  if (overrides.enabled === false) {
    return { ...resolved, enabled: false, status: "disabled", usable: false };
  }
  return resolved;
}

describe("integrationHealthContributions", () => {
  it("says an integration nobody connected is not connected, and calls nothing", async () => {
    let probeCalls = 0;
    const contributions = integrationHealthContributions([
      {
        manifest: manifest(),
        state: stateOf({}),
        probe: async () => {
          probeCalls += 1;
          return { status: "live" };
        },
      },
    ]);

    expect(contributions.definitions).toHaveLength(1);
    const definition = contributions.definitions[0];
    expect(definition).toMatchObject({
      id: "demo",
      label: "Demo",
      group: "integrations",
      critical: false,
      description: "A provider used for tests.",
    });
    expect(definition?.checks.map((check) => [check.id, check.mode])).toEqual([
      ["connection", "not-configured"],
      ["auth", "not-configured"],
      ["delivery", "not-configured"],
    ]);
    expect(definition?.checks[0]?.message).toMatch(/not connected/i);
    expect(Object.keys(contributions.probes)).toEqual([]);
    expect(probeCalls).toBe(0);
  });

  it("names the variables a half-configured environment is missing", async () => {
    let probeCalls = 0;
    const contributions = integrationHealthContributions([
      {
        manifest: manifest(),
        state: stateOf({ DEMO_BASE_URL: "https://demo.example", DEMO_CHANNEL: "ops" }),
        probe: async () => {
          probeCalls += 1;
          return { status: "live" };
        },
      },
    ]);

    const connection = contributions.definitions[0]?.checks[0];
    expect(connection).toMatchObject({
      id: "connection",
      mode: "misconfigured",
      // The variables to set, and only those: the two that are set are not
      // something anybody has to act on.
      envVars: ["DEMO_API_TOKEN"],
    });
    expect(connection?.message).toContain("DEMO_API_TOKEN");
    expect(connection?.message).not.toContain("DEMO_BASE_URL");
    expect(Object.keys(contributions.probes)).toEqual([]);
    expect(probeCalls).toBe(0);
  });

  it("hands every declared check of a connected integration to its own probe", async () => {
    const asked: string[] = [];
    const contributions = integrationHealthContributions([
      {
        manifest: manifest(),
        state: stateOf({
          DEMO_BASE_URL: "https://demo.example",
          DEMO_API_TOKEN: "demo-token",
        }),
        probe: async (checkId) => {
          asked.push(checkId);
          return checkId === "delivery"
            ? { status: "degraded", message: "No message has been sent yet." }
            : { status: "live" };
        },
      },
    ]);

    const definition = contributions.definitions[0];
    expect(definition?.checks.map((check) => [check.id, check.mode])).toEqual([
      ["connection", "configured"],
      ["auth", "configured"],
      ["delivery", "configured"],
    ]);
    expect(definition?.checks[0]?.message).toMatch(/No connection test has been run/);
    expect(definition?.checks[0]?.envVars).toEqual([
      "DEMO_BASE_URL",
      "DEMO_API_TOKEN",
      "DEMO_CHANNEL",
    ]);
    expect(Object.keys(contributions.probes)).toEqual(["integration:demo.auth", "integration:demo.delivery"]);

    const signal = new AbortController().signal;
    expect(await contributions.probes["integration:demo.auth"]?.(signal)).toEqual({ mode: "live" });
    expect(await contributions.probes["integration:demo.delivery"]?.(signal)).toEqual({
      mode: "degraded",
      message: "No message has been sent yet.",
    });
    expect(asked).toEqual(["auth", "delivery"]);
  });

  it("reads a disabled integration as disabled, and asks the provider nothing", async () => {
    let probeCalls = 0;
    const contributions = integrationHealthContributions([
      {
        manifest: manifest(),
        state: stateOf(
          { DEMO_BASE_URL: "https://demo.example", DEMO_API_TOKEN: "demo-token" },
          { enabled: false },
        ),
        probe: async () => {
          probeCalls += 1;
          return { status: "live" };
        },
      },
    ]);

    const definition = contributions.definitions[0];
    expect(definition?.checks.map((check) => check.mode)).toEqual([
      "disabled",
      "disabled",
      "disabled",
    ]);
    expect(definition?.checks[0]?.message).toMatch(/turned off/i);
    expect(definition?.checks[0]?.envVars).toEqual([]);
    expect(Object.keys(contributions.probes)).toEqual([]);
    expect(probeCalls).toBe(0);
  });

  it.each([
    ["nothing at all", undefined],
    ["an empty object", {}],
    ["a word this report has no meaning for", { status: "ok" }],
    ["a number", 7],
    ["a status that is not a string", { status: 1 }],
  ])("never paints live for a probe that returns %s", async (_case, answer) => {
    const contributions = integrationHealthContributions([
      {
        manifest: manifest(),
        state: stateOf({
          DEMO_BASE_URL: "https://demo.example",
          DEMO_API_TOKEN: "demo-token",
        }),
        // An integration is ordinary JavaScript written outside this repository.
        probe: (async () => answer) as never,
      },
    ]);

    expect(await contributions.probes["integration:demo.auth"]?.(
      new AbortController().signal,
    )).toEqual({
      mode: "down",
      message: "The probe returned no usable result, so nothing about this check was verified.",
    });
  });

  it("keeps every contributed probe out of the keys core uses", () => {
    const contributions = integrationHealthContributions([
      {
        // An integration is free to call itself whatever core calls something.
        manifest: manifest({
          id: "github",
          health: [
            {
              id: "repositories",
              label: "Repository access",
              description: "The provider lists repositories.",
              critical: true,
            },
          ],
        }),
        state: stateOf({
          DEMO_BASE_URL: "https://demo.example",
          DEMO_API_TOKEN: "demo-token",
        }),
        probe: async () => ({ status: "live" }),
      },
    ]);

    expect(Object.keys(contributions.probes)).toEqual(["integration:github.repositories"]);
    expect(contributions.probes["github.repositories"]).toBeUndefined();
    expect(contributions.definitions[0]?.probeNamespace).toBe("integration:");
  });

  it("says a check was not checked rather than not configured", () => {
    const contributions = integrationHealthContributions([
      {
        manifest: manifest(),
        state: stateOf({ DEMO_BASE_URL: "https://demo.example" }),
      },
    ]);

    const declared = contributions.definitions[0]?.checks.slice(1) ?? [];
    expect(declared).toHaveLength(2);
    for (const check of declared) {
      expect(check.message).toMatch(/^Not checked: /);
    }
  });

  it("keeps a multiline key out of the text however a provider echoes it", async () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAx7Qk9mZyJ4pQ0m1nZ9wP",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const contributions = integrationHealthContributions([
      {
        manifest: manifest(),
        state: stateOf({
          DEMO_BASE_URL: "https://demo.example",
          DEMO_API_TOKEN: "demo-token",
        }),
        secrets: [pem],
        probe: async () => ({
          // What a provider echoes back in a JSON error body.
          status: "down",
          message: `The key ${JSON.stringify(pem).slice(1, -1)} was rejected.`,
        }),
      },
    ]);

    const result = await contributions.probes["integration:demo.auth"]?.(
      new AbortController().signal,
    );
    expect(result?.message).not.toContain("MIIEowIBAAKCAQEAx7Qk9mZyJ4pQ0m1nZ9wP");
    expect(result?.message).toContain("[redacted]");
  });

  it("keeps a token a provider echoed out of the message a probe produces", async () => {
    const contributions = integrationHealthContributions([
      {
        manifest: manifest(),
        state: stateOf({
          DEMO_BASE_URL: "https://demo.example",
          DEMO_API_TOKEN: "sk-demo-0123456789",
        }),
        secrets: ["sk-demo-0123456789"],
        probe: async () => ({
          status: "down",
          message: 'The provider refused {"token":"sk-demo-0123456789"}.',
        }),
      },
    ]);

    const result = await contributions.probes["integration:demo.auth"]?.(new AbortController().signal);
    expect(result?.mode).toBe("down");
    expect(result?.message).not.toContain("sk-demo-0123456789");
    expect(result?.message).toContain("[redacted]");
  });

  it("turns a probe that throws into one failing check with a usable reason", async () => {
    const contributions = integrationHealthContributions([
      {
        manifest: manifest(),
        state: stateOf({
          DEMO_BASE_URL: "https://demo.example",
          DEMO_API_TOKEN: "sk-demo-0123456789",
        }),
        secrets: ["sk-demo-0123456789"],
        probe: async () => {
          throw new Error("getaddrinfo ENOTFOUND demo.example with sk-demo-0123456789");
        },
      },
    ]);

    // A refusal the collector can show: it turns a PublicHealthProbeError into
    // the check's own message, and anything else into "Health check failed."
    const failure = await contributions.probes["integration:demo.auth"]?.(
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PublicHealthProbeError);
    expect((failure as Error).message).toContain("ENOTFOUND");
    expect((failure as Error).message).not.toContain("sk-demo-0123456789");
  });

  it("keeps the reason a network error carries in its cause", async () => {
    const contributions = integrationHealthContributions([
      {
        manifest: manifest(),
        state: stateOf({
          DEMO_BASE_URL: "https://demo.example",
          DEMO_API_TOKEN: "demo-token",
        }),
        probe: async () => {
          // What fetch throws: a flat "fetch failed" with the useful half in
          // the cause, which is the difference between "it broke" and "the
          // host refused the connection".
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
              code: "ECONNREFUSED",
            }),
          });
        },
      },
    ]);

    const failure = await contributions.probes["integration:demo.auth"]?.(
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect((failure as Error).message).toContain("fetch failed");
    expect((failure as Error).message).toContain("ECONNREFUSED");
  });

  it("names no variable for a connection whose values are stored", () => {
    const storedManifest = manifest({
      connection: {
        fields: [
          { key: "baseUrl", label: "Site URL", env: "DEMO_BASE_URL", secret: false, format: "url" },
        ],
      },
    });
    const contributions = integrationHealthContributions([
      {
        manifest: storedManifest,
        state: resolveIntegrationState({
          manifest: storedManifest,
          environment: environmentReaderFrom({}),
          stored: {
            enabled: true,
            source: "stored",
            latestVersion: 1,
            activeVersion: 1,
            active: {
              version: 1,
              config: { baseUrl: "https://demo.example" },
              secrets: {},
              testStatus: "passed",
              testReason: null,
              testMessage: null,
              testedAt: "2026-09-18T10:00:00.000Z",
              createdAt: "2026-09-18T09:59:00.000Z",
            },
            latest: null,
            lastTest: null,
          },
          secretsKey: { present: false },
        }),
        probe: async () => ({ status: "live" }),
      },
    ]);

    const connection = contributions.definitions[0]?.checks[0];
    expect(connection).toMatchObject({ mode: "configured", envVars: [] });
    expect(connection?.message).toMatch(/stored in the dashboard/);
    expect(connection?.message).toMatch(/connection test passed/);
  });
});
