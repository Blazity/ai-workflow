import {
  BLOCK_TYPE_SPECS,
  isTriggerBlockType,
  type WorkflowDefinitionV2,
  type WorkflowDefinitionV2ControlEdge,
  type WorkflowDefinitionV2Node,
  type WorkflowDefinitionValidationIssue,
} from "@shared/contracts";

export type WorkflowWorkspaceAccess =
  | "none"
  | "shared_read"
  | "shared_write"
  | "isolated_review";

const TRIGGER_GUARD = "$trigger";
const MAX_ACTIVATION_TERMS = 256;

type ActivationTerm = Map<string, string>;

interface ActivationFormula {
  precise: boolean;
  terms: Map<string, ActivationTerm>;
}

export function workflowWorkspaceAccessOf(
  node: WorkflowDefinitionV2Node,
): WorkflowWorkspaceAccess {
  if (node.type === "review_agent") return "isolated_review";
  if (node.type === "planning_agent") return "shared_read";
  if (
    node.type === "prepare_workspace" ||
    node.type === "implementation_agent" ||
    node.type === "fix_agent" ||
    node.type === "run_pre_pr_checks" ||
    node.type === "run_checks" ||
    node.type === "finalize_workspace" ||
    (node.type === "generic_agent" &&
      node.configuration.workspaceMode !== "none")
  ) {
    return "shared_write";
  }
  return "none";
}

function emptyFormula(): ActivationFormula {
  return { precise: true, terms: new Map() };
}

function termKey(term: ActivationTerm): string {
  return [...term.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key.length}:${key}=${value.length}:${value}`)
    .join("|");
}

function oneTerm(key: string, value: string): ActivationFormula {
  const term = new Map([[key, value]]);
  return { precise: true, terms: new Map([[termKey(term), term]]) };
}

function mergeFormula(
  target: ActivationFormula,
  source: ActivationFormula,
): void {
  if (!source.precise) target.precise = false;
  for (const [key, term] of source.terms) {
    if (target.terms.has(key)) continue;
    if (target.terms.size >= MAX_ACTIVATION_TERMS) {
      target.precise = false;
      continue;
    }
    target.terms.set(key, term);
  }
}

function guardFormula(
  source: ActivationFormula,
  key: string,
  value: string,
): ActivationFormula {
  const guarded = emptyFormula();
  guarded.precise = source.precise;
  for (const term of source.terms.values()) {
    const existing = term.get(key);
    if (existing !== undefined && existing !== value) continue;
    const next = new Map(term);
    next.set(key, value);
    guarded.terms.set(termKey(next), next);
  }
  return guarded;
}

function sameFormula(
  left: ActivationFormula,
  right: ActivationFormula,
): boolean {
  return (
    left.precise === right.precise &&
    left.terms.size === right.terms.size &&
    [...left.terms.keys()].every((key) => right.terms.has(key))
  );
}

function resolvedPort(
  edge: WorkflowDefinitionV2ControlEdge,
  source: WorkflowDefinitionV2Node,
): string | null {
  return edge.fromPort ?? BLOCK_TYPE_SPECS[source.type].ports[0] ?? null;
}

function buildReachability(
  definition: WorkflowDefinitionV2,
): Map<string, Set<string>> {
  const outgoing = new Map(
    definition.nodes.map((node) => [node.id, [] as string[]]),
  );
  for (const edge of definition.edges) outgoing.get(edge.from)?.push(edge.to);

  const result = new Map<string, Set<string>>();
  for (const node of definition.nodes) {
    const reached = new Set<string>();
    const queue = [...(outgoing.get(node.id) ?? [])];
    for (let index = 0; index < queue.length; index += 1) {
      const next = queue[index]!;
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(...(outgoing.get(next) ?? []));
    }
    result.set(node.id, reached);
  }
  return result;
}

function buildActivationFormulas(
  definition: WorkflowDefinitionV2,
): Map<string, ActivationFormula> {
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const incoming = new Map(
    definition.nodes.map((node) => [
      node.id,
      [] as WorkflowDefinitionV2ControlEdge[],
    ]),
  );
  for (const edge of definition.edges) incoming.get(edge.to)?.push(edge);

  let formulas = new Map(
    definition.nodes.map((node) => [
      node.id,
      isTriggerBlockType(node.type)
        ? oneTerm(TRIGGER_GUARD, node.id)
        : emptyFormula(),
    ]),
  );
  const maxRounds = Math.max(1, definition.nodes.length * 2 + 1);
  let converged = false;
  for (let round = 0; round < maxRounds; round += 1) {
    let changed = false;
    const next = new Map<string, ActivationFormula>();
    for (const node of definition.nodes) {
      if (isTriggerBlockType(node.type)) {
        next.set(node.id, formulas.get(node.id)!);
        continue;
      }
      const formula = emptyFormula();
      for (const edge of incoming.get(node.id) ?? []) {
        const source = nodeById.get(edge.from);
        if (!source) continue;
        const sourceFormula = formulas.get(source.id) ?? emptyFormula();
        const port = resolvedPort(edge, source);
        const propagated =
          port !== null && BLOCK_TYPE_SPECS[source.type].ports.length > 1
            ? guardFormula(sourceFormula, `$port:${source.id}`, port)
            : sourceFormula;
        mergeFormula(formula, propagated);
      }
      next.set(node.id, formula);
      if (!sameFormula(formula, formulas.get(node.id) ?? emptyFormula())) {
        changed = true;
      }
    }
    formulas = next;
    if (!changed) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    for (const formula of formulas.values()) formula.precise = false;
  }
  return formulas;
}

function termsCompatible(left: ActivationTerm, right: ActivationTerm): boolean {
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other !== undefined && other !== value) return false;
  }
  return true;
}

function formulasCanOverlap(
  left: ActivationFormula,
  right: ActivationFormula,
): boolean {
  if (left.terms.size === 0 || right.terms.size === 0) return false;
  if (!left.precise || !right.precise) {
    const leftTriggers = new Set(
      [...left.terms.values()]
        .map((term) => term.get(TRIGGER_GUARD))
        .filter((value): value is string => value !== undefined),
    );
    return [...right.terms.values()].some((term) => {
      const trigger = term.get(TRIGGER_GUARD);
      return trigger !== undefined && leftTriggers.has(trigger);
    });
  }
  return [...left.terms.values()].some((leftTerm) =>
    [...right.terms.values()].some((rightTerm) =>
      termsCompatible(leftTerm, rightTerm),
    ),
  );
}

function accessPairConflicts(
  left: WorkflowWorkspaceAccess,
  right: WorkflowWorkspaceAccess,
): boolean {
  if (
    left === "none" ||
    right === "none"
  ) {
    return false;
  }
  if (left === "isolated_review" && right === "isolated_review") return false;
  if (left === "isolated_review") return right === "shared_write";
  if (right === "isolated_review") return left === "shared_write";
  return left === "shared_write" || right === "shared_write";
}

/**
 * Rejects graphs that could schedule two users of the shared workspace at the
 * same time when at least one can mutate it. Port guards prove ordinary Branch
 * alternatives mutually exclusive; imprecise cyclic activation fails closed.
 */
export function validateWorkflowV2WorkspaceAccessIssues(
  definition: WorkflowDefinitionV2,
): WorkflowDefinitionValidationIssue[] {
  const formulas = buildActivationFormulas(definition);
  const reachability = buildReachability(definition);
  const issues: WorkflowDefinitionValidationIssue[] = [];

  for (let leftIndex = 0; leftIndex < definition.nodes.length; leftIndex += 1) {
    const left = definition.nodes[leftIndex]!;
    const leftAccess = workflowWorkspaceAccessOf(left);
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < definition.nodes.length;
      rightIndex += 1
    ) {
      const right = definition.nodes[rightIndex]!;
      const rightAccess = workflowWorkspaceAccessOf(right);
      if (!accessPairConflicts(leftAccess, rightAccess)) continue;
      if (
        reachability.get(left.id)?.has(right.id) ||
        reachability.get(right.id)?.has(left.id)
      ) {
        continue;
      }
      if (
        !formulasCanOverlap(
          formulas.get(left.id) ?? emptyFormula(),
          formulas.get(right.id) ?? emptyFormula(),
        )
      ) {
        continue;
      }
      issues.push({
        code: "workspace.concurrent_access",
        severity: "error",
        nodeId: right.id,
        path: `/nodes/${rightIndex}`,
        message:
          `Blocks "${left.id}" and "${right.id}" can run concurrently while sharing a workspace; ` +
          "workspace readers and writers must be ordered or placed on mutually exclusive paths.",
      });
    }
  }

  return issues;
}
