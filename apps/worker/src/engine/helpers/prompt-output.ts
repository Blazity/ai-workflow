/* eslint-disable max-lines, max-lines-per-function */
import type { TokenPrice } from "@shared/costs";
import { type PriceLookup } from "../../sandbox/usage.js";
import type { ResearchRepository, ReviewOutput } from "../../sandbox/agents/types.js";
import type { AgentKind } from "../../sandbox/agents/index.js";
import { executionError, type StepsRecord } from "@shared/workflow-graph";
import { parseWorkflowDataReferenceV2, resolveWorkflowPromptDataTokensV2, type V2BindingResolutionContext } from "@shared/workflow-graph";
import type { BlockExecutionResult } from "@shared/workflow-graph";
import { resolveBlockAgent } from "../../workflow-definition/resolve-agent.js";
import { substitutePromptVariables, VARIABLE_PARAM_KEYS, type PromptVariableValues } from "@shared/prompts";
import type { WorkspacePublicationResult } from "../steps/workspace-publication.js";
import { type WorkspaceManifest } from "../../sandbox/repo-workspace.js";
import { resolveCallLlmTarget } from "../blocks/call-llm/execute.js";
import { RunBudgetError, missingRequiredPriceFailure } from "./run-budget.js";
import { BLOCK_EXECUTORS, INLINE_EXECUTED_BLOCK_TYPES } from "../blocks/executors.generated.js";
import { BLOCK_CATALOG, BLOCK_TYPE_SPECS } from "@shared/contracts";
import { DEFAULT_OPEN_PR_BODY, DEFAULT_OPEN_PR_TITLE } from "@shared/prompts";
import { REPO_MEMORY_DISTILL_CODEX_MODEL } from "@shared/harness";
export { REPO_MEMORY_DISTILL_CODEX_MODEL } from "@shared/harness";
import type { BlockOutput, BlockRunState, WorkflowBlockType, WorkflowDefinitionNode, WorkflowDefinitionV2, WorkflowDefinitionV2Node } from "@shared/contracts";
import type { TerminalStatus } from "./review-ledger.js";
import type { HumanDecision } from "../support/human-decisions-memory.js";
import type { EngineCtx } from "../blocks/support/types.js";
import { formatPRComments } from "../../sandbox/context.js";

type PromptVariableSource = Pick<
  EngineCtx,
  | "runId"
  | "ticket"
  | "ticketUrl"
  | "branchName"
  | "entry"
  | "researchPlanMarkdown"
  | "changeSummary"
  | "publication"
  | "selectedRepositories"
  | "repositoryContexts"
>;

/** Snapshot prompt variables at the current point of a run. */
export function buildPromptVariables(ctx: PromptVariableSource): PromptVariableValues {
  const { entry, ticket, publication, selectedRepositories, repositoryContexts } = ctx;
  const prEntry = entry.kind === "pr_trigger" ? entry.pr : null;
  const prReviewFeedback = repositoryContexts
    .filter((context) => context.prComments.length > 0)
    .map(
      (context) =>
        `### ${context.repository.provider}:${context.repository.repoPath}\n${formatPRComments(context.prComments)}`,
    )
    .join("\n\n");
  const openedPr = publication?.prs[0];
  return {
    ticket_key: ticket.identifier,
    ticket_title: ticket.title,
    ticket_url: ctx.ticketUrl,
    ticket_description: ticket.description,
    ticket_acceptance_criteria: ticket.acceptanceCriteria ?? "",
    ticket_labels: ticket.labels.join(", "),
    change_summary: ctx.changeSummary,
    branch_name: ctx.branchName,
    run_id: ctx.runId,
    plan_markdown: ctx.researchPlanMarkdown ?? "",
    pr_number: prEntry ? String(prEntry.prNumber) : openedPr ? String(openedPr.id) : "",
    pr_url: prEntry ? prEntry.prUrl : (openedPr?.url ?? ""),
    pr_title: prEntry ? prEntry.title : "",
    repo_path: prEntry ? prEntry.repoPath : (selectedRepositories[0]?.repoPath ?? ""),
    pr_review_feedback: prReviewFeedback,
  };
}

/** Append one durable answer round without duplicating a retry of the same answer. */
export function appendClarificationRound(
  history: HumanDecision[] | undefined,
  round: HumanDecision,
): HumanDecision[] {
  if (
    history?.some(
      (existing) =>
        existing.answer === round.answer &&
        existing.questions.join("\n") === round.questions.join("\n"),
    )
  ) {
    return history;
  }
  return [...(history ?? []), round];
}

/**
 * Model the repository-memory distill pins on the codex path. The distill is a
 * structured extraction, not agent work: resolveCallLlmTarget already pins the
 * the cheap catalog default on the claude path, but its codex branch returns
 * CODEX_MODEL, the full agent model, at roughly ten times the cost for the same
 * job. Not invented here: it is the cheapest codex id the deployment already
 * offers, FALLBACK_MODELS.codex in workflow-definition/models.ts. Only the
 * distill reads this; every other resolveCallLlmTarget consumer is unchanged.
 * Exported so a test can assert it against the deployment's own catalog: a
 * wrong id fails every distill on the codex path and the failure is only
 * logged, so nothing else would notice.
 */
/** The agent-block prompt override: a non-empty `prompt` param replaces the
 *  built-in phase template. Empty / whitespace / non-string falls through to the
 *  built-in prompt. */
const promptOverride = (node: WorkflowDefinitionNode): string | undefined => {
  const raw = node.params.prompt;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
};

export function resolveV2PromptDataConfiguration(
  node: WorkflowDefinitionV2Node,
  context: V2BindingResolutionContext,
  options: { preserveAgentPromptSource?: boolean } = {},
): WorkflowDefinitionV2Node["configuration"] {
  const keys = VARIABLE_PARAM_KEYS[node.type];
  if (!keys) return node.configuration;
  let changed = false;
  const configuration = { ...node.configuration };
  for (const key of keys) {
    if (
      options.preserveAgentPromptSource &&
      isV2AgentPromptField(node.type, key)
    ) {
      continue;
    }
    const value = node.configuration[key];
    if (typeof value === "string") {
      const resolved = resolveWorkflowPromptDataTokensV2(value, context);
      if (resolved !== value) {
        configuration[key] = resolved;
        changed = true;
      }
      continue;
    }
    if (!Array.isArray(value)) continue;
    let arrayChanged = false;
    const resolved = value.map((item) => {
      if (typeof item !== "string") return item;
      const next = resolveWorkflowPromptDataTokensV2(item, context);
      if (next !== item) arrayChanged = true;
      return next;
    });
    if (arrayChanged) {
      configuration[key] = resolved;
      changed = true;
    }
  }
  return changed ? configuration : node.configuration;
}

export function v2NonAgentPromptPlaceholderIssue(
  type: WorkflowBlockType,
  configuration: Readonly<Record<string, unknown>>,
): string | null {
  for (const field of VARIABLE_PARAM_KEYS[type] ?? []) {
    if (isV2AgentPromptField(type, field)) continue;
    const value = configuration[field];
    const values = typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    if (values.some((item) => item.includes("{{") || item.includes("}}"))) {
      return `${type} ${field} contains an unresolved placeholder.`;
    }
  }
  return null;
}

function isV2AgentPromptField(
  type: WorkflowBlockType,
  key: string,
): boolean {
  return (
    (
      type === "planning_agent" ||
      type === "implementation_agent" ||
      type === "review_agent" ||
      type === "generic_agent"
    ) &&
    key === "prompt"
  ) || (type === "fix_agent" && key === "instructions");
}

export function v2OpenPrRepositoriesProvenanceIssue(input: {
  node: WorkflowDefinitionV2Node;
  definition: WorkflowDefinitionV2;
  steps: Readonly<Record<string, { output: BlockOutput }>>;
  resolvedInputs: Readonly<Record<string, unknown>>;
  publication: WorkspacePublicationResult | null;
}): string | null {
  if (input.node.type !== "open_pr") return null;
  const binding = input.node.inputs.repositories;
  if (binding?.kind !== "reference") {
    return "Open PR/MR repositories must come from a Finalize Workspace output.";
  }
  const parsed = parseWorkflowDataReferenceV2(binding.reference);
  const source =
    parsed?.root === "steps"
      ? input.definition.nodes.find((node) => node.id === parsed.nodeId)
      : undefined;
  if (
    parsed?.root !== "steps" ||
    parsed.path.length !== 1 ||
    parsed.path[0] !== "repositories" ||
    source?.type !== "finalize_workspace"
  ) {
    return "Open PR/MR repositories must bind exactly to a Finalize Workspace repositories output.";
  }
  const sourceRepositories =
    input.steps[parsed.nodeId]?.output.repositories;
  if (
    !Array.isArray(sourceRepositories) ||
    JSON.stringify(sourceRepositories) !==
      JSON.stringify(input.resolvedInputs.repositories)
  ) {
    return "Open PR/MR repositories do not match the bound Finalize Workspace output.";
  }
  if (
    input.publication?.status !== "finalized" ||
    JSON.stringify(input.publication.repositories) !==
      JSON.stringify(sourceRepositories)
  ) {
    return "Open PR/MR has no matching finalized publication boundary.";
  }
  return null;
}

/** Action block types with no executor wired in either BLOCK_EXECUTORS or an
 *  inline switch. */
export function blockTypesMissingExecutor(): WorkflowBlockType[] {
  return (Object.keys(BLOCK_TYPE_SPECS) as WorkflowBlockType[])
    .filter(
      (type) =>
        BLOCK_TYPE_SPECS[type].category === "action" &&
        BLOCK_CATALOG[type].execution !== "graph" &&
        BLOCK_EXECUTORS[type] === undefined &&
        !INLINE_EXECUTED_BLOCK_TYPES.includes(type),
    );
}

export function buildImplementationAgentSuccessOutput(input: {
  workspaceId: string;
  workspaceManifest: WorkspaceManifest;
  commits: Array<{ provider: "github" | "gitlab"; repoPath: string; sha: string }>;
  summary?: string | null;
  verification?: BlockOutput["verification"];
}): BlockOutput {
  const changedRepositories = new Set(
    input.commits.map((commit) => `${commit.provider}:${commit.repoPath}`),
  );
  return {
    status: "implemented",
    workspaceId: input.workspaceId,
    branches: input.workspaceManifest.repositories
      .filter((repository) =>
        changedRepositories.has(`${repository.provider}:${repository.repoPath}`),
      )
      .map((repository) => ({
        provider: repository.provider,
        repoPath: repository.repoPath,
        branch: repository.branchName,
      })),
    commits: input.commits.map((commit) => ({ ...commit })),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    summary: input.summary?.trim() || "Implementation completed.",
  };
}

export function buildReviewAgentSuccessOutput(
  review: Pick<ReviewOutput, "feedback" | "issues">,
  workspaceManifest?: WorkspaceManifest,
): BlockOutput {
  const feedback = review.feedback.trim();
  const repositoryByLocalPath = new Map(
    workspaceManifest?.repositories.map((repository) => [
      repository.localPath,
      repository.repoPath,
    ]) ?? [],
  );
  // Strict-mode providers must emit every key, so a missing line arrives as
  // null. The Review Result contract accepts positive integers only, so those
  // nulls are dropped here instead of failing validation downstream.
  const line = (value: number | null | undefined): number | undefined =>
    typeof value === "number" && value >= 1 ? value : undefined;
  const findings = review.issues.map((finding) => {
    const startLine = line(finding.startLine);
    // The Review Result normalizer rejects an endLine without a startLine and
    // an endLine below its startLine, so neither shape may reach the output.
    const candidateEnd = line(finding.endLine);
    const endLine =
      startLine !== undefined &&
      candidateEnd !== undefined &&
      candidateEnd >= startLine
        ? candidateEnd
        : undefined;
    return {
      file: finding.file,
      description: finding.description,
      severity: finding.severity,
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
      ...(typeof finding.repo === "string"
        ? {
            repo:
              repositoryByLocalPath.get(finding.repo) ?? finding.repo,
          }
        : {}),
    };
  });
  const writableRepositories =
    workspaceManifest?.version === 2
      ? new Set(
          workspaceManifest.repositories
            .filter((repository) => repository.access === "write")
            .map((repository) => repository.repoPath),
        )
      : undefined;
  const blocksPublication = findings.some(
    (finding) =>
      (finding.severity === "Blocker" || finding.severity === "High") &&
      (writableRepositories === undefined ||
        finding.repo === undefined ||
        writableRepositories.has(finding.repo)),
  );
  return {
    status: "reviewed",
    findings,
    decision: blocksPublication ? "request_changes" : "approve",
    ...(feedback ? { feedback } : {}),
  };
}

export function reviewAgentExecutionResult(
  review: ReviewOutput,
  workspaceManifest?: WorkspaceManifest,
): BlockExecutionResult {
  return {
    kind: "next",
    output: buildReviewAgentSuccessOutput(review, workspaceManifest),
  };
}

type PublishedPullRequests = Extract<
  WorkspacePublicationResult,
  { status: "published" }
>["prs"];

export function buildOpenPrSuccessOutput(prs: PublishedPullRequests): BlockOutput {
  const primary = prs[0];
  if (!primary) throw new Error("published workspace has no pull requests");
  return {
    status: "ok",
    prs: prs.map((pr) => ({
      provider: pr.provider,
      repoPath: pr.repoPath,
      id: pr.id,
      url: pr.url,
      branch: pr.branch,
      isNew: pr.isNew,
    })),
    // Kept for dashboard telemetry and bindings authored against PR #118.
    prUrl: primary.url,
    prNumber: primary.id,
  };
}

export function modelsRequiringPriceLookup(
  nodes: WorkflowDefinitionNode[],
  runDefaultKind: AgentKind,
  defaults: { claude: string; codex: string },
): Set<string> {
  const models = new Set<string>();
  for (const node of nodes) {
    if (
      node.type === "planning_agent" ||
      node.type === "implementation_agent" ||
      node.type === "review_agent" ||
      node.type === "fix_agent" ||
      node.type === "generic_agent"
    ) {
      const resolved = resolveBlockAgent(node.params, runDefaultKind, defaults);
      if (resolved.kind === "codex") models.add(resolved.model);
    } else if (node.type === "call_llm") {
      models.add(resolveCallLlmTarget(node.params, runDefaultKind, defaults).model);
    }
  }
  return models;
}

/**
 * Provider and model the repository-memory distill calls with. Shared by the
 * price prefetch and the distill call site so the two cannot drift: a phase
 * whose model is missing from the price map reports an unknown cost, and one
 * unknown phase marks the WHOLE run's cost unknown.
 */
export function repoMemoryDistillTarget(
  runDefaultKind: AgentKind,
  defaults: { claude: string; codex: string },
): { provider: "claude" | "codex" | undefined; model: string } {
  return resolveCallLlmTarget(
    runDefaultKind === "codex"
      ? { provider: "codex", model: REPO_MEMORY_DISTILL_CODEX_MODEL }
      : {},
    runDefaultKind,
    defaults,
  );
}

/**
 * Models worth pricing whose price must never fail a run. The distill is
 * observed and never enforced (an exhausted budget skips it), so feeding its
 * model to missingRequiredPriceFailure would let a missing LiteLLM entry fail a
 * run with maxCostUsd set over a call the run does not depend on. Both providers
 * are covered: the claude default reaches the price map today only when the
 * definition happens to contain a call_llm block, and the codex one not at all.
 */
export function optionalPricedModelsForRun(input: {
  enableRepoMemory: boolean;
  runDefaultKind: AgentKind;
  defaults: { claude: string; codex: string };
}): Set<string> {
  if (!input.enableRepoMemory) return new Set();
  return new Set([
    repoMemoryDistillTarget(input.runDefaultKind, input.defaults).model,
  ]);
}

/**
 * Fetch every model price the run can need, then build the lookup the telemetry
 * and budget paths read. Prices are fetched for the required and the optional
 * models alike; only a missing REQUIRED price fails the run, which is what keeps
 * an optional model from turning a missing LiteLLM entry into a budget failure.
 * Returns undefined when there is nothing to price, leaving the caller's lookup
 * unset exactly as before.
 */
export async function resolveRunPriceLookup(input: {
  requiredModels: ReadonlySet<string>;
  optionalModels: ReadonlySet<string>;
  maxCostUsd: number | undefined;
  fetchPrice: (model: string) => Promise<TokenPrice | null>;
}): Promise<PriceLookup | undefined> {
  // fetchPrice is a workflow step. Invoking it as a property of `input` captures
  // `input` as the call receiver, and the Workflow SDK then tries to serialize
  // that receiver. Destructure first so every call is a free-function call with
  // serializable arguments only (same reason as createHarnessInvocationBudget).
  const { fetchPrice } = input;
  // Insertion order, so the sequence of price steps stays deterministic across
  // a replay.
  const toFetch = [...new Set([...input.requiredModels, ...input.optionalModels])];
  if (toFetch.length === 0) return undefined;

  const priceMap = new Map<string, TokenPrice>();
  for (const model of toFetch) {
    const price = await fetchPrice(model);
    if (price) priceMap.set(model, price);
  }
  const missingPriceFailure = missingRequiredPriceFailure(
    input.maxCostUsd,
    input.requiredModels,
    priceMap,
  );
  if (missingPriceFailure) throw new RunBudgetError(missingPriceFailure);
  return (model) => priceMap.get(model) ?? null;
}

export function blockRunStateSummary(state: BlockRunState): BlockRunState {
  const { output: _output, ...summary } = state;
  return summary;
}

/**
 * Who a run-level failure belongs to, given the blocks in flight.
 *
 * One block in flight means the failure is that block's. Several means there is
 * no honest answer, so return null and let the caller report the engine rather
 * than blaming a sibling. Reading the last entry of the set would do exactly
 * that: Set iteration is insertion order, so it attributes a shared failure to
 * whichever block happened to start last in wall-clock terms, which under
 * concurrency is an accident and lands a real failure on an innocent block.
 */
export function soleActiveBlockId(
  activeBlockIds: ReadonlySet<string>,
): string | null {
  if (activeBlockIds.size !== 1) return null;
  const [onlyActive] = activeBlockIds;
  return onlyActive ?? null;
}

export function resolveSlackMessageInput(
  params: Record<string, unknown>,
  resolvedInputs: Record<string, unknown>,
): string {
  return typeof resolvedInputs.message === "string"
    ? resolvedInputs.message.trim()
    : typeof params.message === "string"
      ? params.message.trim()
      : "";
}

export function resolveTicketStatusInput(
  params: Record<string, unknown>,
  resolvedInputs: Record<string, unknown>,
): string {
  const target = typeof resolvedInputs.target === "string" ? resolvedInputs.target : params.target;
  if (typeof target !== "string" || target.trim() === "") {
    throw new Error("Update Ticket Status requires a non-empty status target.");
  }
  return target.trim();
}

/** The implementation block's own account of what it changed, read from the
 *  durable step outputs so it survives workflow replay (the implementation case
 *  may be skipped on resume, yet its output persists in `steps`). Backs
 *  {{change_summary}} for the open_pr description; empty until an
 *  implementation_agent block has produced a summary. */
export function implementationChangeSummary(
  steps: StepsRecord,
  nodes: WorkflowDefinitionNode[],
): string {
  for (const node of nodes) {
    if (node.type !== "implementation_agent") continue;
    const summary = steps[node.id]?.output?.summary;
    if (typeof summary === "string" && summary.trim() !== "") return summary;
  }
  return "";
}

/** Whether the planning run promotes the research write set right after research
 *  completes. Two cases skip it, in both of which promoting here would be wrong:
 *  - Approval-gated graphs (a send_plan_approval node). Promoting before approval
 *    creates a remote branch plus a workflow-owned-branches ledger row that a
 *    rejected plan would never clean up, force-pinning the repo into every future
 *    selection. The approved implementation run re-creates the scope and promotes
 *    from the approved plan instead, so the branch is created only on approval.
 *  - An empty write set (a research-only ticket: investigation, question, or "no
 *    changes needed"). There is nothing to promote; recording the empty set is
 *    enough, and a downstream code-writing block fails loud via the requireWrite
 *    guard rather than dying at publication.
 *  ctx.researchWriteRepositories is recorded regardless so send_plan_approval can
 *  persist the correct write scope for the approved run. */
export function shouldPromoteResearchWriteScope(input: {
  definitionNodes: WorkflowDefinitionNode[];
  writeRepositories: ResearchRepository[];
  manifestVersion: 1 | 2 | undefined;
}): boolean {
  if (input.manifestVersion !== 2) return false;
  if (input.writeRepositories.length === 0) return false;
  if (input.definitionNodes.some((node) => node.type === "send_plan_approval")) {
    return false;
  }
  return true;
}

/** open_pr title: a binding wins, else the authored (already {{var}}-substituted)
 *  template param, else the default template resolved against `vars`. */
export function resolveOpenPrTitle(
  params: Record<string, unknown>,
  resolvedInputs: Record<string, unknown>,
  vars: PromptVariableValues,
): string {
  const bound = typeof resolvedInputs.title === "string" ? resolvedInputs.title.trim() : "";
  if (bound !== "") return bound;
  const authored = typeof params.title === "string" ? params.title.trim() : "";
  if (authored !== "") return authored;
  return substitutePromptVariables(DEFAULT_OPEN_PR_TITLE, vars).trim();
}

/** open_pr body: same precedence as the title. Whitespace is preserved for the
 *  authored/bound value so markdown structure survives; only emptiness decides
 *  the fallback. */
export function resolveOpenPrBody(
  params: Record<string, unknown>,
  resolvedInputs: Record<string, unknown>,
  vars: PromptVariableValues,
): string {
  const bound = typeof resolvedInputs.body === "string" ? resolvedInputs.body : "";
  if (bound.trim() !== "") return bound;
  const authored = typeof params.body === "string" ? params.body : "";
  if (authored.trim() !== "") return authored;
  return substitutePromptVariables(DEFAULT_OPEN_PR_BODY, vars);
}

function publicationPrForTelemetry(
  publication: WorkspacePublicationResult | null | undefined,
): { url: string; number: number } | null {
  if (publication?.status !== "published") return null;
  const primary = publication.prs[0];
  return primary ? { url: primary.url, number: primary.id } : null;
}

export function v2TerminalBlockResult(input: {
  terminalStatus: TerminalStatus;
  postComment?: string;
  clarificationAnswer?: string;
}): BlockExecutionResult {
  if (input.terminalStatus === "failed") {
    return executionError(
      input.postComment?.trim() || "Terminated by workflow.",
      { category: "engine", phase: "terminate" },
    );
  }
  if (input.terminalStatus === "waiting_for_human") {
    if (input.clarificationAnswer !== undefined) {
      return { kind: "next", output: { status: "done" } };
    }
    return {
      kind: "needs_human_input",
      output: { status: "waiting_for_human" },
      questions: [
        input.postComment?.trim() || "Waiting for human input.",
      ],
    };
  }
  return {
    kind: "next",
    output: { status: input.terminalStatus },
  };
}
export { promptOverride, publicationPrForTelemetry };
