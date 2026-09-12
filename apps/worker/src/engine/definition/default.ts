import type {
  HarnessProvider,
  HarnessProfileReference,
  JsonValue,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import { builtinHarnessProfileReference } from "@shared/harness";

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

function stableBuiltinV2EdgeId(
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

/** New authoring and fresh-install fallback runs use the v2 graph. */
export function defaultWorkflowDefinitionV2({
  includeReview,
  includeLeakReview = false,
  provider = "claude",
  profileReference = builtinHarnessProfileReference(provider),
}: {
  includeReview: boolean;
  /** Optional so a caller that never enables the flag keeps today's shape. */
  includeLeakReview?: boolean;
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
    // Always between checks and finalize: finalize pushes the branch, so this is
    // the last point where a leak can still be caught before publication.
    ...(includeLeakReview
      ? [
          {
            id: "leak-review",
            type: "leak_review",
            name: "Leak review",
          } satisfies V2BlockSpec,
        ]
      : []),
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
