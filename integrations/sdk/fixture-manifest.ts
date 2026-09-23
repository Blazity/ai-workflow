/**
 * The manifest half of this package's fixture integrations: one that serves
 * four capabilities (issue tracking, version control, messaging and agent
 * tracing) for a provider core has never heard of, and one that only traces. `fixture-runtime.ts` implements it. Together they are the type
 * evidence that the contract is usable (the package typecheck compiles them)
 * and the runtime evidence that conformance accepts a real integration.
 *
 * Plain data, importing only the SDK root: a browser bundle of this file is
 * how the root entry is shown to reach no Node module.
 */
import { defineIntegration, defineIntegrationBlock, z } from "./index";

export const researchBlock = defineIntegrationBlock({
  type: "sdkfixture_research",
  paramsSchema: z.object({
    query: z.string().min(1).default("recent incidents"),
    lookbackDays: z.number().int().positive().default(30),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  contract: { ports: ["out"], allowsFailurePort: true },
  ui: {
    label: "Fixture research",
    description: "Searches the fixture provider and summarises what it finds.",
    glyph: "F",
    color: "#445566",
    softColor: "#EEF1F4",
  },
  inputs: {
    ticketKey: { required: true, schema: { type: "string" } },
    repository: { required: false, schema: { type: "string" } },
  },
  output: {
    properties: {
      summary: { type: "string" },
      matches: { type: "number" },
    },
    required: ["summary"],
    statusVariants: ["found", "nothing_found"],
  },
  requires: { capabilities: ["issue_tracker", "vcs", "messaging"], llm: true },
});

export const pingBlock = defineIntegrationBlock({
  type: "sdkfixture_ping",
  paramsSchema: z.object({}).strict(),
  contract: { ports: ["out"], allowsFailurePort: false },
  ui: {
    label: "Fixture ping",
    description: "Checks the fixture provider answers.",
    glyph: "P",
    color: "#445566",
    softColor: "#EEF1F4",
  },
  output: { properties: {}, statusVariants: ["ok"] },
});

export const fixtureManifest = defineIntegration({
  id: "sdkfixture",
  name: "SDK fixture",
  description: "A provider core has never heard of, serving every ported capability.",
  docsUrl: "https://example.com/sdkfixture",
  connection: {
    fields: [
      { key: "baseUrl", label: "Site URL", env: "SDKFIXTURE_BASE_URL", secret: false, format: "url" },
      { key: "apiToken", label: "API token", env: "SDKFIXTURE_API_TOKEN", secret: true },
      { key: "projectKey", label: "Project key", env: "SDKFIXTURE_PROJECT_KEY", secret: false },
      { key: "appId", label: "App id", env: "SDKFIXTURE_APP_ID", secret: false, format: "integer" },
      {
        key: "privateKey",
        label: "Private key",
        env: "SDKFIXTURE_PRIVATE_KEY",
        secret: true,
        format: "multiline",
      },
      { key: "botLogin", label: "Bot login", env: "SDKFIXTURE_BOT_LOGIN", secret: false, optional: true },
      {
        key: "host",
        label: "Host",
        env: "SDKFIXTURE_HOST",
        secret: false,
        optional: true,
        default: "https://sdkfixture.example",
        format: "url",
      },
    ],
  },
  capabilities: ["issue_tracker", "vcs", "messaging", "agent_tracing"],
  blocks: [researchBlock, pingBlock],
  pages: [{ id: "overview", label: "Overview" }],
  // This provider cannot be asked twice for the same bucket, so it takes a
  // handle created once for the run. The second fixture below is the foil: a
  // tracing provider that needs none.
  runState: true,
  health: [
    { id: "auth", label: "Token accepted", description: "The provider accepts the API token.", critical: true },
    { id: "webhook", label: "Webhook delivered", description: "The last delivery arrived.", critical: false },
  ],
});

/**
 * The foil: a tracing provider shaped nothing like the first one. It needs no
 * per-run handle, installs nothing, writes no file and registers no hook. A
 * few variables for a harness that exports OpenTelemetry itself are the whole
 * of it, one of them carrying the run id so a trace can be found from a run.
 *
 * It exists so that `agent_tracing` cannot quietly acquire a requirement only
 * the first provider can meet: the day the port demands a run handle, a file
 * or a hook, this stops compiling.
 */
export const otelFixtureManifest = defineIntegration({
  id: "sdkfixtureotel",
  name: "SDK fixture collector",
  description: "A tracing provider that needs nothing but an endpoint and a key.",
  connection: {
    fields: [
      {
        key: "endpoint",
        label: "OTLP endpoint",
        env: "SDKFIXTUREOTEL_ENDPOINT",
        secret: false,
        format: "url",
      },
      { key: "apiKey", label: "API key", env: "SDKFIXTUREOTEL_API_KEY", secret: true },
    ],
  },
  capabilities: ["agent_tracing"],
  blocks: [],
  pages: [],
  health: [
    {
      id: "collector",
      label: "Collector reachable",
      description: "The collector answers at the endpoint.",
      critical: true,
    },
  ],
});
