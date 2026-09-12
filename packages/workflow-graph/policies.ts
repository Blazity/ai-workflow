/**
 * One entry per validation policy: the question a caller is actually asking.
 *
 * Three questions exist. `parse` reads a stored or submitted graph into the
 * runnable shape and answers nothing else, which is what the repository read
 * path wants. `deploy` asks whether that graph may become executable in this
 * deployment, environment availability included. `runLoad` asks the same about
 * a graph that already deployed, so it skips availability: a run that is
 * already under way must not be refused because a provider key was rotated
 * after it started.
 *
 * `deploy` and `runLoad` take the definition `parse` produced rather than
 * parsing again, which is what keeps a request to one parse, and they compose
 * the structural rules with everything only a running deployment can answer.
 * That second half arrives through `deploymentIssues`, the same way the
 * transform shape validator arrives in `graph-issues.ts`: this package never
 * learns what backs it.
 *
 * De-duplication is not single-pass and is not meant to be. The graph walk
 * dedupes its own list inside `graph-issues.ts`, because
 * `workflowDefinitionStructuralIssues` is a public entry that has to return a
 * clean list to anyone who calls it directly; the policy then dedupes once
 * across the composed list, which is the only dedupe a caller of a policy has
 * to think about. Both use the one `dedupeWorkflowDefinitionIssues`.
 */
import type { z } from "zod";
import {
  WORKFLOW_SCHEMA_VERSION,
  workflowDefinitionSchemaVersionOf,
  type WorkflowDefinition,
  type WorkflowDefinitionValidationIssue,
} from "@shared/contracts";
import {
  dedupeWorkflowDefinitionIssues,
  workflowDefinitionStructuralIssues,
  type WorkflowTransformShapeValidator,
} from "./graph-issues";
import {
  workflowDefinitionV2Schema,
  type WorkflowBlockParamsSchemas,
} from "./schema";

/** The block data every structural rule needs, injected rather than imported.
 *  Composing the params map pulls in every block module, which is worker work. */
export interface WorkflowGraphPolicyDeps {
  blockParamsSchemas: WorkflowBlockParamsSchemas;
  validateTransformShape: WorkflowTransformShapeValidator;
}

/**
 * Everything about a definition that only a running deployment can answer:
 * whether a cron fires often enough, whether a block's output schema is well
 * formed, whether the block exists in this installation, which values the graph
 * offers, and whether the repository pin names providers this installation has.
 *
 * It is built for one definition and holds it, so a policy cannot hand it a
 * different graph than the one it was prepared for. The only thing it takes per
 * call is the policy's own verdict on environment availability, which it does
 * not decide itself because that check sits inside the deployment walk and an
 * author reads one ordered list.
 */
export type WorkflowDeploymentIssueSource = (
  options: { readonly checkEnvironmentAvailability: boolean },
) => readonly WorkflowDefinitionValidationIssue[];

export interface WorkflowGraphDeploymentPolicyDeps extends WorkflowGraphPolicyDeps {
  deploymentIssues: WorkflowDeploymentIssueSource;
}

/**
 * What a policy answers with: the definition it validated and one de-duplicated
 * issue list.
 */
export interface WorkflowGraphPolicyResult {
  /**
   * The definition the caller passed in, echoed rather than derived: `parse`
   * already produced the upgraded object, and these policies validate it rather
   * than parsing again, which is what keeps a request to one parse. It is
   * returned so a policy result reads the same way as a `WorkflowGraphParseResult`
   * and a caller can chain the two without holding the definition itself.
   */
  definition: WorkflowDefinition;
  issues: WorkflowDefinitionValidationIssue[];
}

/**
 * What `parse` answers with. A failure carries both renderings of the same
 * refusal: `issues` for an editor that places each complaint on a node, `error`
 * for a caller that logs one line or rethrows the parser's own error. Splitting
 * on `definition` narrows both.
 */
export type WorkflowGraphParseResult =
  | { definition: WorkflowDefinition; issues: WorkflowDefinitionValidationIssue[]; error: null }
  | { definition: null; issues: WorkflowDefinitionValidationIssue[]; error: z.ZodError };

/**
 * Reads a stored or submitted graph into the runnable one, applying the
 * deterministic normalizations the live schema owns and checking nothing else.
 *
 * The worker's `stored-definition.ts` settles the retired schema before calling
 * this, so anything this refuses is a graph today's build cannot read at all.
 */
export function parse(input: unknown): WorkflowGraphParseResult {
  const parsed = workflowDefinitionV2Schema.safeParse(input);
  if (parsed.success) {
    return { definition: parsed.data as WorkflowDefinition, issues: [], error: null };
  }
  // Derived on first read rather than on every refusal: the repository read
  // path rethrows `error` and never looks at the issue list, and it runs on
  // every trigger routing read.
  let issues: WorkflowDefinitionValidationIssue[] | null = null;
  return {
    definition: null,
    get issues() {
      issues ??= schemaIssues(input, parsed.error);
      return issues;
    },
    error: parsed.error,
  };
}

/**
 * A graph that names a schema this build no longer runs. `parse` would refuse
 * it too, but with a literal mismatch an author cannot act on, so every caller
 * asks this first and answers with the retirement message instead.
 */
export function declaresRetiredSchema(candidate: unknown): boolean {
  const version = workflowDefinitionSchemaVersionOf(candidate);
  return version !== undefined && version !== WORKFLOW_SCHEMA_VERSION;
}

/** May this graph become executable here? The structural rules plus everything
 *  the running deployment answers, environment availability included. */
export function deploy(
  definition: WorkflowDefinition,
  deps: WorkflowGraphDeploymentPolicyDeps,
): WorkflowGraphPolicyResult {
  return deploymentPolicy(definition, deps, true);
}

/** The question the run loader asks about a graph that already deployed:
 *  `deploy` without the environment availability check. */
export function runLoad(
  definition: WorkflowDefinition,
  deps: WorkflowGraphDeploymentPolicyDeps,
): WorkflowGraphPolicyResult {
  return deploymentPolicy(definition, deps, false);
}

function deploymentPolicy(
  definition: WorkflowDefinition,
  deps: WorkflowGraphDeploymentPolicyDeps,
  checkEnvironmentAvailability: boolean,
): WorkflowGraphPolicyResult {
  return {
    definition,
    issues: dedupeWorkflowDefinitionIssues([
      ...structuralIssues(definition, deps),
      ...deps.deploymentIssues({ checkEnvironmentAvailability }),
    ]),
  };
}

function structuralIssues(
  definition: WorkflowDefinition,
  deps: WorkflowGraphPolicyDeps,
): WorkflowDefinitionValidationIssue[] {
  return workflowDefinitionStructuralIssues(
    definition,
    deps.blockParamsSchemas,
    deps.validateTransformShape,
  );
}

/**
 * A parser refusal as issues an editor can place. Node ownership and the JSON
 * path are attached while the parse error still carries that context, so no
 * caller recovers structure by reading a human-readable message.
 */
function schemaIssues(
  input: unknown,
  error: z.ZodError,
): WorkflowDefinitionValidationIssue[] {
  return error.issues.map((issue) => {
    const path = jsonPointer(issue.path);
    return {
      code: "schema",
      severity: "error",
      nodeId: nodeIdAtPath(input, issue.path),
      ...(path ? { path } : {}),
      message: issue.message,
    };
  });
}

function nodeIdAtPath(input: unknown, path: PropertyKey[]): string | null {
  if (
    !input ||
    typeof input !== "object" ||
    path[0] !== "nodes" ||
    typeof path[1] !== "number"
  ) {
    return null;
  }
  const nodes = (input as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;
  const node = nodes[path[1]];
  if (!node || typeof node !== "object") return null;
  const id = (node as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function jsonPointer(path: PropertyKey[]): string {
  return path.length === 0
    ? ""
    : `/${path
        .map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1"))
        .join("/")}`;
}
