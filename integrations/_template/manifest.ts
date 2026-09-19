/**
 * The manifest half of the example integration. Copy this whole directory to
 * add a real one; see README.md for the exact steps. Everything here is plain
 * data, imported only from @integrations/sdk: no Node module, no relative
 * import outside this package, because the dashboard and the Workflow
 * DevKit's flow bundle read this file too.
 */
import { defineIntegration, defineIntegrationBlock, z } from "@integrations/sdk";

const pingBlock = defineIntegrationBlock({
  // <id>_<name> in snake_case. Rename both when you copy this.
  type: "example_ping",
  paramsSchema: z.object({ message: z.string().min(1) }),
  contract: { ports: ["out"], allowsFailurePort: true },
  ui: {
    label: "Example ping",
    description: "Sends a message to the example provider and echoes its reply.",
    glyph: "E",
    color: "#445566",
    softColor: "#EEF1F4",
  },
  output: {
    properties: { reply: { type: "string" } },
    required: ["reply"],
    statusVariants: ["ok"],
  },
});

export const manifest = defineIntegration({
  id: "example",
  name: "Example",
  description: "A minimal integration skeleton, meant to be copied rather than connected.",
  docsUrl: "https://example.com/docs",
  connection: {
    fields: [
      { key: "baseUrl", label: "Site URL", description: "Where the provider's API lives.", env: "EXAMPLE_BASE_URL", secret: false, format: "url" },
      { key: "apiToken", label: "API token", description: "Used to authenticate every request.", env: "EXAMPLE_API_TOKEN", secret: true },
    ],
  },
  // A real integration lists the capabilities it serves here (see
  // INTEGRATION_CAPABILITIES in @integrations/sdk); each one needs a matching
  // adapter factory under `capabilities` in worker.ts.
  capabilities: [],
  blocks: [pingBlock],
  // Every page declared here needs a component of the same id in dashboard.tsx,
  // and every component there needs a page declared here. Declare no pages and
  // delete dashboard.tsx if this integration brings no screens of its own.
  pages: [{ id: "overview", label: "Overview" }],
  health: [{ id: "auth", label: "Token accepted", description: "The provider accepts the API token.", critical: true }],
});
