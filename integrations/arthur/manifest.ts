/**
 * Arthur Engine: traces of what the agents did, continuous evaluation of it,
 * and a prompt-injection screen over untrusted text.
 *
 * Plain data, imported only from @integrations/sdk. The two environment
 * variables are the ones this product has always read, so a deployment that
 * configured Arthur before this package existed keeps working with nothing to
 * do.
 */
import { defineIntegration, defineIntegrationBlock, z } from "@integrations/sdk";

export const injectionCheckBlock = defineIntegrationBlock({
  type: "arthur_injection_check",
  paramsSchema: z.object({}).strict(),
  contract: { ports: ["out"], allowsFailurePort: true },
  ui: {
    label: "Prompt injection check",
    description: "Screens untrusted content for prompt injection before an agent reads it.",
    glyph: "◬",
    color: "#8b6f8f",
    softColor: "#F3F0F4",
  },
  defaults: {},
  inputs: {
    // Left unbound, it screens what this check has always screened: the
    // description and every comment of whatever the run is about, which is
    // where an injection is easiest to plant. A graph published before the
    // block moved binds nothing and keeps working; binding it narrows or
    // widens the text on purpose. A run whose subject core composed rather
    // than received (a pull request with no ticket, a schedule occurrence) has
    // no such text, so publishing refuses an unbound input under those
    // triggers and the block refuses at run time.
    content: {
      required: true,
      schema: { type: "string" },
      defaultFromSubject: ["description", "comments"],
    },
  },
  output: {
    properties: {
      findings: { type: "array", items: { type: "unknown" } },
      backend: { type: "string" },
      reason: { type: "string" },
    },
    required: ["backend", "findings"],
    // Two verdicts and no third. A screen that can report "I did not look" is
    // a screen a graph can be built to ignore, which is the defect AIW-294
    // names: when Arthur cannot be asked, the run stops instead.
    statusVariants: ["ok", "flagged"],
    // The block reports and continues, so a graph that never reads the
    // verdict would hand a flagged prompt to the next agent. Publishing
    // refuses such a graph, naming this node.
    mustRead: ["status"],
  },
});

export const manifest = defineIntegration({
  id: "arthur",
  name: "Arthur Engine",
  description:
    "Traces every agent run, grades it continuously, and screens untrusted text for prompt injection.",
  docsUrl: "https://docs.arthur.ai/",
  connection: {
    fields: [
      {
        key: "traceEndpoint",
        label: "Trace endpoint",
        description:
          "The full traces URL of your engine, ending in /api/v1/traces. The task API is read from the same host, so this one value says which engine this deployment talks to.",
        env: "GENAI_ENGINE_TRACE_ENDPOINT",
        secret: false,
        format: "url",
      },
      {
        key: "apiKey",
        label: "API key",
        description: "A key with access to the tasks and traces of that engine.",
        env: "GENAI_ENGINE_API_KEY",
        secret: true,
      },
    ],
  },
  capabilities: ["agent_tracing"],
  blocks: [injectionCheckBlock],
  pages: [{ id: "evals", label: "Evals" }],
  health: [
    {
      id: "api",
      label: "Task API",
      description: "The engine accepts the API key on the endpoint this deployment names.",
      critical: true,
    },
  ],
  // The task API numbers a second task for a name that already exists, so a
  // run that asked twice would scatter itself over two buckets. One task per
  // run, created at the run's first use of Arthur.
  runState: true,
});
