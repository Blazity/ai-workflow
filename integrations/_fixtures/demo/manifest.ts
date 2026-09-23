/**
 * The manifest half of the demo integration. It reaches the registries only
 * behind the fixture flag at generation time, so it is free to be richer than
 * the template: later stages connect it on a demo deployment, show its card
 * and render its two pages. Plain data, imported only from
 * @integrations/sdk.
 */
import { defineIntegration, defineIntegrationBlock, z } from "@integrations/sdk";

const echoBlock = defineIntegrationBlock({
  type: "demo_echo",
  // Every parameter has a default, because a new node starts with its
  // defaults and the editor has no form for an integration block's parameters.
  paramsSchema: z.object({ message: z.string().min(1).default("Hello from the demo integration.") }),
  defaults: { message: "Hello from the demo integration." },
  contract: { ports: ["out"], allowsFailurePort: true },
  ui: {
    label: "Demo echo",
    description: "Echoes the message back, tagged with the ticket it ran for.",
    glyph: "D",
    color: "#445566",
    softColor: "#EEF1F4",
  },
  inputs: {
    ticketKey: { required: false, schema: { type: "string" } },
  },
  output: {
    properties: { reply: { type: "string" } },
    required: ["reply"],
    statusVariants: ["ok"],
  },
});

const lookupBlock = defineIntegrationBlock({
  type: "demo_lookup",
  paramsSchema: z.object({
    query: z.string().min(1).default("status"),
    limit: z.number().int().positive().default(10),
  }),
  defaults: { query: "status", limit: 10 },
  contract: { ports: ["out"], allowsFailurePort: true },
  ui: {
    label: "Demo lookup",
    description: "Looks a query up against the demo provider's fixed data.",
    glyph: "L",
    color: "#445566",
    softColor: "#EEF1F4",
  },
  output: {
    properties: { matches: { type: "number" }, summary: { type: "string" } },
    required: ["summary"],
    statusVariants: ["found", "nothing_found"],
  },
  requires: { capabilities: ["messaging"] },
});

export const manifest = defineIntegration({
  id: "demo",
  name: "Demo",
  description: "A self-contained, deterministic provider used only for tests and demos.",
  docsUrl: "https://example.com/demo/docs",
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
  capabilities: ["messaging"],
  blocks: [echoBlock, lookupBlock],
  pages: [
    { id: "overview", label: "Overview" },
    { id: "activity", label: "Activity" },
  ],
  health: [
    { id: "auth", label: "Token accepted", description: "The demo provider accepts the API token.", critical: true },
    { id: "delivery", label: "Message delivered", description: "The last message was recorded.", critical: false },
  ],
});
