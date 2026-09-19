import { describe, expect, it, vi } from "vitest";

/**
 * The floor, on text this surface did not compose.
 *
 * A failed run's reason, a dispatch blocker and a publish refusal are written
 * by code that answers an admin, and an admin is entitled to read which
 * variable is missing. They still travel out of here, so the exact names go
 * before the answer leaves. See integration-redaction.ts for why this is a
 * floor and not the mechanism.
 */
vi.mock("@integrations/registry", () => ({
  integrationManifests: [
    {
      id: "demo",
      name: "Demo",
      connection: {
        fields: [
          { key: "baseUrl", label: "Site URL", env: "DEMO_BASE_URL", secret: false },
          { key: "apiToken", label: "API token", env: "DEMO_API_TOKEN", secret: true },
          // Legal by the SDK's pattern and short enough to appear inside words,
          // so it is deliberately left visible rather than shredding every
          // answer that happens to contain those letters.
          { key: "region", label: "Region", env: "DR", secret: false },
        ],
      },
      capabilities: [],
      blocks: [],
      pages: [],
      health: [],
    },
  ],
}));

import {
  INTEGRATION_VARIABLE_PLACEHOLDER,
  redactIntegrationVariableNames,
} from "./integration-redaction.js";
import { sanitizeMcpData } from "./sanitize-result.js";

const OPTIONS = {
  requestId: "request-1",
  traceId: "trace-1",
  trust: "external_untrusted" as const,
  maxBytes: 524_288,
};

describe("what a model may not read off a run it did not start", () => {
  it("strips the variable names out of a durable failure reason", () => {
    const reason =
      "Demo is no longer connected, so the run stopped at its next use of it: Set DEMO_API_TOKEN on this deployment, or store the values from the dashboard.";

    const envelope = sanitizeMcpData({ statusReason: reason }, OPTIONS);

    const data = envelope.data as { statusReason: string };
    expect(data.statusReason).not.toContain("DEMO_API_TOKEN");
    expect(data.statusReason).toContain(INTEGRATION_VARIABLE_PLACEHOLDER);
    // The half that still helps: which integration, and what happened to it.
    expect(data.statusReason).toContain("Demo is no longer connected");
    expect(envelope.meta.redactions).toBeGreaterThan(0);
  });

  it("hides the key that would unlock every stored secret", () => {
    const envelope = sanitizeMcpData(
      { message: "Set INTEGRATION_SECRETS_KEY on this deployment to use stored secrets" },
      OPTIONS,
    );

    expect((envelope.data as { message: string }).message).not.toContain(
      "INTEGRATION_SECRETS_KEY",
    );
  });

  it("reaches a name wherever it sits, including an object key", () => {
    const envelope = sanitizeMcpData({ DEMO_BASE_URL: "set" }, OPTIONS);

    expect(Object.keys(envelope.data as object)).toEqual([
      INTEGRATION_VARIABLE_PLACEHOLDER,
    ]);
  });

  it("replaces the longest name first, so no fragment survives", () => {
    // DEMO_BASE_URL contains no other declared name, but DEMO_API_TOKEN and a
    // hypothetical DEMO_API would: the order is what stops "[a deployment
    // variable]_TOKEN" from spelling the rest of the name out.
    expect(redactIntegrationVariableNames("DEMO_API_TOKEN and DEMO_BASE_URL")).toBe(
      `${INTEGRATION_VARIABLE_PLACEHOLDER} and ${INTEGRATION_VARIABLE_PLACEHOLDER}`,
    );
  });

  it("catches a lowercase echo of a name", () => {
    // Provider tooling, log lines and shell transcripts spell a variable
    // whichever way they feel like, and an agent that reads "set demo_api_token"
    // has learned the thing this module exists to withhold.
    const envelope = sanitizeMcpData({ hint: "check demo_api_token and Demo_Base_Url" }, OPTIONS);

    const hint = (envelope.data as { hint: string }).hint;
    expect(hint.toLowerCase()).not.toContain("demo_api_token");
    expect(hint.toLowerCase()).not.toContain("demo_base_url");
  });

  it("leaves a name too short to redact safely alone", () => {
    expect(redactIntegrationVariableNames("a DRY run")).toBe("a DRY run");
  });
});
