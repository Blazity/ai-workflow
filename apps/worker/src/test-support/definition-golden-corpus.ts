/**
 * The corpus behind the deployment-issue golden fixture.
 *
 * Two halves. The first is every workflow definition this repository stores as
 * data: the eight scenario snapshots and the nine templates across the option
 * matrix that changes their shape. Those are the graphs production actually
 * ships, and they validate clean, so on their own they would prove only that
 * nothing started failing.
 *
 * The second half is what makes the fixture worth committing. The stage that
 * splits the rules apart has to keep the same issues in the same ORDER with the
 * same messages, and order is observable only when several rule families report
 * on one graph at once. So each broken fixture below trips a named family, and
 * several trip more than one on purpose, which pins the sequence the composing
 * entry point splices them in: graph, configuration, block deployment, schedule
 * reachability, available values, branch conditions, transform references,
 * workspace access, repository scope.
 *
 * Determinism is a requirement, not a nicety: the fixture is compared byte for
 * byte. The registry contexts are declared here rather than read from the
 * environment, the cron expressions are ones whose verdict cannot depend on the
 * instant the suite runs (an every-minute schedule is below the minimum period
 * on every day; February 30th never occurs on any), and the file listing is
 * sorted.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  HarnessProvider,
  JsonValue,
  WorkflowBlockType,
  WorkflowDefinition,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2ControlEdge,
  WorkflowDefinitionV2Node,
  WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import { builtinHarnessProfileReference } from "@shared/harness";
import type { WorkflowBlockRegistryContext } from "../engine/definition/block-contract-resolver.js";
import { workflowDefinitionV2Schema } from "@shared/workflow-graph";
import { workflowDefinitionTemplates } from "../workflow-definition/templates.js";
import { testBlockData, testDeploymentIssues } from "./block-contracts.js";

/** Everything configured, so a fixture reports only what its graph earns. */
const fullContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

/** Nothing configured, which is the only way to observe the availability rule
 *  that reads the block contract resolver. */
const bareContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: false, codex: false },
  llmProviders: { claude: false, codex: false },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: [],
  vcsBotIdentities: [],
  slackConfigured: false,
  arthurConfigured: false,
  webhookTriggerConfigured: false,
};

const contexts = { full: fullContext, bare: bareContext } as const;
type ContextName = keyof typeof contexts;

interface CorpusEntry {
  fixture: string;
  definition: WorkflowDefinition;
  context: ContextName;
  /** Mirrors the option the run loader passes; `undefined` keeps the default. */
  checkEnvironmentAvailability?: false;
}

function node(
  id: string,
  type: WorkflowBlockType,
  extra: Partial<Omit<WorkflowDefinitionV2Node, "id" | "type">> = {},
): WorkflowDefinitionV2Node {
  return {
    id,
    type,
    x: 0,
    y: 0,
    configuration: {},
    inputs: {},
    additionalInputs: [],
    ...extra,
  };
}

function edge(
  from: string,
  to: string,
  fromPort?: string,
): WorkflowDefinitionV2ControlEdge {
  return {
    id: `${from}->${to}${fromPort ? `:${fromPort}` : ""}`,
    from,
    to,
    ...(fromPort ? { fromPort } : {}),
  };
}

function graph(
  nodes: WorkflowDefinitionV2Node[],
  edges: WorkflowDefinitionV2ControlEdge[],
  repositoryScope?: WorkflowDefinitionV2["repositoryScope"],
): WorkflowDefinitionV2 {
  return {
    schemaVersion: 2,
    nodes,
    edges,
    ...(repositoryScope ? { repositoryScope } : {}),
  };
}

const ticket = () => node("ticket", "trigger_ticket_ai");
const done = () => node("done", "terminate", { configuration: { terminalStatus: "done" } });

function snapshotDefinitions(): CorpusEntry[] {
  const directory = resolve(
    import.meta.dirname,
    "../workflow-definition/scenarios/snapshots",
  );
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      fixture: `snapshot/${file}`,
      definition: workflowDefinitionV2Schema.parse(
        JSON.parse(readFileSync(resolve(directory, file), "utf8")),
      ) as WorkflowDefinition,
      context: "full" as const,
    }));
}

function templateDefinitions(): CorpusEntry[] {
  const matrix: Array<{
    label: string;
    includeReview: boolean;
    includeLeakReview: boolean;
    provider: HarnessProvider;
  }> = [
    { label: "review", includeReview: true, includeLeakReview: false, provider: "claude" },
    { label: "no-review", includeReview: false, includeLeakReview: false, provider: "claude" },
    { label: "leak-review", includeReview: true, includeLeakReview: true, provider: "claude" },
    { label: "codex", includeReview: true, includeLeakReview: false, provider: "codex" },
  ];
  const entries: CorpusEntry[] = [];
  for (const options of matrix) {
    for (const template of workflowDefinitionTemplates(options)) {
      entries.push({
        fixture: `template/${options.label}/${template.id}`,
        definition: template.definition as WorkflowDefinition,
        context: "full",
      });
    }
  }
  return entries;
}

/** One template read back with the environment check off, which is the shape
 *  the run loader validates. */
function runLoadDefinitions(): CorpusEntry[] {
  const [template] = workflowDefinitionTemplates({ includeReview: true });
  return [
    {
      fixture: "run-load/ticket-workflow (no environment check)",
      definition: template.definition as WorkflowDefinition,
      context: "bare",
      checkEnvironmentAvailability: false,
    },
    {
      fixture: "run-load/ticket-workflow (environment checked)",
      definition: template.definition as WorkflowDefinition,
      context: "bare",
    },
  ];
}

function brokenDefinitions(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  const add = (
    fixture: string,
    definition: WorkflowDefinitionV2,
    context: ContextName = "full",
  ) => {
    entries.push({ fixture, definition: definition as WorkflowDefinition, context });
  };

  add(
    "graph/reserved-and-unaddressable-ids",
    graph(
      [
        node("entry", "trigger_ticket_ai"),
        node("1bad", "terminate", { configuration: { terminalStatus: "done" } }),
      ],
      [edge("entry", "1bad")],
    ),
  );

  add(
    "graph/duplicate-node-id",
    graph(
      [
        ticket(),
        node("twin", "terminate", { configuration: { terminalStatus: "done" } }),
        node("twin", "terminate", { configuration: { terminalStatus: "failed" } }),
      ],
      [edge("ticket", "twin")],
    ),
  );

  add("graph/no-trigger", graph([done()], []));

  add(
    "graph/edge-endpoints",
    graph(
      [ticket(), done()],
      [
        { id: "same", from: "ticket", to: "done" },
        { id: "same", from: "ticket", to: "done" },
        { id: "unknown-source", from: "ghost", to: "done" },
        { id: "unknown-target", from: "ticket", to: "phantom" },
        { id: "self", from: "done", to: "done" },
      ],
    ),
  );

  add(
    "graph/ports",
    graph(
      [
        ticket(),
        node("decide", "branch", {
          configuration: { combinator: "all", conditions: [] },
        }),
        done(),
      ],
      [
        edge("ticket", "decide"),
        { id: "failure", from: "decide", to: "done", fromPort: "failed" },
        { id: "unknown-port", from: "decide", to: "done", fromPort: "maybe" },
        { id: "unspecified-port", from: "decide", to: "done" },
        { id: "terminal-out", from: "done", to: "decide" },
      ],
    ),
  );

  add(
    "graph/branch-ports-unconnected",
    graph(
      [
        ticket(),
        node("decide", "branch", {
          configuration: {
            combinator: "all",
            conditions: [
              { reference: "steps.entry.output.ticket.key", operator: "has_value" },
            ],
          },
        }),
      ],
      [edge("ticket", "decide")],
    ),
  );

  add(
    "graph/loop-ports-and-back-edge",
    graph(
      [
        ticket(),
        node("retry", "loop", {
          configuration: { maxAttempts: 2, onExhaust: "continue" },
        }),
        done(),
      ],
      [edge("ticket", "retry"), edge("retry", "done", "continue")],
    ),
  );

  add(
    "graph/cycle-without-loop",
    graph(
      [
        ticket(),
        node("first", "post_ticket_comment", { configuration: { body: "a" } }),
        node("second", "post_ticket_comment", { configuration: { body: "b" } }),
      ],
      [edge("ticket", "first"), edge("first", "second"), edge("second", "first")],
    ),
  );

  add(
    "graph/two-loops-and-finalize-in-cycle",
    graph(
      [
        ticket(),
        node("outer", "loop", { configuration: { maxAttempts: 2, onExhaust: "fail" } }),
        node("inner", "loop", { configuration: { maxAttempts: 2, onExhaust: "fail" } }),
        node("finalize", "finalize_workspace"),
      ],
      [
        edge("ticket", "outer"),
        edge("outer", "inner", "continue"),
        edge("inner", "finalize", "continue"),
        edge("finalize", "outer"),
      ],
    ),
  );

  add(
    "graph/unreachable-block",
    graph([ticket(), done(), node("orphan", "post_ticket_comment", {
      configuration: { body: "nobody reaches me" },
    })], [edge("ticket", "done")]),
  );

  add(
    "graph/binding-targets",
    graph(
      [
        ticket(),
        node("comment", "post_ticket_comment", {
          configuration: { body: "x" },
          inputs: {
            body: { kind: "reference", reference: "steps.nowhere.output.text" },
          },
          additionalInputs: [
            {
              name: "self",
              schema: { type: "string" },
              binding: { kind: "reference", reference: "steps.comment.output.text" },
            },
            {
              name: "self",
              schema: { type: "string" },
              binding: { kind: "literal", value: "twice" },
            },
            {
              name: "body",
              schema: { type: "string" },
              binding: { kind: "literal", value: "clash" },
            },
          ],
        }),
      ],
      [edge("ticket", "comment")],
    ),
  );

  add(
    "graph/control-blocks-reject-inputs",
    graph(
      [
        ticket(),
        node("shape", "transform", {
          configuration: { operation: "format_text", template: "hello" },
          inputs: {
            source: { kind: "literal", value: "no" },
          },
          additionalInputs: [
            {
              name: "extra",
              schema: { type: "string" },
              binding: { kind: "literal", value: "no" },
            },
          ],
        }),
        node("decide", "branch", {
          configuration: {
            combinator: "all",
            conditions: [
              { reference: "steps.entry.output.ticket.key", operator: "has_value" },
            ],
          },
          inputs: {
            source: { kind: "literal", value: "no" },
          },
        }),
        done(),
        node("other", "terminate", { configuration: { terminalStatus: "failed" } }),
      ],
      [
        edge("ticket", "shape"),
        edge("shape", "decide"),
        edge("decide", "done", "true"),
        edge("decide", "other", "false"),
      ],
    ),
  );

  add(
    "configuration/unsupported-and-invalid-params",
    graph(
      [
        ticket(),
        node("checks", "run_checks", {
          configuration: { commands: "not-a-list" as unknown as JsonValue, mystery: 1 },
        }),
      ],
      [edge("ticket", "checks")],
    ),
  );

  add(
    "configuration/profile-overridden-by-provider-and-model",
    graph(
      [
        ticket(),
        node("plan", "planning_agent", {
          configuration: {
            harnessProfile: { ...builtinHarnessProfileReference("claude") },
            provider: "codex",
            model: "gpt-test",
            prompt: "plan it",
          },
        }),
      ],
      [edge("ticket", "plan")],
    ),
  );

  add(
    "schedule/missing-cron-title-description",
    graph(
      [node("tick", "trigger_schedule"), done()],
      [edge("tick", "done")],
    ),
  );

  add(
    "schedule/invalid-cron",
    graph(
      [
        node("tick", "trigger_schedule", {
          configuration: {
            cron: "not a cron",
            taskTitle: "Nightly",
            taskDescription: "Do the nightly thing.",
          },
        }),
        done(),
      ],
      [edge("tick", "done")],
    ),
  );

  add(
    "schedule/invalid-timezone",
    graph(
      [
        node("tick", "trigger_schedule", {
          configuration: {
            cron: "0 3 * * *",
            timezone: "Middle/Earth",
            taskTitle: "Nightly",
            taskDescription: "Do the nightly thing.",
          },
        }),
        done(),
      ],
      [edge("tick", "done")],
    ),
  );

  add(
    "schedule/below-minimum-period",
    graph(
      [
        node("tick", "trigger_schedule", {
          configuration: {
            cron: "* * * * *",
            timezone: "UTC",
            taskTitle: "Every minute",
            taskDescription: "Far too often.",
          },
        }),
        done(),
      ],
      [edge("tick", "done")],
    ),
  );

  add(
    "schedule/never-occurs",
    graph(
      [
        node("tick", "trigger_schedule", {
          configuration: {
            cron: "0 0 30 2 *",
            timezone: "UTC",
            taskTitle: "February thirtieth",
            taskDescription: "A day that never comes.",
          },
        }),
        done(),
      ],
      [edge("tick", "done")],
    ),
  );

  add(
    "schedule/reaches-human-wait",
    graph(
      [
        node("tick", "trigger_schedule", {
          configuration: {
            cron: "0 3 * * *",
            timezone: "UTC",
            taskTitle: "Nightly",
            taskDescription: "Do the nightly thing.",
          },
        }),
        node("ask", "human_question", {
          configuration: { question: "May I?" },
        }),
        done(),
      ],
      [edge("tick", "ask"), edge("ask", "done")],
    ),
  );

  add(
    "schedule/prepares-workspace-with-no-pin",
    graph(
      [
        node("tick", "trigger_schedule", {
          configuration: {
            cron: "0 3 * * *",
            timezone: "UTC",
            taskTitle: "Nightly",
            taskDescription: "Do the nightly thing.",
          },
        }),
        node("prepare", "prepare_workspace"),
        done(),
      ],
      [edge("tick", "prepare"), edge("prepare", "done")],
    ),
  );

  add(
    "availability/nothing-configured",
    graph(
      [
        ticket(),
        node("prepare", "prepare_workspace"),
        node("ask-llm", "call_llm", {
          configuration: { prompt: "hello", outputSchema: '{"type":"string"}' },
        }),
        node("slack", "send_slack_message", {
          configuration: { channel: "#general", message: "hi" },
        }),
      ],
      [edge("ticket", "prepare"), edge("prepare", "ask-llm"), edge("ask-llm", "slack")],
    ),
    "bare",
  );

  add(
    "branch/condition-rules",
    graph(
      [
        ticket(),
        node("decide", "branch", {
          configuration: {
            combinator: "all",
            conditions: [
              { reference: "steps.nowhere.output.value", operator: "equals", value: "x" },
              { reference: "steps.entry.output.ticket.key", operator: "greater_than", value: 3 },
              { reference: "steps.entry.output.ticket.key", operator: "has_value", value: "x" },
              { reference: "steps.entry.output.ticket.key", operator: "equals" },
              {
                reference: "steps.entry.output.ticket.key",
                operator: "greater_than_or_equal",
                value: 1,
                ignoreCase: true,
              },
            ],
          },
        }),
        done(),
        node("other", "terminate", { configuration: { terminalStatus: "failed" } }),
      ],
      [
        edge("ticket", "decide"),
        edge("decide", "done", "true"),
        edge("decide", "other", "false"),
      ],
    ),
  );

  add(
    "branch/no-conditions",
    graph(
      [
        ticket(),
        node("decide", "branch", {
          configuration: { combinator: "any", conditions: [] },
        }),
        done(),
        node("other", "terminate", { configuration: { terminalStatus: "failed" } }),
      ],
      [
        edge("ticket", "decide"),
        edge("decide", "done", "true"),
        edge("decide", "other", "false"),
      ],
    ),
  );

  add(
    "transform/reference-rules",
    graph(
      [
        ticket(),
        node("trim", "transform", {
          configuration: { operation: "trim_text", source: "steps.nowhere.output.text" },
        }),
        node("count", "transform", {
          configuration: {
            operation: "number_to_text",
            source: "steps.entry.output.ticket.key",
          },
        }),
        node("compose", "transform", {
          configuration: {
            operation: "build_object",
            fields: [
              {
                name: "key",
                value: {
                  kind: "reference",
                  reference: "steps.entry.output.ticket.key",
                  defaultValue: 7,
                },
              },
              {
                name: "missing",
                value: { kind: "reference", reference: "steps.nowhere.output.value" },
              },
            ],
          },
        }),
      ],
      [edge("ticket", "trim"), edge("trim", "count"), edge("count", "compose")],
    ),
  );

  add(
    "transform/empty-replacement-pattern",
    graph(
      [
        ticket(),
        node("replace", "transform", {
          configuration: {
            operation: "replace_text",
            source: "steps.entry.output.ticket.key",
            mode: "regex",
            pattern: "",
            replacement: "x",
            ignoreCase: false,
          },
        }),
      ],
      [edge("ticket", "replace")],
    ),
  );

  add(
    "workspace/checks-without-prepared-workspace",
    graph(
      [
        ticket(),
        node("checks", "run_checks", { configuration: { commands: ["pnpm test"] } }),
        node("open", "open_pr", { configuration: { title: "A pull request" } }),
      ],
      [edge("ticket", "checks"), edge("checks", "open")],
    ),
  );

  add(
    "workspace/concurrent-writers",
    graph(
      [
        ticket(),
        node("prepare", "prepare_workspace"),
        node("left", "implementation_agent", {
          configuration: { prompt: "write the left half" },
        }),
        node("right", "implementation_agent", {
          configuration: { prompt: "write the right half" },
        }),
      ],
      [edge("ticket", "prepare"), edge("prepare", "left"), edge("prepare", "right")],
    ),
  );

  add(
    "repository-scope/provider-excludes-pinned-repository",
    graph(
      [ticket(), done()],
      [edge("ticket", "done")],
      {
        providers: ["github"],
        repositories: [{ provider: "gitlab", repoPath: "group/project" }],
      },
    ),
  );

  add(
    "repository-scope/provider-not-configured",
    graph(
      [ticket(), done()],
      [edge("ticket", "done")],
      { providers: ["gitlab"] },
    ),
    "bare",
  );

  add(
    "every-family-at-once",
    graph(
      [
        node("entry", "trigger_schedule", {
          configuration: {
            cron: "* * * * *",
            timezone: "UTC",
            taskTitle: "Every minute",
            taskDescription: "Far too often.",
            mystery: true,
          },
        }),
        node("prepare", "prepare_workspace"),
        node("ask", "human_question", { configuration: { question: "May I?" } }),
        node("decide", "branch", {
          configuration: {
            combinator: "all",
            conditions: [
              { reference: "steps.nowhere.output.value", operator: "equals", value: "x" },
            ],
          },
          inputs: { source: { kind: "literal", value: "no" } },
        }),
        node("shape", "transform", {
          configuration: { operation: "trim_text", source: "steps.nowhere.output.text" },
        }),
        node("orphan", "post_ticket_comment", { configuration: { body: "alone" } }),
      ],
      [
        edge("entry", "prepare"),
        edge("prepare", "ask"),
        edge("ask", "decide"),
        edge("decide", "shape", "true"),
      ],
      {
        providers: ["github"],
        repositories: [{ provider: "gitlab", repoPath: "group/project" }],
      },
    ),
  );

  // The one arm nothing else in the corpus reaches: a malformed outputSchema
  // makes the block's definition issues fire, and that SUPPRESSES the
  // environment-availability complaint the same node would otherwise get. Run
  // on the bare context so the suppressed complaint is real: without the bad
  // schema this node reports "is unavailable".
  add(
    "outputSchema/malformed-hides-availability",
    graph(
      [
        ticket(),
        node("agent", "generic_agent", {
          configuration: {
            prompt: "do the thing",
            outputSchema: '{"type":"string"}',
          },
        }),
        node("healthy", "generic_agent", {
          configuration: { prompt: "do the other thing" },
        }),
      ],
      [edge("ticket", "agent"), edge("agent", "healthy")],
    ),
    "bare",
  );

  // A loop region inside one arm of a branch: the cycle detector, the strongly
  // connected component walk and the branch port rules all read the same graph,
  // and nesting is where their answers can disagree.
  add(
    "graph/loop-region-inside-a-branch-arm",
    graph(
      [
        ticket(),
        node("decide", "branch", {
          configuration: {
            combinator: "all",
            conditions: [
              { reference: "steps.entry.output.ticket.summary", operator: "has_value" },
            ],
          },
        }),
        node("retry", "loop", {
          configuration: { maxAttempts: 3, onExhaust: "continue" },
        }),
        node("work", "post_ticket_comment", { configuration: { body: "attempt" } }),
        node("exhausted", "terminate", { configuration: { terminalStatus: "failed" } }),
        done(),
      ],
      [
        edge("ticket", "decide"),
        edge("decide", "retry", "true"),
        edge("decide", "done", "false"),
        edge("retry", "work", "continue"),
        edge("work", "retry"),
        edge("retry", "exhausted", "exhausted"),
      ],
    ),
  );

  return entries;
}

export function definitionGoldenCorpus(): CorpusEntry[] {
  return [
    ...snapshotDefinitions(),
    ...templateDefinitions(),
    ...runLoadDefinitions(),
    ...brokenDefinitions(),
  ];
}

/**
 * The fixture text. Written by `pnpm --filter worker run capture:definition-golden --write`
 * and asserted, unchanged, by the golden test; nothing regenerates it on the
 * way through a test run.
 */
export function renderDefinitionGolden(): string {
  const blockData = {
    full: testBlockData(fullContext),
    bare: testBlockData(bareContext),
  };
  const records = definitionGoldenCorpus().map((entry) => ({
    fixture: entry.fixture,
    issues: testDeploymentIssues(
      entry.definition,
      ...blockData[entry.context],
      entry.checkEnvironmentAvailability === false
        ? { checkEnvironmentAvailability: false }
        : {},
    ).map(withStableMessage),
  }));
  return `${JSON.stringify(records, null, 2)}\n`;
}

/**
 * The one message in the corpus that quotes a clock: the schedule evaluator
 * reports the instant it searched forward from, because that is what an author
 * needs to see. Blanking it keeps the never-occurs rule in the corpus instead of
 * dropping the only fixture that reaches it.
 */
function withStableMessage(
  issue: WorkflowDefinitionValidationIssue,
): WorkflowDefinitionValidationIssue {
  return { ...issue, message: withoutInstants(issue.message) };
}

function withoutInstants(message: string): string {
  return message.replaceAll(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g,
    "<instant>",
  );
}

export const DEFINITION_GOLDEN_PATH = resolve(
  import.meta.dirname,
  "../workflow-definition/__golden__/definition-deployment-issues.json",
);
