/**
 * What core may know about this integration without running any of its code.
 *
 * The editor, the dashboard, the health page and the Workflow DevKit's flow
 * bundle all read this file, so it is plain data: it imports
 * `@integrations/sdk` and files inside this package, and nothing else. A Node
 * module or a provider SDK here fails the Vercel build of the flow bundle, and
 * `pnpm run gen:integrations` refuses it before that.
 *
 * docs/architecture/integrations.md walks every field below.
 */
import { defineIntegration, defineIntegrationBlock, z } from "@integrations/sdk";

export const lookupBlock = defineIntegrationBlock({
  // `<integration id>_<name>`. Every workflow that uses the block stores this
  // string, so renaming it after a release orphans them.
  type: "example_lookup",
  // The editor has no form for an integration block's parameters yet. What an
  // author has to choose therefore arrives as an input they bind (`query`
  // below), and a parameter carries only what has a sensible default, written
  // twice: in the schema, and in `defaults`, which is what a new node starts
  // with.
  paramsSchema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
  defaults: { limit: 10 },
  // One port, named `out`. A workflow branches on `status` instead.
  contract: { ports: ["out"], allowsFailurePort: true },
  // How the block looks in the editor's palette. The scaffold sets the glyph
  // to your name's initial; choose colours of your own too.
  ui: {
    label: "Example lookup",
    description: "Searches Example and reports what it found.",
    glyph: "E",
    color: "#445566",
    softColor: "#EEF1F4",
  },
  inputs: {
    query: { required: true, schema: { type: "string" } },
  },
  output: {
    properties: {
      summary: { type: "string" },
      matches: { type: "number" },
    },
    required: ["summary", "matches"],
    // Stored graphs branch on these words, so adding, removing or renaming one
    // after a release changes which branch a published workflow takes.
    statusVariants: ["found", "nothing_found"],
  },
});

export const manifest = defineIntegration({
  id: "example",
  name: "Example",
  description: "One line: what a deployment gets by connecting Example.",
  docsUrl: "https://example.com/docs",
  // The mark beside the name. A licensed glyph ({ glyph, color }, Simple Icons
  // is CC0) or, with no license-safe mark, a monogram on the brand's colour.
  icon: { monogram: "EX", color: "#181B20" },
  connection: {
    fields: [
      {
        key: "baseUrl",
        label: "API URL",
        description: "Where the Example API answers, such as https://api.example.com.",
        env: "EXAMPLE_BASE_URL",
        secret: false,
        format: "url",
      },
      {
        key: "apiToken",
        label: "API token",
        description: "A token for the account this deployment acts as.",
        env: "EXAMPLE_API_TOKEN",
        secret: true,
      },
    ],
  },
  // The capabilities this integration serves, each with an adapter factory
  // under `capabilities` in worker.ts. None here: the template serves a block.
  capabilities: [],
  blocks: [lookupBlock],
  // Every page here needs a component of the same id in dashboard.tsx. Declare
  // none, and delete dashboard.tsx, if the integration has no screen of its own.
  pages: [{ id: "overview", label: "Overview" }],
  health: [
    {
      id: "api",
      label: "API access",
      description: "Example accepts the API token and names the account it belongs to.",
      critical: true,
    },
  ],
});
