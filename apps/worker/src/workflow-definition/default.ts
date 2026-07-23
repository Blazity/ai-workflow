import type {
  HarnessProvider,
  HarnessProfileReference,
  JsonValue,
  WorkflowBlockTypeV1,
  WorkflowDefinitionV1,
  WorkflowDefinitionV2,
  WorkflowDefinitionNode,
  WorkflowDefinitionV2Node,
  WorkflowParamValue,
} from "@shared/contracts";
import { builtinHarnessProfileReference } from "@shared/contracts";

interface BlockSpec {
  id: string;
  type: WorkflowBlockTypeV1;
  name: string;
  params: Record<string, WorkflowParamValue>;
  inputs?: WorkflowDefinitionNode["inputs"];
}

export function defaultWorkflowDefinition({
  includeReview,
}: {
  includeReview: boolean;
}): WorkflowDefinitionV1 {
  const specs: BlockSpec[] = [
    { id: "trigger", type: "trigger_ticket_ai", name: "Ticket assigned to AI", params: {} },
    {
      id: "planning",
      type: "planning_agent",
      name: "Planning agent",
      params: {},
      inputs: {
        ticket: "trigger.ticket",
        comments: "trigger.comments",
        priorAnswers: "trigger.priorAnswers",
      },
    },
    {
      id: "implementation",
      type: "implementation_agent",
      name: "Implementation agent",
      params: {},
      inputs: {
        ticket: "trigger.ticket",
        plan: "steps.planning.output.plan",
      },
    },
    ...(includeReview
      ? [{ id: "review", type: "review_agent", name: "Review agent", params: {} } satisfies BlockSpec]
      : []),
    { id: "checks", type: "run_pre_pr_checks", name: "Run pre-PR checks", params: {} },
    { id: "finalize", type: "finalize_workspace", name: "Finalize workspace", params: {} },
    {
      id: "open-pr",
      type: "open_pr",
      name: "Open pull request",
      params: {},
      inputs: { repositories: "steps.finalize.output.repositories" },
    },
    { id: "slack", type: "send_slack_message", name: "Send Slack message", params: {} },
    { id: "status", type: "update_ticket_status", name: "Update ticket status", params: { target: "ai_review" } },
  ];

  const startX = 40;
  const stepX = 260;
  const y = 280;

  const nodes: WorkflowDefinitionNode[] = specs.map((spec, index) => ({
    id: spec.id,
    type: spec.type,
    name: spec.name,
    x: startX + index * stepX,
    y,
    params: spec.params,
    inputs: spec.inputs ?? {},
  }));

  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));

  return { schemaVersion: 1, nodes, edges };
}

export interface V2BlockSpec {
  id: string;
  type: WorkflowDefinitionV2Node["type"];
  name: string;
  column?: number;
  row?: number;
  configuration?: Record<string, JsonValue>;
  inputs?: WorkflowDefinitionV2Node["inputs"];
  additionalInputs?: WorkflowDefinitionV2Node["additionalInputs"];
}

export function builtinHarnessProfileConfiguration(
  provider: HarnessProvider,
  reference: HarnessProfileReference = builtinHarnessProfileReference(provider),
): Record<string, JsonValue> {
  return {
    harnessProfile: {
      profileId: reference.profileId,
      version: reference.version,
    },
  };
}

export function stableBuiltinV2EdgeId(
  namespace: string,
  index: number,
  from: string,
  to: string,
  fromPort?: string,
): string {
  return [
    "builtin",
    namespace,
    String(index + 1).padStart(2, "0"),
    from,
    fromPort ?? "out",
    to,
  ].join("-");
}

export function buildBuiltinV2Definition(
  namespace: string,
  specs: V2BlockSpec[],
  edges: Array<{ from: string; to: string; fromPort?: string }>,
): WorkflowDefinitionV2 {
  const nodes: WorkflowDefinitionV2Node[] = specs.map((spec, index) => ({
    id: spec.id,
    type: spec.type,
    name: spec.name,
    x: 40 + (spec.column ?? index) * 260,
    y: 280 + (spec.row ?? 0) * 180,
    configuration: spec.configuration ?? {},
    inputs: spec.inputs ?? {},
    additionalInputs: spec.additionalInputs ?? [],
  }));
  return {
    schemaVersion: 2,
    nodes,
    edges: edges.map((edge, index) => ({
      id: stableBuiltinV2EdgeId(
        namespace,
        index,
        edge.from,
        edge.to,
        edge.fromPort,
      ),
      from: edge.from,
      to: edge.to,
      ...(edge.fromPort === undefined ? {} : { fromPort: edge.fromPort }),
    })),
  };
}

/**
 * New authoring starts on v2. The v1 factory above remains the compatibility
 * fallback for stored history and fresh-install runs without a saved version.
 */
export function defaultWorkflowDefinitionV2({
  includeReview,
  provider = "claude",
  profileReference = builtinHarnessProfileReference(provider),
}: {
  includeReview: boolean;
  provider?: HarnessProvider;
  profileReference?: HarnessProfileReference;
}): WorkflowDefinitionV2 {
  const profile = () =>
    builtinHarnessProfileConfiguration(provider, profileReference);
  const specs: V2BlockSpec[] = [
    {
      id: "trigger",
      type: "trigger_ticket_ai",
      name: "Ticket assigned to AI",
    },
    {
      id: "prepare",
      type: "prepare_workspace",
      name: "Prepare workspace",
    },
    {
      id: "planning",
      type: "planning_agent",
      name: "Planning agent",
      configuration: {
        ...profile(),
        prompt: "{{prompt:research-plan@1}}",
      },
      inputs: {
        ticket: {
          kind: "reference",
          reference: "steps.entry.output.ticket",
        },
        comments: {
          kind: "reference",
          reference: "steps.entry.output.comments",
        },
        priorAnswers: {
          kind: "reference",
          reference: "steps.entry.output.priorAnswers",
        },
      },
    },
    {
      id: "implementation",
      type: "implementation_agent",
      name: "Implementation agent",
      configuration: {
        ...profile(),
        prompt: "{{prompt:implement@1}}",
      },
      inputs: {
        ticket: {
          kind: "reference",
          reference: "steps.entry.output.ticket",
        },
        plan: {
          kind: "reference",
          reference: "steps.planning.output.plan",
        },
      },
    },
    ...(includeReview
      ? [
          {
            id: "review",
            type: "review_agent",
            name: "Review agent",
            configuration: {
              ...profile(),
              prompt: "{{prompt:review@1}}",
            },
          } satisfies V2BlockSpec,
        ]
      : []),
    {
      id: "checks",
      type: "run_pre_pr_checks",
      name: "Run pre-PR checks",
    },
    {
      id: "finalize",
      type: "finalize_workspace",
      name: "Finalize workspace",
    },
    {
      id: "open-pr",
      type: "open_pr",
      name: "Open pull request",
      inputs: {
        repositories: {
          kind: "reference",
          reference: "steps.finalize.output.repositories",
        },
      },
    },
    {
      id: "slack",
      type: "send_slack_message",
      name: "Send Slack message",
    },
    {
      id: "status",
      type: "update_ticket_status",
      name: "Update ticket status",
      configuration: { target: "ai_review" },
    },
  ];
  const edges = specs.slice(1).map((spec, index) => ({
    from: specs[index]!.id,
    to: spec.id,
  }));
  return buildBuiltinV2Definition("ticket-workflow", specs, edges);
}
