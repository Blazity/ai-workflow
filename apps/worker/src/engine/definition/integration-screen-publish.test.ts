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
 * Publish.
 *
 * The text it screens needs no binding when the block names a default from the
 * run's subject, so a graph drawn as "ticket trigger, screen" publishes as it
 * always did. Under a trigger whose runs have no ticket there is no such text:
 * core composes the description, screening it finds nothing every time, and
 * that is refused here rather than discovered by a run.
 *
 * And a verdict nobody acts on protects nothing: "check, then agent" hands the
 * agent the flagged text, and so does "check, then branch, then agent" when
 * both of the branch's answers lead to the same agent. So the shape is what is
 * required, not a mention: a Branch on the verdict first on every path out,
 * and two answers that go somewhere different.
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

const integrations = withVersionControl(
  deploymentIntegrations({
    manifests: [screen],
    states: new Map([["acmescreen", connected]]),
  }),
);

/** The graphs here reach version control, which a connected GitHub serves. */
function withVersionControl(deployment: ReturnType<typeof deploymentIntegrations>) {
  return { ...deployment, providers: new Map([...deployment.providers, ["vcs", ["github"]]]) };
}

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

const branchOnStatus = node("verdict", "branch", {
  combinator: "all",
  conditions: [{ reference: "steps.check.output.status", operator: "equals", value: "flagged" }],
});

/** The shape definition 28 has on production: screen, then branch on the verdict. */
const branching = {
  nodes: [trigger, check, branchOnStatus, stop, done],
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

describe("a screen's text comes from the run's subject unless the author binds it", () => {
  it("publishes with the text input unbound, because the block names where it comes from", () => {
    expect(issuesFor(branching)).toEqual([]);
  });

  it("refuses under a trigger whose runs carry no ticket, naming the input and the trigger", () => {
    // A pull request run without a ticket key gets a description core wrote
    // (the pull request URL and head), and the pull request's own body and
    // review comments, which are the untrusted text on that trigger, are not
    // in the subject at all. An unbound screen there reports "ok" on our own
    // sentence, and the author believes it looked.
    const onPullRequest = {
      ...branching,
      nodes: [node("pr", "trigger_pr_review"), ...branching.nodes.slice(1)],
      edges: [{ id: "t-c", from: "pr", to: "check" }, ...branching.edges.slice(1)],
    };

    const issues = issuesFor(onPullRequest).filter(
      (issue) => issue.code === "binding.subject_default",
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ nodeId: "check" });
    expect(issues[0]!.message).toContain('"content"');
    expect(issues[0]!.message).toContain('"pr"');
    expect(issues[0]!.message).toContain("trigger_pr_review");
  });

  it("publishes the same graph once the author binds the text", () => {
    const bound = {
      ...branching,
      nodes: [
        node("pr", "trigger_pr_review"),
        { ...check, inputs: { content: { kind: "literal", value: "the diff" } } },
        ...branching.nodes.slice(2),
      ],
      edges: [{ id: "t-c", from: "pr", to: "check" }, ...branching.edges.slice(1)],
    };

    expect(issuesFor(bound)).toEqual([]);
  });

  it("publishes unbound under a webhook trigger, whose text is what the sender sent", () => {
    const onDelivery = {
      ...branching,
      nodes: [
        node("hook", "trigger_webhook", {
          endpointId: "0123456789abcdef0123456789abcdef",
          auth: { scheme: "shared_token" },
        }),
        ...branching.nodes.slice(1),
      ],
      edges: [{ id: "t-c", from: "hook", to: "check" }, ...branching.edges.slice(1)],
    };

    expect(
      issuesFor(onDelivery).filter((issue) => issue.code === "binding.subject_default"),
    ).toEqual([]);
  });

  it("still refuses an unbound required input that names no default", () => {
    const block = screen.blocks[0]!;
    const withoutDefault: IntegrationManifest = {
      ...screen,
      blocks: [{ ...block, inputs: { content: { required: true, schema: { type: "string" } } } }],
    };
    const plain = withVersionControl(
      deploymentIntegrations({
        manifests: [withoutDefault],
        states: new Map([["acmescreen", connected]]),
      }),
    );
    const parsed = parse({ schemaVersion: 2, ...branching });
    const definition = parsed.definition!;
    const resolveContract = createWorkflowBlockContractResolver({
      agentProviders: { claude: true, codex: true },
      llmProviders: { claude: true, codex: true },
      defaultAgent: { provider: "claude", model: "claude-sonnet-4-5" },
      vcsProviders: ["github"],
      vcsBotIdentities: ["github"],
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

describe("a verdict the graph must act on", () => {
  it("refuses to publish a graph where the next node is not a decision, naming it and the way out", () => {
    const issues = issuesFor(unread);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "output.unread", nodeId: "check" });
    expect(issues[0]!.message).toContain('"check"');
    expect(issues[0]!.message).toContain("steps.check.output.status");
    expect(issues[0]!.message).toContain("Branch");
  });

  it("does not count a Transform that merely mentions the verdict as acting on it", () => {
    // It formats the verdict into a sentence and the run walks on with the
    // flagged text in hand. A mention is not a decision.
    const mentioned = {
      nodes: [
        trigger,
        check,
        node("note", "transform", {
          operation: "format_text",
          template: "Verdict: {{data:steps.check.output.status}}",
        }),
        done,
      ],
      edges: [
        { id: "t-c", from: "trigger", to: "check" },
        { id: "c-n", from: "check", to: "note" },
        { id: "n-d", from: "note", to: "done" },
      ],
    };

    expect(issuesFor(mentioned).map((issue) => issue.code)).toContain("output.unread");
  });

  it("does not count a Branch the agent has already run before as acting on it", () => {
    // The screen flags, the agent reads the text anyway, and two nodes later a
    // Branch asks about the verdict. Reading the field somewhere is not the
    // same as deciding before anything else reads the text.
    const late = {
      nodes: [
        trigger,
        check,
        node("agent", "generic_agent", { prompt: "Do the work." }),
        node("verdict", "branch", {
          combinator: "all",
          conditions: [
            { reference: "steps.check.output.status", operator: "equals", value: "flagged" },
          ],
        }),
        stop,
        done,
      ],
      edges: [
        { id: "t-c", from: "trigger", to: "check" },
        { id: "c-a", from: "check", to: "agent" },
        { id: "a-v", from: "agent", to: "verdict" },
        { id: "v-stop", from: "verdict", fromPort: "true", to: "stop" },
        { id: "v-done", from: "verdict", fromPort: "false", to: "done" },
      ],
    };

    expect(issuesFor(late).map((issue) => issue.code)).toContain("output.unread");
  });

  it("refuses a Branch whose two answers reach the same nodes, in those terms", () => {
    const pointless = {
      nodes: [trigger, check, branchOnStatus, done],
      edges: [
        { id: "t-c", from: "trigger", to: "check" },
        { id: "c-v", from: "check", to: "verdict" },
        { id: "v-true", from: "verdict", fromPort: "true", to: "done" },
        { id: "v-false", from: "verdict", fromPort: "false", to: "done" },
      ],
    };

    const issues = issuesFor(pointless).filter((issue) => issue.code === "output.unread");

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ nodeId: "verdict" });
    expect(issues[0]!.message).toContain("decides nothing");
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
