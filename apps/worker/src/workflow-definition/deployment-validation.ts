/**
 * Deployment validation: the `deploy` and `runLoad` policies of
 * `@shared/workflow-graph` wrapped in everything the worker alone can answer.
 *
 * The worker-only half is what reads the environment, the block registry or a
 * clock: whether a schedule's cron parses and fires often enough, whether a
 * block's definition-time output schema is well formed, whether the block is
 * available in this deployment at all, whether the repository pin names
 * providers this installation has, and the workspace-access and available-value
 * passes that need the block contract resolver. It reaches the policy as one
 * injected source, so the package never learns what backs it.
 *
 * The composition below is the contract. An author reads one ordered list, so
 * the sequence the halves are spliced in is behaviour: graph and configuration
 * first (the policy's own structural rules), then the per-node deployment walk
 * with the two pure schedule rules at its tail, then the available-values pass,
 * then branch and transform references, then workspace access, then the
 * repository pin. The policy de-duplicates that list once, and the golden
 * fixture under `__golden__/` pins the order byte for byte.
 */
import type {
  VcsProviderKind,
  WorkflowBlockContractResolver,
  WorkflowDefinition,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
  WorkflowDefinitionValidationIssue,
  WorkflowParamValue,
} from "@shared/contracts";
import { isHarnessProfileReference } from "@shared/contracts";
import { resolveBuiltinHarnessProfile } from "@shared/harness";
import {
  deploy,
  runLoad,
  workflowDefinitionIssue,
  workflowScheduleGraphIssues,
  workflowValueReferenceIssues,
  type WorkflowBlockParamsSchemas,
  type WorkflowDeploymentIssueSource,
  type WorkflowGraphDeploymentPolicyDeps,
} from "@shared/workflow-graph";
import {
  MINIMUM_PERIOD_MS,
  parseSchedule,
  violatesMinimumPeriod,
} from "../engine/definition/schedule-occurrence.js";
import {
  workflowBlockDeploymentDefinitionIssues,
  workflowRepositoryScopeIssues,
} from "./block-registry.js";
import {
  analyzeWorkflowValues,
  analyzeWorkflowV2Catalog,
  type WorkflowValueAnalysis,
} from "./available-values.js";
import { validateTransformDefinition } from "./transform.js";
import { validateWorkflowV2WorkspaceAccessIssues } from "./workspace-access.js";

/** Validation required before a definition may become executable, and today
 * also what a draft candidate is measured against: `validation.ts` runs this
 * same walk and reports its issues without refusing the save, so an operator
 * keeps editing an incomplete graph while seeing what would block a deploy.
 *
 * It analyses the definition itself, because its callers hold no request-level
 * analysis. A caller that does hold one takes
 * `validateWorkflowDefinitionIssuesForDeployment` below and passes it, so the
 * request keeps to a single pass. */
export function validateWorkflowDefinitionForDeployment(
  def: WorkflowDefinition,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  configuredVcsProviders: readonly VcsProviderKind[],
): string[] {
  return selfAnalysingPolicyMessages(
    def,
    resolveContract,
    blockParamsSchemas,
    configuredVcsProviders,
    true,
  );
}

/** The same walk for a graph that already deployed: the `runLoad` policy, which
 *  skips the environment availability check, so a run under way is not refused
 *  because the deployment changed after it started. */
export function validateWorkflowDefinitionForRunLoad(
  def: WorkflowDefinition,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  configuredVcsProviders: readonly VcsProviderKind[],
): string[] {
  return selfAnalysingPolicyMessages(
    def,
    resolveContract,
    blockParamsSchemas,
    configuredVcsProviders,
    false,
  );
}

/** The body both wrappers above share. They differ only in which policy they
 *  name, and a caller that holds no analysis makes one here. */
function selfAnalysingPolicyMessages(
  def: WorkflowDefinition,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  configuredVcsProviders: readonly VcsProviderKind[],
  checkEnvironmentAvailability: boolean,
): string[] {
  return validateWorkflowDefinitionIssuesForDeployment(
    def,
    resolveContract,
    blockParamsSchemas,
    configuredVcsProviders,
    analyzeWorkflowValues(def, resolveContract),
    { checkEnvironmentAvailability },
  ).map(({ message }) => message);
}

/**
 * `analysis` is the request's available-values pass over `def`. Passing the
 * pass rather than the analyser is what keeps a request to one walk: the
 * candidate validator and the deployment policies read the same pass again
 * afterwards.
 */
export function validateWorkflowDefinitionIssuesForDeployment(
  def: WorkflowDefinition,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  configuredVcsProviders: readonly VcsProviderKind[],
  analysis: WorkflowValueAnalysis,
  options: {
    checkEnvironmentAvailability?: boolean;
  } = {},
): WorkflowDefinitionValidationIssue[] {
  const deps: WorkflowGraphDeploymentPolicyDeps = {
    blockParamsSchemas,
    validateTransformShape: (configuration) => validateTransformDefinition({ configuration }),
    deploymentIssues: workerDeploymentIssues(
      def,
      resolveContract,
      blockParamsSchemas,
      configuredVcsProviders,
      analysis,
    ),
  };
  const policy = options.checkEnvironmentAvailability === false ? runLoad : deploy;
  return policy(def, deps).issues;
}

/**
 * Everything the policy cannot answer, in the order an author reads it.
 *
 * The definition and its available-values pass are taken here, once, and the
 * source holds both: a definition and an analysis of a different graph can
 * never be paired, and the catalog view of the pass is derived once rather than
 * per call, the way it was when this list was spliced inline. `analysis` must
 * be the pass over `def`, which is what the single caller below guarantees by
 * building the source from the same definition it hands the policy.
 */
function workerDeploymentIssues(
  def: WorkflowDefinition,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  configuredVcsProviders: readonly VcsProviderKind[],
  analysis: WorkflowValueAnalysis,
): WorkflowDeploymentIssueSource {
  const catalogAnalysis = analyzeWorkflowV2Catalog(analysis);
  return ({ checkEnvironmentAvailability }) => [
    ...validateWorkflowV2BlockDeploymentIssues(
      def,
      resolveContract,
      blockParamsSchemas,
      { checkEnvironmentAvailability },
    ),
    ...analysis.issues,
    ...workflowValueReferenceIssues(def, catalogAnalysis.catalogByNode),
    ...validateWorkflowV2WorkspaceAccessIssues(def),
    ...repositoryScopePinIssues(def, configuredVcsProviders, { checkEnvironmentAvailability }),
  ];
}

function v2ConfigurationParams(
  node: WorkflowDefinitionV2Node,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
): Record<string, WorkflowParamValue> {
  // Branch and Transform keep their configuration out of params: their typed
  // shapes are operations, never executor params.
  const parsedConfiguration =
    node.type === "branch" || node.type === "transform"
      ? null
      : blockParamsSchemas[node.type].safeParse(node.configuration);
  const configuration =
    parsedConfiguration?.success === true
      ? (parsedConfiguration.data as Record<string, unknown>)
      : node.configuration;
  const params: Record<string, WorkflowParamValue> = {};
  for (const [name, value] of Object.entries(configuration)) {
    if (
      name === "harnessProfile" ||
      name === "outputSchemaDialect" ||
      name === "promptSlotBindings"
    ) {
      continue;
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) &&
        value.every((item) => typeof item === "string"))
    ) {
      params[name] = value;
    }
  }
  if (isHarnessProfileReference(node.configuration.harnessProfile)) {
    const profile = resolveBuiltinHarnessProfile(
      node.configuration.harnessProfile,
    );
    if (profile !== null) {
      params.provider = profile.harness.provider;
      params.model = profile.model.id;
    }
  }
  return params;
}

function validateWorkflowV2BlockDeploymentIssues(
  def: WorkflowDefinitionV2,
  resolveContract: WorkflowBlockContractResolver,
  blockParamsSchemas: WorkflowBlockParamsSchemas,
  options: { checkEnvironmentAvailability?: boolean },
): WorkflowDefinitionValidationIssue[] {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  for (const [nodeIndex, node] of def.nodes.entries()) {
    const params = v2ConfigurationParams(node, blockParamsSchemas);
    if (
      node.type === "trigger_schedule" &&
      (typeof params.cron !== "string" || params.cron.trim() === "")
    ) {
      issues.push(
        workflowDefinitionIssue(
          `Block "${node.id}" (trigger_schedule) must configure a cron schedule before deployment.`,
          node.id,
          `/nodes/${nodeIndex}/configuration/cron`,
        ),
      );
    }
    if (
      node.type === "trigger_schedule" &&
      (typeof params.taskTitle !== "string" || params.taskTitle.trim() === "")
    ) {
      issues.push(
        workflowDefinitionIssue(
          `Block "${node.id}" (trigger_schedule) must configure a task title before deployment.`,
          node.id,
          `/nodes/${nodeIndex}/configuration/taskTitle`,
        ),
      );
    }
    if (
      node.type === "trigger_schedule" &&
      (typeof params.taskDescription !== "string" || params.taskDescription.trim() === "")
    ) {
      issues.push(
        workflowDefinitionIssue(
          `Block "${node.id}" (trigger_schedule) must configure a task description before deployment.`,
          node.id,
          `/nodes/${nodeIndex}/configuration/taskDescription`,
        ),
      );
    }
    // Schedule semantics come from the schedule-trigger evaluator and are never
    // re-implemented here. The deployment gate, the editor's preview and the
    // once-a-minute dispatcher have to agree about when a schedule fires, and
    // one shared module is the only way to guarantee that. It also keeps the
    // cron library out of the structural rules, which are imported almost
    // everywhere.
    //
    // Only runs on a non-empty cron: an empty one already has its own issue
    // above, and reporting "empty" and "invalid syntax" for one field in one
    // deploy is noise rather than help.
    if (
      node.type === "trigger_schedule" &&
      typeof params.cron === "string" &&
      params.cron.trim() !== "" &&
      // A non-string timezone already has a type issue from the configuration
      // schema, so it is left alone rather than given a second complaint.
      (node.configuration.timezone === undefined ||
        typeof node.configuration.timezone === "string")
    ) {
      // Only a genuinely absent key gets the schema default. A key that is
      // present goes to the evaluator exactly as authored, empty string
      // included.
      //
      // The distinction is the whole check. `z.string().default("UTC")` fills in
      // a *missing* key, so `timezone: ""` parses fine, and substituting "UTC"
      // for it here would let a blank zone deploy clean and then have every
      // single tick come back invalid at runtime, which is precisely the silent
      // fallback this stage exists to prevent, in the last place able to catch it
      // before shipping.
      const timezone = node.configuration.timezone ?? "UTC";
      const parsed = parseSchedule(params.cron, timezone);

      if (!parsed.ok && parsed.problem.reason === "invalid-timezone") {
        issues.push(
          workflowDefinitionIssue(
            `Block "${node.id}" (trigger_schedule) must configure a known IANA timezone before deployment: ${parsed.problem.message}`,
            node.id,
            `/nodes/${nodeIndex}/configuration/timezone`,
          ),
        );
      } else if (!parsed.ok) {
        issues.push(
          workflowDefinitionIssue(
            `Block "${node.id}" (trigger_schedule) must configure a valid cron expression before deployment: ${parsed.problem.message}`,
            node.id,
            `/nodes/${nodeIndex}/configuration/cron`,
          ),
        );
      } else {
        // `new Date()` rather than a threaded clock: this validator has no clock
        // parameter and its entry point is used across the codebase, so wiring
        // one through for this check alone would be a far larger change than it
        // earns.
        //
        // The verdict genuinely can depend on the instant, because the check
        // samples MINIMUM_PERIOD_SAMPLE occurrences forward from now. Measured:
        // in Australia/Lord_Howe, whose daylight-saving shift is thirty minutes,
        // `0,20,40 * * * *` is accepted on most days and refused near the
        // transition, where its real minimum gap is ten minutes. Accepted as a
        // known limit, since no bounded sample can prove a cron expression's
        // minimum over all time, and the preset builder avoids the whole class by
        // compiling intervals in UTC.
        const problem = violatesMinimumPeriod(
          params.cron,
          timezone,
          new Date(),
        );
        if (problem?.reason === "below-minimum-period") {
          issues.push(
            workflowDefinitionIssue(
              `Block "${node.id}" (trigger_schedule) must leave at least ${MINIMUM_PERIOD_MS / 60_000} minutes between runs before deployment: ${problem.message} Agent runs occupy a small shared pool, so a schedule firing faster than that can starve the rest of the queue.`,
              node.id,
              `/nodes/${nodeIndex}/configuration/cron`,
            ),
          );
        } else if (problem) {
          // Only "never-occurs" reaches here, the expression and the timezone
          // both parsed. Same field to fix, different wording on purpose:
          // telling someone their never-firing schedule is too frequent would
          // send them looking in the wrong place.
          issues.push(
            workflowDefinitionIssue(
              `Block "${node.id}" (trigger_schedule) must configure a cron expression with upcoming occurrences before deployment: ${problem.message}`,
              node.id,
              `/nodes/${nodeIndex}/configuration/cron`,
            ),
          );
        }
      }
    }

    const definitionIssues = workflowBlockDeploymentDefinitionIssues(
      node.type,
      params,
    );
    if (definitionIssues.length > 0) {
      issues.push(
        ...definitionIssues.map((issue) => ({
          code: issue.code,
          severity: "error" as const,
          nodeId: node.id,
          path: `/nodes/${nodeIndex}/configuration/outputSchema${issue.path}`,
          message: `Block "${node.id}" (${node.type}) is unavailable: ${issue.message}`,
        })),
      );
    } else if (options.checkEnvironmentAvailability !== false) {
      const availability = resolveContract(node.type, params).availability;
      if (!availability.available) {
        issues.push(
          workflowDefinitionIssue(
            `Block "${node.id}" (${node.type}) is unavailable: ${availability.unavailableReason}`,
            node.id,
            `/nodes/${nodeIndex}/configuration`,
          ),
        );
      }
    }
  }
  issues.push(...workflowScheduleGraphIssues(def));
  return issues;
}

/**
 * The definition-level repository pin belongs to no block, so the node walks
 * above never see it. Its issues carry `nodeId: null`, the way every other
 * definition-wide issue does, and flow through the same dedupe as the rest.
 */
function repositoryScopePinIssues(
  def: WorkflowDefinition,
  configuredVcsProviders: readonly VcsProviderKind[],
  options: { checkEnvironmentAvailability?: boolean },
): WorkflowDefinitionValidationIssue[] {
  return workflowRepositoryScopeIssues(
    def.repositoryScope,
    configuredVcsProviders,
    options,
  ).map((message) => workflowDefinitionIssue(message, null, "/repositoryScope"));
}
