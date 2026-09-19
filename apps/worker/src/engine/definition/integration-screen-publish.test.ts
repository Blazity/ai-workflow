import { describe, expect, it } from "vitest";
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState, WorkflowDefinition } from "@shared/contracts";
import { analyzeWorkflowValues, parse } from "@shared/workflow-graph";
import { z } from "zod";
import { createWorkflowBlockContractResolver } from "./block-contract-resolver.js";
import { blockParamsSchemasFor } from "./block-params-schemas.js";
import { validateWorkflowDefinitionIssuesForDeployment } from "./deployment-validation.js";
import { deploymentIntegrations } from "./integration-availability.js";
import { JSON_SCHEMA_SUPPORT } from "./json-schema-support.js";

/**
 * Publishing a workflow that screens untrusted text before an agent reads it.
 *
 * Two promises a screen makes, held where an author meets them, which is
 * Publish. The text it screens needs no binding when the block names a default
 * from the run's ticket, so a graph drawn as "trigger, screen" publishes as it
 * always did. And a verdict nobody reads protects nothing: "check, then agent"
 * with no branch would hand a flagged prompt to the agent, so the block
 * declares its verdict as something the graph must read, and a graph that does
 * not is refused naming the node.
 */

const screen: IntegrationManifest = {
  id: "acmescreen",
  name: "Acme Screen",
  description: "A provider core has never heard of.",
  connection: { fields: [] },
  capabilities: [],
  blocks: [
    {
      type: "acmescreen_check",
      paramsSchema: z.object({}).strict(),
      contract: { ports: ["out"], allowsFailurePort: true },
      ui: {
        label: "Screen",
        description: "Screens text.",
        glyph: "S",
        color: "#445566",
        softColor: "#EEF1F4",
      },
      defaults: {},
      inputs: {
        content: {
          required: true,
          schema: { type: "string" },
          defaultFromSubject: ["description", "comments"],
        },
      },
      output: {
        properties: { backend: { type: "string" } },
        required: ["backend"],
        statusVariants: ["ok", "flagged"],
        mustRead: ["status"],
      },
    },
  ],
  pages: [],
  health: [],
};

const connected: IntegrationState = {
  integrationId: "acmescreen",
  enabled: true,
  source: "environment",
  status: "connected",
  connection: "connected",
  verification: { state: "never_tested" },
  failure: null,
  usable: true,
  environment: { setVariables: [], missingVariables: [], complete: true },
  stored: { latestVersion: 0, activeVersion: null, missingFields: [], complete: false, prepared: null },
  pin: { integrationId: "acmescreen", configFingerprint: "aaaaaaaaaaaa" },
  secretsKeyAvailable: true,
};

const integrations = deploymentIntegrations({
  manifests: [screen],
  states: new Map([["acmescreen", connected]]),
});

function node(id: string, type: string, configuration: Record<string, unknown> = {}) {
  return { id, type, x: 0, y: 0, configuration, inputs: {}, additionalInputs: [] };
}

const trigger = node("trigger", "trigger_ticket_ai");
const check = node("check", "acmescreen_check");
const done = node("done", "terminate", { terminalStatus: "done" });
const stop = node("stop", "terminate", { terminalStatus: "failed" });

function issuesFor(
  graph: { nodes: unknown[]; edges: unknown[] },
  options: { checkEnvironmentAvailability?: boolean } = {},
): Array<{ code: string; nodeId: string | null; message: string }> {
  const parsed = parse({ schemaVersion: 2, ...graph });
  if (!parsed.definition) throw new Error(`did not parse: ${JSON.stringify(parsed)}`);
  const definition: WorkflowDefinition = parsed.definition;
  const resolveContract = createWorkflowBlockContractResolver({
    agentProviders: { claude: true, codex: true },
    llmProviders: { claude: true, codex: true },
    defaultAgent: { provider: "claude", model: "claude-sonnet-4-5" },
    vcsProviders: ["github"],
    vcsBotIdentities: ["github"],
    slackConfigured: true,
    webhookTriggerConfigured: true,
    integrations,
  });
  return validateWorkflowDefinitionIssuesForDeployment(
    definition,
    resolveContract,
    blockParamsSchemasFor(integrations),
    ["github"],
    analyzeWorkflowValues(definition, resolveContract, JSON_SCHEMA_SUPPORT),
    options,
  ).map((issue) => ({ code: issue.code, nodeId: issue.nodeId, message: issue.message }));
}

/** The shape definition 28 has on production: screen, then branch on the verdict. */
const branching = {
  nodes: [
    trigger,
    check,
    node("verdict", "branch", {
      combinator: "all",
      conditions: [{ reference: "steps.check.output.status", operator: "equals", value: "flagged" }],
    }),
    stop,
    done,
  ],
  edges: [
    { id: "t-c", from: "trigger", to: "check" },
    { id: "c-v", from: "check", to: "verdict" },
    { id: "v-stop", from: "verdict", fromPort: "true", to: "stop" },
    { id: "v-done", from: "verdict", fromPort: "false", to: "done" },
  ],
};

/** "Check, then carry on": the verdict is computed and nothing looks at it. */
const unread = {
  nodes: [trigger, check, done],
  edges: [
    { id: "t-c", from: "trigger", to: "check" },
    { id: "c-d", from: "check", to: "done" },
  ],
};

describe("a screen's text comes from the ticket unless the author binds it", () => {
  it("publishes with the text input unbound, because the block names where it comes from", () => {
    expect(issuesFor(branching)).toEqual([]);
  });

  it("still refuses an unbound required input that names no default", () => {
    const block = screen.blocks[0]!;
    const withoutDefault: IntegrationManifest = {
      ...screen,
      blocks: [{ ...block, inputs: { content: { required: true, schema: { type: "string" } } } }],
    };
    const plain = deploymentIntegrations({
      manifests: [withoutDefault],
      states: new Map([["acmescreen", connected]]),
    });
    const parsed = parse({ schemaVersion: 2, ...branching });
    const definition = parsed.definition!;
    const resolveContract = createWorkflowBlockContractResolver({
      agentProviders: { claude: true, codex: true },
      llmProviders: { claude: true, codex: true },
      defaultAgent: { provider: "claude", model: "claude-sonnet-4-5" },
      vcsProviders: ["github"],
      vcsBotIdentities: ["github"],
      slackConfigured: true,
      webhookTriggerConfigured: true,
      integrations: plain,
    });
    const codes = validateWorkflowDefinitionIssuesForDeployment(
      definition,
      resolveContract,
      blockParamsSchemasFor(plain),
      ["github"],
      analyzeWorkflowValues(definition, resolveContract, JSON_SCHEMA_SUPPORT),
    ).map((issue) => issue.code);
    expect(codes).toContain("binding.required");
  });
});

describe("a verdict the graph must read", () => {
  it("refuses to publish a graph where nothing reads it, naming the node and the way out", () => {
    const issues = issuesFor(unread);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "output.unread", nodeId: "check" });
    expect(issues[0]!.message).toContain('"check"');
    expect(issues[0]!.message).toContain("steps.check.output.status");
    expect(issues[0]!.message).toContain("Branch");
  });

  it("counts a binding into another block as reading it, not only a Branch", () => {
    const bound = {
      nodes: [
        trigger,
        check,
        {
          ...node("note", "transform", {
            operation: "format_text",
            template: "Verdict: {{data:steps.check.output.status}}",
          }),
        },
        done,
      ],
      edges: [
        { id: "t-c", from: "trigger", to: "check" },
        { id: "c-n", from: "check", to: "note" },
        { id: "n-d", from: "note", to: "done" },
      ],
    };
    expect(issuesFor(bound).filter((issue) => issue.code === "output.unread")).toEqual([]);
  });

  it("does not count reading a different field as reading the verdict", () => {
    const wrongField = structuredClone(branching);
    (wrongField.nodes[2]!.configuration as { conditions: Array<Record<string, unknown>> }).conditions = [
      { reference: "steps.check.output.backend", operator: "equals", value: "local_prefilter" },
    ];
    expect(issuesFor(wrongField).map((issue) => issue.code)).toContain("output.unread");
  });

  it("leaves a graph published before the rule runnable: a run load does not re-litigate it", () => {
    expect(
      issuesFor(unread, { checkEnvironmentAvailability: false }).map((issue) => issue.code),
    ).not.toContain("output.unread");
  });
});
