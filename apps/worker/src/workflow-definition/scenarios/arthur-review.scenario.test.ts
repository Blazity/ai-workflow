import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  resolveBuiltinHarnessProfile,
  type BlockOutput,
  type HarnessProfileReference,
  type HarnessProfileResolvedVersion,
  type JsonValue,
  type ReviewResult,
  type ReviewResultFinding,
  type VcsProviderKind,
  type WorkflowBlockType,
  type WorkflowDataReferenceV2,
  type WorkflowDefinitionV2,
  type WorkflowDefinitionV2Node,
} from "@shared/contracts";
import { hashHarnessProfileManifest } from "../../harness-profiles/manifest.js";
import type { PrTriggerType } from "../../lib/trigger-events.js";
import type { AgentWorkflowInput } from "../../workflows/agent-input.js";
import { buildReviewAgentSuccessOutput } from "../../workflows/agent.js";
import {
  partitionReviewFindings,
  reviewPublicationDecision,
} from "../../workflows/pr-external-resources.js";
import type { WorkflowBlockRegistryContext } from "../block-registry.js";
import { clampBothEnds } from "../failure-message.js";
import { validateHarnessProfileReferencesWithLoader } from "../harness-profile-runtime.js";
import { executionError } from "../interpreter.js";
import { validateWorkflowDefinitionIssuesForDeployment } from "../schema.js";
import {
  executorRunsOf,
  expectNeverInvoked,
  expectStartsAfterFinishOf,
  portsOf,
} from "./assertions.js";
import {
  createScenario,
  type Scenario,
  type ScenarioOutcome,
} from "./harness.js";

/**
 * Arthur's private post-PR review workflow (AIW-221) as an executable
 * specification. It is a client deliverable, not a product template: it must
 * never be added to `templates.ts`, so it is authored here and committed as a
 * snapshot, and every scenario runs that committed JSON through the production
 * v2 scheduler. The two triggers and the Branch are resolved by the scheduler
 * itself; only action blocks are scripted.
 *
 * VERDICTS ARE NEVER STATED BY A SCENARIO, exactly as in
 * `post-pr-review.scenario.test.ts`: a scenario supplies findings and asserts
 * the verdict, because `buildReviewAgentSuccessOutput` owns the severity rule
 * and the Post PR review script only reproduces the one rule
 * `publishRunOwnedPrReview` applies over the results it is handed.
 *
 * THE REVIEWER COUNT IS AN OPEN DECISION, so the definition comes from a
 * function taking the reviewer shape and the scenarios run over
 * `REVIEW_SHAPES`. `one_agent` is the shape the ticket describes and the only
 * one with a snapshot. `one_agent_per_repository` is built by the same
 * function, and the last describe in this file asserts why it has no snapshot:
 * as drawn it does not deploy.
 *
 * There is no fan-out in either shape and therefore no concurrency to prove, so
 * no scenario here holds a barrier. There is no Loop either, so every block runs
 * at most once, on attempt 1, in the single "root" activation scope.
 */

const CHECK_NAME = "AI Workflow / Review";

/** The pinned Harness Profile. The client's own profile, the one carrying the
 * private review skills, does not exist yet; this pin is the built-in profile
 * the installation always has, and the profile test below proves it satisfies
 * the workspace requirement `harness-profile-runtime.ts` enforces.
 *
 * The version tracks the code-owned catalog, NOT whatever a live installation
 * pinned. A deployed definition keeps the version it was authored against, and
 * its database keeps that row immutably, so Arthur's live pin may still be
 * version 1 on claude-opus-4-6 until someone repins it. This constant is a
 * fixture: `resolveBuiltinHarnessProfile` only resolves the current catalog
 * version, so a scenario can only ever exercise that one. */
const PINNED_PROFILE: HarnessProfileReference = {
  profileId: "builtin-claude",
  version: 2,
};

const PINNED_PROVIDERS: VcsProviderKind[] = ["github", "gitlab"];

interface ArthurRepository {
  key: string;
  provider: VcsProviderKind;
  repoPath: string;
  /** Review skill that carries this repository's guidance. */
  skill: string;
  row: number;
}

/** The three repositories the client approved. Casing is the client's own: the
 * GitHub organisation is lower-case-hyphenated and the GitLab group is not. */
const REPOSITORIES: readonly ArthurRepository[] = [
  {
    key: "scope",
    provider: "gitlab",
    repoPath: "ArthurAI/arthur-scope",
    skill: "arthur-scope-backend-review",
    row: -1,
  },
  {
    key: "unify",
    provider: "gitlab",
    repoPath: "ArthurAI/unify-frontend",
    skill: "arthur-unify-frontend-review",
    row: 0,
  },
  {
    key: "engine",
    provider: "github",
    repoPath: "arthur-ai/arthur-engine",
    skill: "arthur-engine-monorepo-review",
    row: 1,
  },
];

const SUCCESS_DETAILS = "The Arthur review approved this commit.";

/**
 * The failure check text is FIXED, not bound. `details` is shaped for GitHub,
 * where a check run carries a long summary, but two of the three pinned
 * repositories are GitLab, where the same value becomes a commit-status
 * description that `GitLabAdapter.updateGateStatus` clamps to 255 characters.
 * Binding the review summary here would put a model-authored paragraph through
 * that clamp; the review itself is published in full by Post PR review.
 */
const FAILURE_DETAILS =
  "The Arthur review requested changes. See the review on this pull request.";

const SINGLE_AGENT_PROMPT =
  "Review this pull request against the Arthur review skills attached to this Harness Profile. Load arthur-review-core first, then the one repository skill that matches the repository under review. Do not modify files. Report concrete findings only.";

function perRepositoryPrompt(repository: ArthurRepository): string {
  return `Review this pull request in ${repository.repoPath}. Load arthur-review-core first, then ${repository.skill}. Do not modify files. Report concrete findings only.`;
}

interface BlockSpec {
  id: string;
  type: WorkflowBlockType;
  name: string;
  column: number;
  row?: number;
  configuration?: Record<string, JsonValue>;
  inputs?: Record<string, WorkflowDefinitionV2Node["inputs"][string]>;
}

interface EdgeSpec {
  from: string;
  to: string;
  fromPort?: string;
}

type ReviewerShape = "one_agent" | "one_agent_per_repository";

/** First of the two routing columns the per-repository shape needs. */
const ROUTING_COLUMN = 3;

/** Editor columns. The per-repository shape spends two columns on routing, so
 * the tail sits further right; the single-agent graph stays contiguous. */
const COLUMNS = {
  one_agent: { review: 3, postReview: 4, verdict: 5, completion: 6 },
  one_agent_per_repository: {
    review: 5,
    postReview: 6,
    verdict: 7,
    completion: 8,
  },
} as const;

function reviewerNodeId(
  shape: ReviewerShape,
  repository: ArthurRepository,
): string {
  return shape === "one_agent" ? "review" : `review-${repository.key}`;
}

function reviewAgentSpecs(shape: ReviewerShape): BlockSpec[] {
  if (shape === "one_agent") {
    return [
      {
        id: "review",
        type: "review_agent",
        name: "Arthur review",
        column: COLUMNS.one_agent.review,
        configuration: {
          harnessProfile: { ...PINNED_PROFILE },
          prompt: SINGLE_AGENT_PROMPT,
        },
      },
    ];
  }
  return REPOSITORIES.map((repository) => ({
    id: reviewerNodeId(shape, repository),
    type: "review_agent" as const,
    name: `Review ${repository.repoPath}`,
    column: COLUMNS.one_agent_per_repository.review,
    row: repository.row,
    configuration: {
      harnessProfile: { ...PINNED_PROFILE },
      prompt: perRepositoryPrompt(repository),
    },
  }));
}

/** The two Branches that pick one reviewer for the repository under review.
 * They read `steps.entry.output.repoPath`, never a single trigger's output:
 * both PR triggers publish the same field, so the reference resolves whichever
 * one fired. A Branch has exactly two ports, so three repositories need two of
 * them, and the second Branch's false port carries the third repository. */
function routingSpecs(): BlockSpec[] {
  return REPOSITORIES.slice(0, 2).map((repository, index) => ({
    id: `route-${repository.key}`,
    type: "branch" as const,
    name: `Is this ${repository.repoPath}?`,
    column: ROUTING_COLUMN + index,
    row: index,
    configuration: {
      combinator: "all",
      conditions: [
        {
          reference: "steps.entry.output.repoPath",
          operator: "equals",
          value: repository.repoPath,
          ignoreCase: true,
        },
      ],
    },
  }));
}

function routingEdges(): EdgeSpec[] {
  const [scope, unify, engine] = REPOSITORIES;
  return [
    { from: "prepare", to: `route-${scope.key}` },
    {
      from: `route-${scope.key}`,
      to: `review-${scope.key}`,
      fromPort: "true",
    },
    { from: `route-${scope.key}`, to: `route-${unify.key}`, fromPort: "false" },
    {
      from: `route-${unify.key}`,
      to: `review-${unify.key}`,
      fromPort: "true",
    },
    {
      from: `route-${unify.key}`,
      to: `review-${engine.key}`,
      fromPort: "false",
    },
  ];
}

function edgeId(index: number, edge: EdgeSpec): string {
  return [
    "arthur-post-pr-review",
    String(index + 1).padStart(2, "0"),
    edge.from,
    edge.fromPort ?? "out",
    edge.to,
  ].join("-");
}

/**
 * The client definition, authored here because the editor cannot build it yet
 * and because it must stay out of the product's template catalogue. The
 * reviewer count is the only parameter: everything else is shared, so the
 * committed snapshot changes in exactly one place when the decision lands.
 */
function buildArthurReviewDefinition(
  shape: ReviewerShape,
): WorkflowDefinitionV2 {
  const reviewers = reviewAgentSpecs(shape);
  const columns = COLUMNS[shape];
  const specs: BlockSpec[] = [
    {
      id: "trigger-ready",
      type: "trigger_pr_ready",
      name: "PR ready for review",
      column: 0,
      row: -1,
      configuration: { providers: [...PINNED_PROVIDERS], scope: "any" },
    },
    {
      id: "trigger-updated",
      type: "trigger_pr_updated",
      name: "PR updated",
      column: 0,
      row: 1,
      configuration: { providers: [...PINNED_PROVIDERS], scope: "any" },
    },
    {
      id: "create-check",
      type: "create_pr_check",
      name: "Create review check",
      column: 1,
      configuration: { checkName: CHECK_NAME },
    },
    {
      id: "prepare",
      type: "prepare_workspace",
      name: "Prepare exact-head workspace",
      column: 2,
    },
    ...(shape === "one_agent" ? [] : routingSpecs()),
    ...reviewers,
    {
      id: "post-review",
      type: "post_pr_review",
      name: "Post PR review",
      column: columns.postReview,
      inputs: {
        reviewResults: {
          kind: "reference_list",
          references: reviewers.map(
            (reviewer) => `steps.${reviewer.id}.output` as WorkflowDataReferenceV2,
          ),
        },
      },
    },
    {
      id: "review-approved",
      type: "branch",
      name: "Review approved?",
      column: columns.verdict,
      configuration: {
        combinator: "all",
        conditions: [
          {
            reference: "steps.post-review.output.decision",
            operator: "equals",
            value: "approve",
          },
        ],
      },
    },
    {
      id: "complete-success",
      type: "complete_pr_check",
      name: "Pass review check",
      column: columns.completion,
      row: -1,
      configuration: { conclusion: "success", details: SUCCESS_DETAILS },
      inputs: {
        check: {
          kind: "reference",
          reference: "steps.create-check.output.check",
        },
      },
    },
    {
      id: "complete-failure",
      type: "complete_pr_check",
      name: "Fail review check",
      column: columns.completion,
      row: 1,
      configuration: { conclusion: "failure", details: FAILURE_DETAILS },
      inputs: {
        check: {
          kind: "reference",
          reference: "steps.create-check.output.check",
        },
      },
    },
  ];
  const edges: EdgeSpec[] = [
    { from: "trigger-ready", to: "create-check" },
    { from: "trigger-updated", to: "create-check" },
    { from: "create-check", to: "prepare" },
    ...(shape === "one_agent"
      ? [{ from: "prepare", to: "review" }]
      : routingEdges()),
    ...reviewers.map((reviewer) => ({
      from: reviewer.id,
      to: "post-review",
    })),
    { from: "post-review", to: "review-approved" },
    { from: "review-approved", to: "complete-success", fromPort: "true" },
    { from: "review-approved", to: "complete-failure", fromPort: "false" },
  ];
  return {
    schemaVersion: 2,
    repositoryScope: {
      repositories: REPOSITORIES.map((repository) => ({
        provider: repository.provider,
        repoPath: repository.repoPath,
      })),
      providers: [...PINNED_PROVIDERS],
    },
    nodes: specs.map((spec) => ({
      id: spec.id,
      type: spec.type,
      name: spec.name,
      x: 40 + spec.column * 260,
      y: 280 + (spec.row ?? 0) * 180,
      configuration: spec.configuration ?? {},
      inputs: spec.inputs ?? {},
      additionalInputs: [],
    })),
    edges: edges.map((edge, index) => ({
      id: edgeId(index, edge),
      from: edge.from,
      to: edge.to,
      ...(edge.fromPort === undefined ? {} : { fromPort: edge.fromPort }),
    })),
  };
}

/** How every scenario reaches the graph: the committed JSON, through the
 * schema and the deployment validation the snapshot loader applies. */
const SINGLE_AGENT_SNAPSHOT = { path: "arthur-post-pr-review-v1.json" };

function committedSnapshotText(path: string): string {
  return readFileSync(new URL(`./snapshots/${path}`, import.meta.url), "utf8");
}

/**
 * What the installation offers, stated the way the snapshot loader states it in
 * `harness.ts`: every provider declared present and the environment
 * availability pass switched off, so these checks are about the definition's
 * shape rather than about this machine's configuration.
 */
const REGISTRY_CONTEXT: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-scenario" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

/** One arm of the graph: the blocks that review one repository and decide its
 * check. The shape descriptor exists so the same scenario body covers a single
 * reviewer and a per-repository reviewer without branching inside an
 * assertion. */
interface ReviewArm {
  reviewer: string;
  postReview: string;
  verdict: string;
  /** Reviewers that must not run for this repository. */
  idleReviewers: string[];
}

interface ReviewShape {
  name: string;
  shape: ReviewerShape;
  snapshot: { path: string };
  arm(repository: ArthurRepository): ReviewArm;
}

/**
 * The shapes with a committed snapshot. `one_agent_per_repository` is missing
 * on purpose: it does not deploy, which the last describe in this file proves.
 */
const REVIEW_SHAPES: readonly ReviewShape[] = [
  {
    name: "one review agent",
    shape: "one_agent",
    snapshot: SINGLE_AGENT_SNAPSHOT,
    arm: () => ({
      reviewer: "review",
      postReview: "post-review",
      verdict: "review-approved",
      idleReviewers: [],
    }),
  },
];

/** The handle Create review check publishes. Every completion addresses the
 * check by this value, so it is the one piece of data that must cross the graph
 * unchanged. */
const CHECK_REF = {
  id: "check-1",
  headSha: "abc123",
  name: CHECK_NAME,
};

const APPROVED_SUMMARY = "The review approved this commit.";
const REQUEST_CHANGES_SUMMARY = "One blocking finding must be resolved.";

function prEntry(
  triggerType: PrTriggerType,
  repository: ArthurRepository,
): AgentWorkflowInput {
  return {
    kind: "pr_trigger",
    triggerType,
    subjectKey: `pr:${repository.provider}:${repository.repoPath}#7`,
    ownerToken: "owner-1",
    definitionId: 1,
    definitionVersion: 1,
    scope: "any",
    pr: {
      provider: repository.provider,
      repoPath: repository.repoPath,
      prNumber: 7,
      prUrl: `https://${repository.provider}.test/${repository.repoPath}/pull/7`,
      headRef: "feature",
      headSha: CHECK_REF.headSha,
      baseRef: "main",
      title: "Add a feature",
      author: "contributor",
      isDraft: false,
    },
  };
}

function snapshotScenario(
  reviewShape: ReviewShape,
  triggerType: PrTriggerType,
  entryTriggerId: string,
  repository: ArthurRepository,
): Scenario {
  return createScenario({
    snapshot: reviewShape.snapshot,
    entry: prEntry(triggerType, repository),
    entryTriggerId,
  });
}

/** How a trigger node appears in the record, which is what tells "did not fire"
 * apart from "is not in the graph". */
function triggerRecordsOf(
  outcome: ScenarioOutcome,
  nodeId: string,
): unknown[] {
  return outcome.invocationsOf(nodeId).map((invocation) => ({
    attempt: invocation.attempt,
    activationScopeId: invocation.activationScopeId,
    enteredExecutor: invocation.enteredExecutor,
    skipped: invocation.skipped,
  }));
}

/**
 * A review output exactly as the product builds one. The decision is
 * deliberately not stated by the caller: it comes from the production builder,
 * so a scenario cannot claim a verdict the shipped severity rule would not
 * reach.
 */
function reviewOutputFor(
  nodeId: string,
  findings: readonly ReviewResultFinding[],
): BlockOutput {
  return buildReviewAgentSuccessOutput({
    feedback: `${nodeId} reviewed the head commit.`,
    issues: findings.map((finding) => ({ ...finding })),
  });
}

function reviewFeedbackOf(nodeId: string): string {
  return `${nodeId} reviewed the head commit.`;
}

/** Everything the graph needs before its review. */
function scriptPrelude(
  scenario: Scenario,
  repository: ArthurRepository,
): void {
  const repositories = [`${repository.provider}:${repository.repoPath}`];
  scenario.script({ nodeId: "create-check" }, {
    kind: "next",
    output: { status: "ok", check: CHECK_REF },
  });
  scenario.script({ nodeId: "prepare" }, {
    kind: "next",
    output: {
      status: "ok",
      sandboxId: "sbx-arthur",
      repositories,
      workspace: { id: "sbx-arthur", repositories },
    },
  });
}

/**
 * Post PR review. ONLY the verdict follows production, and it is not reproduced
 * here at all: `reviewPublicationDecision` IS the function
 * `publishRunOwnedPrReview` calls, over the clusters `partitionReviewFindings`
 * builds out of the resolved inputs. That matters most to this definition, which
 * runs a single reviewer: the published gate demands agreement from at most as
 * many reviewers as the graph has, so a rule change that forgot the single
 * reviewer case fails here instead of quietly stopping this client's checks from
 * ever going red.
 *
 * The empty file list is the single difference from the production call. That
 * list decides only whether a finding can be anchored to the diff; the
 * clustering the verdict reads is a pure function of the findings themselves.
 *
 * The two counts are contract filler, not aggregation. The block contract
 * requires them and no edge in this graph binds either one; production derives
 * them from the same partition, which needs the provider's file list and is not
 * reproduced here.
 */
function scriptPostReview(scenario: Scenario, arm: ReviewArm): void {
  scenario.script({ nodeId: arm.postReview }, (_node, inputs) => {
    const results = inputs.reviewResults as ReviewResult[];
    const decision = reviewPublicationDecision(
      partitionReviewFindings(results, []).merged,
      results.length,
    );
    return {
      kind: "next",
      output: {
        status: "ok",
        decision,
        summary:
          decision === "approve" ? APPROVED_SUMMARY : REQUEST_CHANGES_SUMMARY,
        inlineCommentCount: results.reduce(
          (total, result) => total + result.findings.length,
          0,
        ),
        summaryFallbackCount: 0,
      },
    };
  });
}

interface CompletionConfiguration {
  conclusion?: JsonValue;
  details?: JsonValue;
}

/**
 * Scripts a completion block and reports back the configuration the graph
 * dispatched, so a scenario asserts the conclusion the definition carries
 * instead of the one it wished for. The output is built from the resolved
 * inputs, as production does, so the check the block reports is the check it
 * was handed.
 */
function scriptCompletion(
  scenario: Scenario,
  nodeId: string,
): CompletionConfiguration {
  const configured: CompletionConfiguration = {};
  scenario.script({ nodeId }, (node, inputs) => {
    configured.conclusion = node.configuration.conclusion;
    configured.details = node.configuration.details;
    return {
      kind: "next",
      output: {
        status: "ok",
        check: inputs.check as JsonValue,
        conclusion: node.configuration.conclusion,
      },
    };
  });
  return configured;
}

/**
 * Asserts that the check handle reached a completion block exactly as Create
 * review check emitted it. Deep equality alone is not the claim: the provider
 * call is addressed by this object, so a re-keyed or re-serialized copy would
 * complete a different check, or none. The serialized forms are compared as
 * well, which also pins key order.
 */
function expectCheckPassedThrough(
  outcome: ScenarioOutcome,
  completionNodeId: string,
): void {
  const created = executorRunsOf(outcome, "create-check");
  expect(created).toHaveLength(1);
  const createdResult = created[0].result;
  expect(createdResult?.kind).toBe("next");
  const emitted =
    createdResult?.kind === "next" ? createdResult.output.check : null;
  const completion = executorRunsOf(outcome, completionNodeId);
  expect(completion).toHaveLength(1);
  const carried = completion[0].resolvedInputs?.check;
  expect(carried).toEqual(emitted);
  expect(JSON.stringify(carried)).toBe(JSON.stringify(emitted));
}

/** One review result as Post PR review receives it. */
function expectedReviewResult(
  nodeId: string,
  decision: "approve" | "request_changes",
  findings: readonly ReviewResultFinding[],
): unknown {
  return {
    status: "reviewed",
    decision,
    feedback: reviewFeedbackOf(nodeId),
    findings: findings.map((finding) => ({ ...finding })),
  };
}

describe("Arthur post-PR review: the committed definition", () => {
  for (const reviewShape of REVIEW_SHAPES) {
    it(`snapshots exactly what the authoring function builds (${reviewShape.name})`, () => {
      const built = buildArthurReviewDefinition(reviewShape.shape);
      const text = committedSnapshotText(reviewShape.snapshot.path);
      // Text as well as structure: the file a client receives is this file,
      // byte for byte, so a hand edit to the JSON fails here instead of
      // silently outliving the function that is supposed to own it.
      expect(text).toBe(`${JSON.stringify(built, null, 2)}\n`);
      expect(JSON.parse(text)).toEqual(built);
    });

    it(`deploys with no validation issues (${reviewShape.name})`, () => {
      const committed = JSON.parse(
        committedSnapshotText(reviewShape.snapshot.path),
      ) as WorkflowDefinitionV2;
      expect(
        validateWorkflowDefinitionIssuesForDeployment(
          committed,
          REGISTRY_CONTEXT,
          { checkEnvironmentAvailability: false },
        ),
      ).toEqual([]);
    });

    it(`pins the three client repositories and nothing else (${reviewShape.name})`, () => {
      const built = buildArthurReviewDefinition(reviewShape.shape);
      expect(built.repositoryScope).toEqual({
        repositories: [
          { provider: "gitlab", repoPath: "ArthurAI/arthur-scope" },
          { provider: "gitlab", repoPath: "ArthurAI/unify-frontend" },
          { provider: "github", repoPath: "arthur-ai/arthur-engine" },
        ],
        providers: ["github", "gitlab"],
      });
    });

    it(`pins a Harness Profile whose workspace survives between blocks (${reviewShape.name})`, async () => {
      const built = buildArthurReviewDefinition(reviewShape.shape);
      const reviewers = built.nodes.filter(
        (node) => node.type === "review_agent",
      );
      expect(reviewers.map((node) => node.configuration.harnessProfile)).toEqual(
        reviewers.map(() => ({ profileId: "builtin-claude", version: 2 })),
      );
      // The requirement `harness-profile-runtime.ts` enforces for every
      // review_agent: without a preserved managed workspace the review has no
      // checkout to read, and deployment validation rejects the block.
      expect(resolveBuiltinHarnessProfile(PINNED_PROFILE)?.workspace).toEqual({
        mode: "managed",
        preserveAcrossBlocks: true,
      });
      expect(
        await validateHarnessProfileReferencesWithLoader(
          built,
          async (reference) => builtinResolvedVersion(reference),
        ),
      ).toEqual([]);
    });

    it(`keeps the failure check text inside GitLab's 255 character clamp (${reviewShape.name})`, () => {
      const built = buildArthurReviewDefinition(reviewShape.shape);
      const failure = built.nodes.find((node) => node.id === "complete-failure");
      expect(failure?.configuration.details).toBe(FAILURE_DETAILS);
      // `details` reaches GitLab as a commit-status description, which
      // `GitLabAdapter.updateGateStatus` puts through exactly this clamp. A
      // fixed sentence survives it untouched; a bound review summary would not.
      expect(clampBothEnds(FAILURE_DETAILS, 255)).toBe(FAILURE_DETAILS);
      expect(failure?.inputs).toEqual({
        check: {
          kind: "reference",
          reference: "steps.create-check.output.check",
        },
      });
    });
  }
});

function builtinResolvedVersion(
  reference: HarnessProfileReference,
): HarnessProfileResolvedVersion | null {
  const manifest = resolveBuiltinHarnessProfile(reference);
  if (!manifest) return null;
  const cloned = structuredClone(manifest);
  return {
    manifest: cloned,
    manifestHash: hashHarnessProfileManifest(cloned),
    skillArtifacts: [],
  };
}

for (const reviewShape of REVIEW_SHAPES) {
  describe(`Arthur post-PR review (${reviewShape.name}): an approving review`, () => {
    it("creates the check before it prepares the workspace and passes it", async () => {
      const repository = REPOSITORIES[0];
      const arm = reviewShape.arm(repository);
      const scenario = snapshotScenario(
        reviewShape,
        "trigger_pr_ready",
        "trigger-ready",
        repository,
      );
      scriptPrelude(scenario, repository);
      scenario.script({ nodeId: arm.reviewer }, {
        kind: "next",
        output: reviewOutputFor(arm.reviewer, []),
      });
      scriptPostReview(scenario, arm);
      const completion = scriptCompletion(scenario, "complete-success");

      const outcome = await scenario.execute();

      expect(outcome.result.outcome).toBe("completed");
      expect(outcome.result.executionError).toBeUndefined();
      const createCheck = executorRunsOf(outcome, "create-check");
      expect(createCheck).toHaveLength(1);
      const prepare = executorRunsOf(outcome, "prepare");
      expect(prepare).toHaveLength(1);
      // Causal claim, not a timing one: the workspace is prepared only once the
      // check the run will complete exists, so a run that dies in the sandbox
      // still has a check to report against.
      expectStartsAfterFinishOf(prepare[0], createCheck[0]);
      const review = executorRunsOf(outcome, arm.reviewer);
      expect(review).toHaveLength(1);
      expectStartsAfterFinishOf(review[0], prepare[0]);
      const postReview = executorRunsOf(outcome, arm.postReview);
      expect(postReview).toHaveLength(1);
      // No Loop in this graph, asserted rather than described: one attempt, one
      // activation scope. Every other scenario reads its records the same way.
      expect({
        attempt: postReview[0].attempt,
        activationScopeId: postReview[0].activationScopeId,
      }).toEqual({ attempt: 1, activationScopeId: "root" });
      expect(postReview[0].resolvedInputs).toEqual({
        reviewResults: [expectedReviewResult(arm.reviewer, "approve", [])],
      });
      expect(postReview[0].result).toEqual({
        kind: "next",
        output: {
          status: "ok",
          decision: "approve",
          summary: APPROVED_SUMMARY,
          inlineCommentCount: 0,
          summaryFallbackCount: 0,
        },
      });
      expect(portsOf(outcome, arm.verdict)).toEqual(["true"]);
      expect(
        executorRunsOf(outcome, "complete-success")[0].resolvedInputs,
      ).toEqual({ check: CHECK_REF });
      expect(completion.conclusion).toBe("success");
      expect(completion.details).toBe(SUCCESS_DETAILS);
      expectCheckPassedThrough(outcome, "complete-success");
      expectNeverInvoked(outcome, [
        "complete-failure",
        ...arm.idleReviewers,
      ]);
    });

    it("skips the trigger that did not fire when a PR update starts the run", async () => {
      // A GitHub repository this time: one definition serves both providers,
      // and the second entry point gets its own end-to-end pass.
      const repository = REPOSITORIES[2];
      const arm = reviewShape.arm(repository);
      const scenario = snapshotScenario(
        reviewShape,
        "trigger_pr_updated",
        "trigger-updated",
        repository,
      );
      scriptPrelude(scenario, repository);
      scenario.script({ nodeId: arm.reviewer }, {
        kind: "next",
        output: reviewOutputFor(arm.reviewer, []),
      });
      scriptPostReview(scenario, arm);
      const completion = scriptCompletion(scenario, "complete-success");

      const outcome = await scenario.execute();

      expect(outcome.result.outcome).toBe("completed");
      expect(outcome.result.executionError).toBeUndefined();
      // The distinction this scenario exists for: the trigger that did not fire
      // is present and SKIPPED, not absent. An absent record would mean the
      // scheduler never resolved that entry point, which would leave its
      // outgoing edge unresolved and stall the join at Create review check.
      expect(triggerRecordsOf(outcome, "trigger-ready")).toEqual([
        {
          attempt: 1,
          activationScopeId: "root",
          enteredExecutor: false,
          skipped: true,
        },
      ]);
      expect(triggerRecordsOf(outcome, "trigger-updated")).toEqual([
        {
          attempt: 1,
          activationScopeId: "root",
          enteredExecutor: false,
          skipped: undefined,
        },
      ]);
      const postReview = executorRunsOf(outcome, arm.postReview);
      expect(postReview).toHaveLength(1);
      expect(postReview[0].resolvedInputs).toEqual({
        reviewResults: [expectedReviewResult(arm.reviewer, "approve", [])],
      });
      expect(portsOf(outcome, arm.verdict)).toEqual(["true"]);
      expect(completion.conclusion).toBe("success");
      expectCheckPassedThrough(outcome, "complete-success");
      // "trigger-ready" is deliberately not in this list: a trigger never
      // reaches an executor, so naming it here could never fail. Its real claim
      // is the skipped record asserted above.
      expectNeverInvoked(outcome, [
        "complete-failure",
        ...arm.idleReviewers,
      ]);
    });

    it("approves on Medium and Nit findings and still publishes them", async () => {
      const repository = REPOSITORIES[1];
      const arm = reviewShape.arm(repository);
      const advisory: ReviewResultFinding[] = [
        {
          file: "src/app/page.tsx",
          description: "Extract this branch into a helper.",
          severity: "Medium",
          startLine: 12,
          endLine: 18,
        },
        {
          file: "src/app/page.tsx",
          description: "Rename this variable.",
          severity: "Nit",
          startLine: 40,
        },
      ];
      const output = reviewOutputFor(arm.reviewer, advisory);
      // The severity rule, read off the production builder: nothing below High
      // holds a review back.
      expect(output.decision).toBe("approve");
      const scenario = snapshotScenario(
        reviewShape,
        "trigger_pr_ready",
        "trigger-ready",
        repository,
      );
      scriptPrelude(scenario, repository);
      scenario.script({ nodeId: arm.reviewer }, { kind: "next", output });
      scriptPostReview(scenario, arm);
      const completion = scriptCompletion(scenario, "complete-success");

      const outcome = await scenario.execute();

      expect(outcome.result.outcome).toBe("completed");
      expect(outcome.result.executionError).toBeUndefined();
      const postReview = executorRunsOf(outcome, arm.postReview);
      expect(postReview).toHaveLength(1);
      // Not suppressed: both findings reach the publishing block whole, line
      // spans included, even though neither changed the verdict.
      expect(postReview[0].resolvedInputs).toEqual({
        reviewResults: [
          expectedReviewResult(arm.reviewer, "approve", advisory),
        ],
      });
      expect(postReview[0].result).toEqual({
        kind: "next",
        output: {
          status: "ok",
          decision: "approve",
          summary: APPROVED_SUMMARY,
          inlineCommentCount: 2,
          summaryFallbackCount: 0,
        },
      });
      expect(portsOf(outcome, arm.verdict)).toEqual(["true"]);
      expect(completion.conclusion).toBe("success");
      expectNeverInvoked(outcome, [
        "complete-failure",
        ...arm.idleReviewers,
      ]);
    });
  });

  describe(`Arthur post-PR review (${reviewShape.name}): a blocking finding`, () => {
    it("fails the check and still completes the run", async () => {
      const repository = REPOSITORIES[0];
      const arm = reviewShape.arm(repository);
      const blocker: ReviewResultFinding = {
        file: "src/auth.py",
        description: "The session token is written to the log in clear text.",
        severity: "Blocker",
        startLine: 88,
        endLine: 92,
      };
      const output = reviewOutputFor(arm.reviewer, [blocker]);
      // The severity rule again, from the production builder: one Blocker is
      // enough to hold the review back.
      expect(output.decision).toBe("request_changes");
      const scenario = snapshotScenario(
        reviewShape,
        "trigger_pr_ready",
        "trigger-ready",
        repository,
      );
      scriptPrelude(scenario, repository);
      scenario.script({ nodeId: arm.reviewer }, { kind: "next", output });
      scriptPostReview(scenario, arm);
      const completion = scriptCompletion(scenario, "complete-failure");

      const outcome = await scenario.execute();

      // THE CLAIM THIS WORKFLOW LIVES OR DIES BY. Requesting changes is a
      // review VERDICT, not a technical failure: the check goes red and the run
      // itself still ends green. A failed run here would mark the workflow
      // broken, surface an engine error to the client, and block the next PR
      // event on a run that did exactly what it was asked to do.
      expect(outcome.result.outcome).toBe("completed");
      expect(outcome.result.executionError).toBeUndefined();
      const postReview = executorRunsOf(outcome, arm.postReview);
      expect(postReview).toHaveLength(1);
      expect(postReview[0].resolvedInputs).toEqual({
        reviewResults: [
          expectedReviewResult(arm.reviewer, "request_changes", [blocker]),
        ],
      });
      expect(postReview[0].result).toEqual({
        kind: "next",
        output: {
          status: "ok",
          decision: "request_changes",
          summary: REQUEST_CHANGES_SUMMARY,
          inlineCommentCount: 1,
          summaryFallbackCount: 0,
        },
      });
      expect(portsOf(outcome, arm.verdict)).toEqual(["false"]);
      const failed = executorRunsOf(outcome, "complete-failure");
      expect(failed).toHaveLength(1);
      // Only the check crosses into the completion. Unlike the built-in
      // post-PR template, this definition does not bind the review summary as
      // `details`, so nothing model-authored reaches a GitLab commit status.
      expect(failed[0].resolvedInputs).toEqual({ check: CHECK_REF });
      expect(completion.details).toBe(FAILURE_DETAILS);
      expect(completion.conclusion).toBe("failure");
      expect(failed[0].result).toEqual({
        kind: "next",
        output: { status: "ok", check: CHECK_REF, conclusion: "failure" },
      });
      expectCheckPassedThrough(outcome, "complete-failure");
      expectNeverInvoked(outcome, [
        "complete-success",
        ...arm.idleReviewers,
      ]);
    });

    it("holds the review back on a High finding too", async () => {
      const repository = REPOSITORIES[2];
      const arm = reviewShape.arm(repository);
      const high: ReviewResultFinding = {
        file: "src/queue.py",
        description: "A failed job is retried without any backoff.",
        severity: "High",
        startLine: 31,
      };
      const output = reviewOutputFor(arm.reviewer, [high]);
      // "High" is the other half of the severity gate and the only one of the
      // four severities no other scenario here reaches. Strip
      // `|| finding.severity === "High"` from the production derivation and
      // this assertion is what goes red.
      expect(output.decision).toBe("request_changes");
      const scenario = snapshotScenario(
        reviewShape,
        "trigger_pr_ready",
        "trigger-ready",
        repository,
      );
      scriptPrelude(scenario, repository);
      scenario.script({ nodeId: arm.reviewer }, { kind: "next", output });
      scriptPostReview(scenario, arm);
      const completion = scriptCompletion(scenario, "complete-failure");

      const outcome = await scenario.execute();

      expect(outcome.result.outcome).toBe("completed");
      expect(outcome.result.executionError).toBeUndefined();
      const postReview = executorRunsOf(outcome, arm.postReview);
      expect(postReview).toHaveLength(1);
      expect(postReview[0].result).toEqual({
        kind: "next",
        output: {
          status: "ok",
          decision: "request_changes",
          summary: REQUEST_CHANGES_SUMMARY,
          inlineCommentCount: 1,
          summaryFallbackCount: 0,
        },
      });
      expect(portsOf(outcome, arm.verdict)).toEqual(["false"]);
      const failed = executorRunsOf(outcome, "complete-failure");
      expect(failed).toHaveLength(1);
      expect(failed[0].resolvedInputs).toEqual({ check: CHECK_REF });
      expect(completion.conclusion).toBe("failure");
      expectNeverInvoked(outcome, [
        "complete-success",
        ...arm.idleReviewers,
      ]);
    });
  });

  describe(`Arthur post-PR review (${reviewShape.name}): a review that fails`, () => {
    it("fails the run instead of turning a provider failure into request_changes", async () => {
      // SCOPE: this proves the scheduler never synthesizes a verdict out of a
      // block that failed. It says nothing about WHICH review failures become
      // execution errors rather than a "request_changes" output, which is
      // decided inside the review agent block and belongs to its own tests.
      const repository = REPOSITORIES[0];
      const arm = reviewShape.arm(repository);
      const scenario = snapshotScenario(
        reviewShape,
        "trigger_pr_ready",
        "trigger-ready",
        repository,
      );
      scriptPrelude(scenario, repository);
      scenario.script(
        { nodeId: arm.reviewer },
        executionError("The review provider connection dropped.", {
          category: "provider",
          phase: "agent",
        }),
      );

      const outcome = await scenario.execute();

      expect(outcome.result.outcome).toBe("failed");
      expect(outcome.result.executionError).toEqual({
        nodeId: arm.reviewer,
        attempt: 1,
        category: "provider",
        phase: "agent",
        message:
          "An external service could not complete this block. (The review provider connection dropped.)",
        diagnosticId: `AIW-DIAG-test-run-${arm.reviewer}-1`,
      });
      // A Branch leaves a record whenever it runs, and there is none: no
      // verdict was inferred from a technical failure.
      expect(outcome.invocationsOf(arm.verdict)).toEqual([]);
      expectNeverInvoked(outcome, [
        arm.postReview,
        "complete-success",
        "complete-failure",
      ]);
    });
  });
}

/**
 * The reversal that has not landed yet: one reviewer per repository, selected
 * by the repository path, so guidance selection is deterministic instead of the
 * model picking among four skills. The definition builder produces that shape,
 * and it does not deploy, so it has no snapshot and no scenarios.
 */
describe("Arthur post-PR review: one review agent per repository", () => {
  it("cannot join three branch-selected reviewers into one Post PR review", () => {
    const perRepository = buildArthurReviewDefinition(
      "one_agent_per_repository",
    );
    // Every issue the deployment validator raises, and nothing else. The two
    // routing Branches read `steps.entry.output.repoPath` and are not among
    // them, which is the evidence that the reference resolves under either
    // trigger. What fails is the join: `formulaImplies` in
    // `available-values.ts` only offers a reference whose producer runs on
    // EVERY path into the consumer, and a branch-selected reviewer runs on one
    // of three.
    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        perRepository,
        REGISTRY_CONTEXT,
        { checkEnvironmentAvailability: false },
      ),
    ).toEqual(
      REPOSITORIES.map((repository, index) => ({
        code: "binding.unavailable_reference",
        severity: "error",
        nodeId: "post-review",
        path: `/nodes/9/inputs/reviewResults/references/${index}`,
        message: `Block "post-review" input "reviewResults" references "steps.review-${repository.key}.output", which is not guaranteed when the block runs.`,
      })),
    );
  });
});
