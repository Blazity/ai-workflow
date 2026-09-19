/**
 * The manifest half of this package's fixture integration: one integration
 * that serves all three ported capabilities, for a provider core has never
 * heard of. `fixture-runtime.ts` implements it. Together they are the type
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
    query: z.string().min(1),
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
  capabilities: ["issue_tracker", "vcs", "messaging"],
  blocks: [researchBlock, pingBlock],
  pages: [{ id: "overview", label: "Overview" }],
  health: [
    { id: "auth", label: "Token accepted", description: "The provider accepts the API token.", critical: true },
    { id: "webhook", label: "Webhook delivered", description: "The last delivery arrived.", critical: false },
  ],
});
