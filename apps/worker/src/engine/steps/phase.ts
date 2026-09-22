/* eslint-disable max-lines, max-lines-per-function */
import type { AgentOutput, AgentProtocolResult, CollectedPhaseArtifacts, PhaseUsage, PhaseKind, PhaseArtifactPaths, ResearchResult, ReviewOutput } from "../../sandbox/agents/types.js";
import type { AgentKind } from "../../sandbox/agents/index.js";
import { isAgentRuntimeError } from "../../sandbox/agents/runtime-error.js";
import type { TicketAttachment } from "../../adapters/issue-tracker/types.js";
import type { DownloadedAttachment } from "../../sandbox/attachments.js";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import { executionError, type StepsRecord } from "@shared/workflow-graph";
import type { BlockExecutionResult } from "@shared/workflow-graph";
import { agentProtocolExecutionError as agentProtocolBlockError, type EngineCtx } from "../blocks/support/types.js";
import { type WorkspaceManifest, type WorkspaceRepositoryInput } from "../../sandbox/repo-workspace.js";
import type { RepositoryExpansionDecision } from "../internal/ports.js";
import { ensureAgentSandbox } from "../blocks/agent-sandbox.js";
import { recoverChecksCeilingFromSteps } from "../blocks/pre-pr-checks.js";
import { addElapsed, checksElapsedOf, createRunBudgetState, observeRunBudget, recordBudgetUsage, type RunBudgetAttribution, type RunBudgetLimits, type RunBudgetObservation } from "../helpers/run-budget.js";
import { isRunControlError } from "../helpers/run-control-error.js";
import type {
  RunRepositoryAccess,
  TriggerRepositoryPolicy,
  VcsProviderKind,
  WorkScope,
  WorkScopeActor,
  WorkflowRepositoryScope,
} from "@shared/contracts";
import type { RunWorkScopeWrite } from "../work-scope/apply-plans.js";
import type { RepositoryCatalogEntry } from "../repository-discovery/catalog.js";
import type { CostProvider, TokenPrice } from "@shared/costs";
import { combineHarnessRuntimeLimits } from "../../sandbox/harness-runtime-limits.js";
import type { ResolvedHarnessRuntime } from "../../sandbox/harness-runtime.js";

/**
 * run_scripts: run named repository script groups in the run workspace.
 *
 * The generic successor to the publication gate, and a thin adapter over the
 * same engine: it differs from run_pre_pr_checks in exactly two ways, and both
 * are deliberate. It names the groups it wants instead of taking the gate's
 * own selection, and it records no workspace gate. Its output carries no
 * `gate` key at all, which is what keeps it out of recoverPrePrGateFromSteps
 * (blocks/finalize-workspace/execute.ts:72): that walk recognizes a gate by the
 * outcome+gate pair on any step output, and this block does carry an outcome.
 *
 * Recording no gate is not the same as being unable to affect publication. A
 * group with restoreTree false leaves tracked files modified on purpose, and
 * running one after the checks gate has passed drifts the fingerprint the
 * publication boundary re-verifies, so Finalize fails with workspace_changed.
 * Mutating groups belong before the gate.
 *
 * Scripts that ran and failed are an ordinary branchable outcome, never an
 * execution error. kind "execution_error" stays reserved for scripts that could
 * not run at all, which is a different thing an operator answers differently.
 */
function checksCeilingOption(steps: StepsRecord): { checksCeilingMs?: number } {
  const ceilingMs = recoverChecksCeilingFromSteps(steps);
  return ceilingMs === null ? {} : { checksCeilingMs: ceilingMs };
}

export async function ensurePlanningAgentSandboxForBlock(
  ctx: EngineCtx,
  kind: AgentKind,
  model: string,
  isolated = false,
  runtime?: ResolvedHarnessRuntime,
): Promise<
  | { kind: "ready"; sandboxId: string }
  | Extract<BlockExecutionResult, { kind: "execution_error" }>
> {
  try {
    const options = isolated
      ? { reuse: false, ...(runtime ? { runtime } : {}) }
      : runtime
        ? { runtime }
        : null;
    const sandboxId = options
      ? await ensureAgentSandbox(ctx, kind, model, options)
      : await ensureAgentSandbox(ctx, kind, model);
    return {
      kind: "ready",
      sandboxId,
    };
  } catch (error) {
    if (isRunControlError(error)) throw error;
    if (isAgentRuntimeError(error)) {
      return agentProtocolBlockError({
        ok: false,
        category: error.category,
        message: error.safeMessage,
        diagnostic: error.diagnostic,
      });
    }
    return executionError(error instanceof Error ? error.message : String(error), {
      category: "sandbox",
      phase: "research",
    });
  }
}

/**
 * What the resume step hands back: the protocol's own verdict, and what the
 * subject's record says this run should now be holding.
 *
 * Two shapes, because a run suspended before the record existed replays the
 * bare verdict this step used to return, and that run must resume exactly as it
 * would have. The same tolerance the workspace gate gives `repositoryVersions`,
 * for the same reason.
 */
export type ResolvedHumanRepositoryExpansion =
  | RepositoryExpansionDecision
  | {
      decision: RepositoryExpansionDecision;
      /** Absent when the run froze no record. `repositories` is what the record
       *  selected and the workspace does not hold yet, decided exactly as a run
       *  start would decide it. */
      workScope?: {
        repositories: SelectedRepository[];
        /** The record as this run's own question left it, for the rounds that
         *  follow. Null is a subject with no record at all. Absent on a result
         *  stored before this field existed: that run moves nothing and goes on
         *  reading the copy it froze at run start, exactly as it did. */
        scope?: WorkScope | null;
        /** Travels with the entries because it is read from the same record in
         *  the same breath and answers the same question: has a person already
         *  chosen for this subject. Leaving it behind would let the run ask the
         *  selection question again after its own answer set it. */
        selectionAnswered?: boolean;
        /** The repositories a question on this subject named and somebody
         *  answered for, re-read with the entries for the same reason: the
         *  answer this run just took is what the rounds after it must not ask
         *  about again. Absent on a result stored before this field existed, and
         *  then `scope` is not installed either: the two are one value, and half
         *  of it is what lets a guess take back what somebody removed. */
        answeredRepositoryKeys?: string[];
      };
    };

/**
 * AIW-147 IM-11: when a human answered the expansion-limit clarification, attach
 * the repositories they named beyond the model round limit and let research
 * continue. Detection keys on the LATEST clarification round matching the
 * expansion-limit prompt; validation and attachment run through injected steps
 * so the whole path stays WDK-replay-safe and every ctx mutation derives from a
 * step output. It never counts a model expansion round (human authority sits
 * above the model round limit). The policy itself lives in the pure
 * decideRepositoryExpansion; this applies its action and the state it returns,
 * so "the human said no further repositories" is recorded on the run context
 * here rather than re-derived by the caller (AIW-377). Returns "noop" when
 * there is nothing left to do, so the caller falls through to running research.
 */
export async function applyHumanRepositoryExpansion(
  ctx: Pick<
    EngineCtx,
    | "clarifications"
    | "runId"
    | "sandboxId"
    | "workspaceManifest"
    | "selectedRepositories"
    | "repositoryContexts"
    | "repositoryExpansion"
    | "workScope"
  >,
  deps: {
    resolve: (
      answer: string,
      attached: Array<{ provider: string; repoPath: string }>,
      /** The questions this round asked, so the parser can tell our own words
       *  back from the person's. */
      askedQuestions: string[],
    ) => Promise<ResolvedHumanRepositoryExpansion>;
    attach: (repositories: SelectedRepository[]) => Promise<{
      manifest: Extract<WorkspaceManifest, { version: 2 }>;
      cloneDurationMs: number;
    }>;
    fetchContexts: (
      repositories: WorkspaceRepositoryInput[],
    ) => Promise<EngineCtx["repositoryContexts"]>;
  },
): Promise<
  | { kind: "noop" }
  | {
      kind: "attached";
      repositories: SelectedRepository[];
      cloneDurationMs: number;
    }
  | { kind: "clarification"; questions: string[] }
  | { kind: "failed"; message: string }
> {
  const rounds = ctx.clarifications ?? [];
  const latest = rounds.at(-1);
  if (!latest || ctx.workspaceManifest?.version !== 2 || !ctx.sandboxId) {
    return { kind: "noop" };
  }
  // ONLY A ROUND THIS RUN ASKED. `ctx.clarifications` is every answered
  // clarification of the TICKET, so the latest round is often one an earlier
  // run asked and an earlier person already answered. Applying that here closes
  // this run's expansion before the model has said a word, and the first
  // repository this run genuinely needs then fails it: the original defect,
  // reached through the clarification history instead of through the ticket
  // text (A42). What earlier runs decided reaches this one through the record;
  // the whole history still reaches the prompt, which is where cross-run memory
  // belongs.
  //
  // A round carrying no run id is not re-applied either. It can only come from
  // a journal written before the field existed, this ships under a production
  // drain, and a question that cannot happen is cheaper than an answer from a
  // run nobody can name.
  if (latest.runId !== ctx.runId) {
    return { kind: "noop" };
  }
  const { decideRepositoryExpansion, isRepositoryExpansionClarification } =
    await import("../repository-discovery/runner.js");
  // Every question the expansion path raises, not only the round-limit one: a
  // question this check does not recognize is one whose answer is dropped, and
  // research restarts as if the person had never replied (AIW-377).
  if (!isRepositoryExpansionClarification(latest.questions)) {
    return { kind: "noop" };
  }
  const resolved = await deps.resolve(
    latest.answer,
    ctx.selectedRepositories.map((repository) => ({
      provider: repository.provider,
      repoPath: repository.repoPath,
    })),
    // OUR OWN QUESTION IS NOT TESTIMONY. Every channel a person answers
    // through quotes the question back at some width (a Jira reply, a mail
    // client), so the question's own example lines would otherwise be parsed
    // as the repositories they named.
    latest.questions,
  );
  // A run suspended before the step returned the record replays the verdict on
  // its own, which is what every run did until now.
  const resumed = "kind" in resolved ? undefined : resolved.workScope;
  const resolvedVerdict = "kind" in resolved ? resolved : resolved.decision;
  // THE RECORD AS IT IS NOW REPLACES THE COPY FROZEN AT RUN START. What the
  // step read is the whole record at answer time, so this installs every entry
  // written since the run began: this run's own question is the reason to look,
  // and a panel edit or another run's decision arrives in the same read. That
  // is deliberate and matches `readRunWorkScope` on the selection path, where
  // a waking run also reads the record rather than a copy of it. The rounds
  // after the answer then decide against what is true, instead of asking the
  // same person about the same repository twice in one run and refusing later
  // the repository they just excluded with nobody's name on it (A43).
  //
  // Only what the RECORD says moves: its entries and whether a person has
  // already chosen. The trigger policy stays as this run resolved it, because
  // a policy that changed mid-run would give one run two different filters
  // (A17, A10).
  //
  // THE ENTRIES AND THE ANSWERED SET INSTALL TOGETHER OR NOT AT ALL. They are
  // one value: a guess is refused only by the two read together, so fresh
  // entries beside an older answered set reads a decision as no decision and the
  // next guess writes a repository the person removed straight back
  // (`RunWorkScopeInput.answeredRepositoryKeys` in `engine/work-scope/
  // context.ts`). A result stored before the answered set existed carries only
  // half, and the whole pair is then left alone: the run goes on reading the
  // copy it froze at start, where the two halves did come from one read, or
  // where the selection step read them again for a freeze written before this
  // field existed (`readRunWorkScope` in
  // `engine/pre-sandbox/steps/repo-selection.ts`, which owns what a missing
  // field on the RUN-START copy means, as this owns what a missing field on a
  // RESUME result means).
  if (
    ctx.workScope &&
    resumed &&
    resumed.scope !== undefined &&
    resumed.answeredRepositoryKeys !== undefined
  ) {
    ctx.workScope = {
      ...ctx.workScope,
      scope: resumed.scope,
      answeredRepositoryKeys: resumed.answeredRepositoryKeys,
      ...(resumed.selectionAnswered === undefined
        ? {}
        : { selectionAnswered: resumed.selectionAnswered }),
    };
  }
  // THE RECORD OUTRANKS THE ANSWER TEXT. The answer was read and recorded when
  // it arrived, by the one reader that knows what the question asked about, so
  // a reply this in-run parser cannot read ("yes please" to a question about
  // one repository) is still a decision. Re-reading the sentence here would
  // ask the same person the same thing again, which is the loop the record
  // exists to end.
  //
  // ON A RUN THAT CARRIES A RECORD, THAT READER IS THE ONLY ONE (A45). When the
  // record hands back nothing, an ATTACH from the text parser is refused rather
  // than used: every ambiguity the record's reader resolves to unrecognised on
  // purpose arrives here with nothing, and letting the older, weaker parser
  // attach is the dumber reader succeeding where the careful one refused. The
  // answer counts as unreadable instead, so the person is asked again, bounded
  // by the two unreadable answers that already close expansion. Asking once
  // more is the cheaper mistake than attaching a repository nobody chose.
  //
  // Only an attach is refused. `exhausted` still means the person refused, and
  // a refusal to a selection question legitimately writes no entry, so an empty
  // record there is the answer rather than a silence. A run that froze NO
  // record keeps the old path whole, because there no better reader exists.
  //
  // AND WHERE THE ANSWER CARRIES ITS OWN READING, THAT READING IS THE TEXT
  // PARSER'S REPLACEMENT, not its rival. The reading was made once, by a model,
  // where the answer arrived, against the question as the person saw it, and it
  // is stored beside the words; this run consumes it instead of parsing the
  // sentence a second time with a different set of rules. That second parse is
  // what made the record and the run disagree about the same reply, and it is
  // the thing this removes.
  //
  // No model call happens here, and none may: this runs in workflow scope,
  // where a replay must reach the same conclusion the first execution did. The
  // reading is carried on the round, so a replay reads it out of the journal.
  //
  // Only on a run that carries a record, which is the same line drawn above: a
  // run that froze no record has no way to turn the keys a person chose into
  // repositories it may attach, so it keeps the old path whole.
  const stored = resumed ? latest.reading : undefined;
  const readVerdict: RepositoryExpansionDecision = stored
    ? stored.outcome.kind === "declined_all" ||
      stored.outcome.kind === "declined_one" ||
      // The person asked us to decide, and we did: what the workflow took is
      // written in the record and attaches through the branch below, and what
      // it did not take is a choice to continue without it. Either way this run
      // asks for nothing further, because asking again is putting the question
      // back to somebody who just handed it to us.
      stored.outcome.kind === "delegated"
      ? // The person refused. What they refused is written in the record; here
        // it means only that this run asks for nothing further.
        { kind: "exhausted" }
      : // Everything else defers to the record below. A reading that named
        // repositories is turned into attachable ones by the record and nothing
        // else, and an unclear reading never reaches a run at all: the channel
        // that took it parks the question instead of resuming.
        { kind: "unrecognised_answer", questions: latest.questions }
    : resolvedVerdict;
  let verdict: RepositoryExpansionDecision = readVerdict;
  if (resumed && resumed.repositories.length > 0) {
    verdict = { kind: "attach", repositories: resumed.repositories };
  } else if (resumed && readVerdict.kind === "attach") {
    // The same question again, so the next answer is still read as repositories
    // to attach: a question without the expansion marker is one whose answer is
    // thrown away (AIW-377).
    verdict = { kind: "unrecognised_answer", questions: latest.questions };
  }
  const { action, state } = decideRepositoryExpansion({
    origin: "human",
    verdict,
    state: ctx.repositoryExpansion,
    clarificationRounds: rounds.length,
  });
  ctx.repositoryExpansion = state;
  if (action.kind === "ask_limit" || action.kind === "ask_unrecognised") {
    return { kind: "clarification", questions: action.questions };
  }
  if (action.kind === "fail") {
    return { kind: "failed", message: action.message };
  }
  if (action.kind !== "attach") {
    // Nothing new to clone, so run research with what is attached instead of
    // re-raising the clarification. Whether that means the human refused is
    // already recorded in the state above.
    return { kind: "noop" };
  }
  const attached = await deps.attach(action.repositories);
  const repositories = [...ctx.selectedRepositories, ...action.repositories];
  ctx.workspaceManifest = attached.manifest;
  ctx.selectedRepositories = repositories;
  ctx.repositoryContexts = await deps.fetchContexts(repositories);
  return {
    kind: "attached",
    repositories: action.repositories,
    cloneDurationMs: attached.cloneDurationMs,
  };
}

// --- Step Functions ---

async function fetchAttachments(
  ticketIdentifier: string,
  attachments: TicketAttachment[],
  /** The attachment bounds this run started with, so a second fetch later in
   *  the same run is bounded exactly as the first was. */
  limits: {
    maxFileSizeBytes: number;
    maxTotalSizeBytes: number;
    maxCount: number;
    downloadTimeoutMs: number;
  },
) {
  "use step";
  const { loadAdaptersPort } = await import("../internal/ports.js");
  const { logger } = await import("../../infra/logger.js");
  const log = logger.child({ ticket_identifier: ticketIdentifier, step: "fetchAttachments" });
  log.info({ count: attachments.length }, "fetchAttachments: start");

  if (attachments.length === 0) {
    log.info({}, "fetchAttachments: no attachments");
    return [];
  }

  const { createAdapters } = await loadAdaptersPort();
  const { fetchAttachmentsWithRetry } = await import("../../sandbox/attachments.js");
  const { issueTracker } = await createAdapters();

  // downloadAttachment is optional on IssueTrackerAdapter — not all trackers
  // support it. If absent, skip attachments cleanly.
  if (typeof issueTracker.downloadAttachment !== "function") {
    log.warn(
      { tracker: issueTracker.constructor.name },
      "issue tracker does not support attachment downloads; skipping",
    );
    return [];
  }

  const downloader = issueTracker as {
    downloadAttachment: (url: string, opts?: { timeoutMs?: number }) => Promise<Buffer>;
  };

  const result = await fetchAttachmentsWithRetry(
    downloader,
    attachments,
    limits,
    log,
  );
  log.info(
    {
      succeeded: result.filter((a) => !a.failed).length,
      failed: result.filter((a) => a.failed).length,
    },
    "fetchAttachments: done",
  );
  return result;
}
fetchAttachments.maxRetries = 0;

async function writeAttachments(
  sandboxId: string,
  attachments: DownloadedAttachment[],
): Promise<void> {
  "use step";
  const { logger } = await import("../../infra/logger.js");
  const log = logger.child({ sandboxId, step: "writeAttachments" });

  const toWrite = attachments.filter((a) => a.content && !a.failed);
  log.info(
    { count: toWrite.length, totalReceived: attachments.length },
    "writeAttachments: start",
  );
  if (toWrite.length === 0) {
    log.info({}, "writeAttachments: nothing to write");
    return;
  }

  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  // Ensure target directory exists — writeFiles does not guarantee mkdir -p semantics.
  await sandbox.runCommand("mkdir", ["-p", "/tmp/attachments"]);

  await sandbox.writeFiles(
    toWrite.map((a) => ({
      path: `/tmp/attachments/${a.filename}`,
      content: Buffer.isBuffer(a.content)
        ? (a.content as Buffer)
        : Buffer.from(a.content as unknown as Uint8Array),
    })),
  );
  log.info({ count: toWrite.length }, "writeAttachments: done");
}
writeAttachments.maxRetries = 0;

async function writeAndStartPhase(
  sandboxId: string,
  agentKind: AgentKind,
  phase: PhaseKind,
  inputFilePath: string,
  inputContent: string,
  scriptPath: string,
  scriptContent: string,
  runtime?: ResolvedHarnessRuntime,
  /** What the expansion before this pass refused, when it attached nothing.
   *  The next zero-retry step on that path is this one, and a refusal has to
   *  ride a step that cannot retry: it changes no entry, so losing the line to
   *  a dead invocation costs nothing, while a second copy of it reads as an
   *  agent that asked twice. Absent on every run that froze no record. */
  workScopeWrite?: RunWorkScopeWrite,
): Promise<
  | { ok: true; commandId: string }
  | { ok: false; failure: Extract<AgentProtocolResult<unknown>, { ok: false }> }
> {
  "use step";
  if (workScopeWrite) {
    const { applyRunWorkScopePlans } = await import("../work-scope/apply-plans.js");
    await applyRunWorkScopePlans(workScopeWrite);
  }
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const { commandProtocolFailure, protocolFailure } = await import(
    "../../sandbox/agents/protocol.js"
  );
  const spec = createAgentAdapter(agentKind, runtime?.cliSpec).cliSpec;
  try {
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
    const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

    await sandbox.writeFiles([
      { path: inputFilePath, content: Buffer.from(inputContent) },
      { path: scriptPath, content: Buffer.from(scriptContent) },
    ]);
    const chmod = await sandbox.runCommand("chmod", ["+x", scriptPath]);
    if (chmod.exitCode !== 0) {
      return {
        ok: false,
        failure: await commandProtocolFailure({
          spec,
          phase,
          result: chmod,
          failureKind: "setup_failed",
          message: "The current agent phase could not be completed.",
          detail: "The agent phase wrapper could not be made executable.",
        }),
      };
    }

    const command = await sandbox.runCommand({
      cmd: "bash",
      args: [scriptPath],
      cwd: "/vercel/sandbox",
      detached: true,
    });
    if (command.exitCode !== null && command.exitCode !== 0) {
      return {
        ok: false,
        failure: await commandProtocolFailure({
          spec,
          phase,
          result: command,
          failureKind: "cli_exit",
          message: "The current agent phase could not be completed.",
          detail: "The agent phase process could not be launched.",
        }),
      };
    }
    return { ok: true, commandId: command.cmdId };
  } catch (error) {
    const { isRunControlError: isRunControlInterruption } = await import(
      "../helpers/run-control-error.js",
    );
    if (isRunControlInterruption(error)) throw error;
    const failure = protocolFailure({
      spec,
      phase,
      artifacts: { stdout: "", stderr: "", structuredOutput: null, exitCode: null },
      failureKind: "provider_error",
      category: "provider",
      message: "The current agent phase could not be completed.",
      detail: "The agent phase process could not be launched.",
    });
    if (failure.ok) throw new Error("unreachable", { cause: error });
    return { ok: false, failure };
  }
}
writeAndStartPhase.maxRetries = 0;

async function fetchModelPriceStep(model: string): Promise<{ input: number; cached_input: number; output: number } | null> {
  "use step";
  const { fetchModelPrice } = await import("../../sandbox/agents/pricing.js");
  try {
    return await fetchModelPrice(model);
  } catch (err) {
    const { logger } = await import("../../infra/logger.js");
    logger.warn({ err: (err as Error).message, model }, "pricing_fetch_failed");
    return null;
  }
}
fetchModelPriceStep.maxRetries = 0;

async function readRunBudgetClockStep(): Promise<number> {
  "use step";
  return Date.now();
}
readRunBudgetClockStep.maxRetries = 0;

async function setCommitGuardStep(
  sandboxId: string,
  agentKind: AgentKind,
  enabled: boolean,
  runtime?: ResolvedHarnessRuntime,
): Promise<AgentProtocolResult<void>> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const agent = createAgentAdapter(agentKind, runtime?.cliSpec);
  try {
    await agent.setCommitGuard(sandbox, enabled, runtime?.paths);
    return { ok: true, value: undefined };
  } catch (error) {
    if (!isAgentRuntimeError(error)) throw error;
    return {
      ok: false,
      category: error.category,
      message: error.safeMessage,
      diagnostic: error.diagnostic,
    };
  }
}

// Step wrappers around the AgentAdapter class methods. The adapter classes
// transitively reach the pino logger (through the tracing installer); the workflow
// bundler can't tolerate that, so all adapter method calls happen inside
// step bundles rather than the workflow body.
async function planPhaseStep(
  agentKind: AgentKind,
  phase: PhaseKind,
  model: string,
  jsonSchema?: string,
  runtime?: ResolvedHarnessRuntime,
): Promise<{ paths: PhaseArtifactPaths; script: string }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind, runtime?.cliSpec);
  const paths = a.artifactPaths(phase);
  const script = a.buildPhaseScript({
    phase,
    model,
    paths,
    jsonSchema,
    ...(runtime
      ? {
          runtime: runtime.paths,
          ...(runtime.modelSettings
            ? { modelSettings: runtime.modelSettings }
            : {}),
        }
      : {}),
  });
  return { paths, script };
}

async function parseResearchStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: PhaseKind = "research",
  runtime?: ResolvedHarnessRuntime,
): Promise<{ result: AgentProtocolResult<ResearchResult>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind, runtime?.cliSpec);
  return {
    result: a.parseResearchProtocol(artifacts, phase),
    usage: a.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

async function parseRepositoryDiscoveryStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: PhaseKind,
  schema: string,
): Promise<{ result: AgentProtocolResult<unknown>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const adapter = createAgentAdapter(agentKind);
  return {
    result: adapter.parseStructuredObjectProtocol(
      artifacts,
      phase,
      "repository-discovery",
      schema,
    ),
    usage: adapter.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

/**
 * Fresh server-owned catalog for model expansion, filtered through the run's
 * immutable composed repository policy before any model can request an attach.
 */
async function listFreshRepositoryCatalogStep(
  access: RunRepositoryAccess,
  repositoryScope?: WorkflowRepositoryScope,
) {
  "use step";
  const { buildRepositoryCatalog } = await import(
    "../repository-discovery/catalog.js"
  );
  const { filterRunRepositories } = await import(
    "../support/repository-access.js"
  );
  return buildRepositoryCatalog(
    filterRunRepositories(access, await listPinnedRepositories(repositoryScope?.providers)),
  );
}
listFreshRepositoryCatalogStep.maxRetries = 0;

/**
 * The catalog both expansion steps read, narrowed to the providers a workflow
 * pinned. No pin leaves every connected provider in, which is what keeps a
 * workflow without one on exactly its pre-pin behaviour.
 *
 * TERMINAL ON A PROVIDER THAT DID NOT ANSWER, which is what the directory these
 * two steps used to read did (`createRepositoryDirectoryForProviders`, deleted
 * in S11). Neither caller carries a partial catalog anywhere: both hand it
 * straight to a validator that answers "not on the accessible repository
 * catalog", so a GitHub 401 beside a healthy GitLab would tell a person their
 * repository does not exist when we simply could not see it, and the run would
 * carry on with half a workspace. The provider's own error is raised rather
 * than a wrapper, so the failure names what failed.
 */
async function listPinnedRepositories(
  pinnedProviders: VcsProviderKind[] | undefined,
) {
  const { listVcsRepositories } = await import("../support/vcs-runtime.js");
  const listing = await listVcsRepositories(
    pinnedProviders && pinnedProviders.length > 0
      ? { neededProviders: pinnedProviders }
      : {},
  );
  const failure = listing.failures[0];
  if (failure) throw failure.error;
  return listing.repositories;
}

async function attachResearchRepositoriesStep(
  sandboxId: string,
  manifest: Extract<WorkspaceManifest, { version: 2 }>,
  repositories: SelectedRepository[],
  owner: { subjectKey: string; ownerToken: string; runId: string },
  access: RunRepositoryAccess,
  /** The run's job timeout, from the settings it started with. */
  jobTimeoutMs: number,
  integrationPins?: readonly import("@shared/contracts").IntegrationConnectionPin[],
  /** What the decision that produced this attach wrote down about the subject's
   *  work scope. It rides this step because the step cannot retry, and because
   *  an attach is exactly the outcome that changes an entry. Absent on a run
   *  that froze no record. */
  workScopeWrite?: RunWorkScopeWrite,
): Promise<{
  manifest: Extract<WorkspaceManifest, { version: 2 }>;
  cloneDurationMs: number;
}> {
  "use step";
  const { loadAdaptersPort, loadVcsRuntimePort } = await import(
    "../internal/ports.js"
  );
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { buildSandboxProviderConfigs } = await loadVcsRuntimePort();
  const {
    attachResearchRepositories,
    materializeResearchRepositories,
  } = await import(
    "../../sandbox/research-workspace.js"
  );
  // AIW-147 minor: re-check access at the single materialization choke point
  // every attach path shares, so a repository that never belonged to this run
  // cannot be attached however it reached this list. The list itself is the one
  // the run started with: the catalog changing mid-run stops the NEXT run, not
  // this one, so this check cannot disagree with the earlier catalog check the
  // way the environment-backed allowlist could.
  const { mayRunTouchRepository, repositoryNotEnabledMessage } = await import(
    "../support/repository-access.js"
  );
  for (const repository of repositories) {
    if (!mayRunTouchRepository(access, repository)) {
      throw new Error(repositoryNotEnabledMessage("attach", repository));
    }
  }
  const target = await Sandbox.get({
    sandboxId,
    ...getSandboxCredentials(),
  });
  const startedAt = Date.now();
  const materializer = await Sandbox.create({
    ...getSandboxCredentials(),
    runtime: "node24",
    timeout: jobTimeoutMs,
  });
  const { createAdapters } = await loadAdaptersPort();
  const { stopSandboxAndConfirm } = await import(
    "../../sandbox/stop-ticket-sandboxes.js"
  );
  try {
    await (await createAdapters()).runRegistry.registerSandbox(
      owner.subjectKey,
      owner.ownerToken,
      materializer.sandboxId,
      owner.runId,
    );
    const artifacts = await materializeResearchRepositories({
      sandbox: materializer,
      repositories,
      providers: await buildSandboxProviderConfigs(
        repositories.map((repository) => repository.provider),
        integrationPins,
      ),
    });
    const attached = await attachResearchRepositories({
      sandbox: target,
      manifest,
      artifacts,
    });
    // After the clone, so a run that could not attach the repository does not
    // record that it did.
    if (workScopeWrite) {
      const { applyRunWorkScopePlans } = await import("../work-scope/apply-plans.js");
      await applyRunWorkScopePlans(workScopeWrite);
    }
    return {
      manifest: attached,
      cloneDurationMs: Math.max(0, Date.now() - startedAt),
    };
  } finally {
    await stopSandboxAndConfirm(materializer);
  }
}
attachResearchRepositoriesStep.maxRetries = 0;

// AIW-147 IM-11: validate a human clarification answer against a FRESH
// server-owned catalog and the allowlist, inside a step so the Node-only
// directory/env/allowlist imports stay out of the workflow bundle and the
// decision is journaled for replay. The parsing/validation itself is pure and
// lives in repository-discovery/runner.ts.
// It is also where a resumed run reads its subject's record. The read, the
// `resumed` decision and the write all happen here because this step cannot
// retry: a retried trail line is a second identical line in a history whose
// vocabulary has no reason for a repeat.
async function resolveHumanRepositoryExpansionStep(
  answer: string,
  attached: Array<{ provider: string; repoPath: string }>,
  /** The questions this round put, so a quoted question is not read back as the
   *  person's own words. */
  askedQuestions: string[],
  access: RunRepositoryAccess,
  repositoryScope?: WorkflowRepositoryScope,
  /** Absent on a run that froze no record, which is the whole old path. */
  workScope?: RunWorkScopeResume,
): Promise<ResolvedHumanRepositoryExpansion> {
  "use step";
  const { loadRepositoryDiscoveryPort } = await import("../internal/ports.js");
  const { buildRepositoryCatalog } = await import(
    "../repository-discovery/catalog.js"
  );
  const { filterRunRepositories } = await import(
    "../support/repository-access.js"
  );
  const { validateHumanRepositoryExpansion } =
    await loadRepositoryDiscoveryPort();
  const catalog = buildRepositoryCatalog(
    filterRunRepositories(access, await listPinnedRepositories(repositoryScope?.providers)),
  );
  const decision = validateHumanRepositoryExpansion({
    answer,
    catalog,
    attached,
    askedQuestions,
  });
  if (!workScope) return decision;
  return {
    decision,
    workScope: await resumeFromWorkScope(workScope, { catalog, access, attached }, repositoryScope),
  };
}
resolveHumanRepositoryExpansionStep.maxRetries = 0;

/** What a resumed run needs to read its own record: whose record, under which
 *  policy, and in whose name the decision is written. */
interface RunWorkScopeResume {
  subjectKey: string;
  runId: string;
  policy: TriggerRepositoryPolicy;
  actor: WorkScopeActor;
}

/**
 * The record as the answer left it, turned into what this run should attach.
 *
 * It reads the subject's scope, its `selectionAnswered` flag and the
 * repositories a question already settled, never the answer text and never a
 * copy of it in the resume payload: the answer was decided when it arrived, so
 * the entries ARE what the person said, and a re-read also sees a panel edit
 * made between the answer and the wake. The `resumed` event decides those keys
 * exactly as a run start would, so nothing the policy, the pin or the workspace
 * cap refuses can arrive through a person's answer by a different door.
 *
 * The record it read travels back beside the repositories: entries,
 * `selectionAnswered` and the settled repositories together, because the caller
 * has no other way to see what this run's own question settled. It is what the
 * rounds after the answer decide against (A43), and the settled set is what
 * keeps the round after this one from putting the same repository to the same
 * person twice in one run (A47).
 */
async function resumeFromWorkScope(
  resume: RunWorkScopeResume,
  run: {
    catalog: RepositoryCatalogEntry[];
    access: RunRepositoryAccess;
    attached: Array<{ provider: string; repoPath: string }>;
  },
  repositoryScope?: WorkflowRepositoryScope,
): Promise<{
  repositories: SelectedRepository[];
  scope: WorkScope | null;
  selectionAnswered: boolean;
  answeredRepositoryKeys: string[];
}> {
  const { catalog, attached } = run;
  const { createRunWorkScopeRecorder, workScopeRepositoryKey } = await import(
    "../work-scope/context.js"
  );
  const { readConnectedWorkScopeFacts } = await import("../../db/repositories/work-scope.js");
  // The whole picture, of which this path uses three facts. One read in
  // parallel rather than three named ones, so a fact added to the picture
  // reaches every reader of it at once (`db/repositories/work-scope.ts`,
  // `readWorkScopeFacts`). No clarification id: this resume is the expansion
  // path, which decides from the entries and never from one question's verdict.
  const { scope, selectionAnswered, answeredRepositoryKeys } =
    await readConnectedWorkScopeFacts(resume.subjectKey);
  const byKey = new Map(
    catalog.map((entry) => [workScopeRepositoryKey(entry), entry] as const),
  );
  const record = createRunWorkScopeRecorder({
    subjectKey: resume.subjectKey,
    scope,
    selectionAnswered,
    answeredRepositoryKeys,
    // The one event this recorder raises is `resumed`, which walks the record's
    // own entries and derives no ticket text at all, so there is nothing here
    // for a path in a comment to decide, and no ticket is read: the way back
    // this path offers names the record alone (`commentPathIsTaken`).
    ticketText: null,
    catalog: {
      // The run's own answer, not this listing's: on a bridge nobody activated
      // the catalog, so every repository reads as enabled and an entry recorded
      // `not_enabled` may not expire here, or the person would be asked a
      // second time about a repository nothing has enabled.
      activated: run.access.activated,
      enabledKeys: [...byKey.keys()],
      unusableKeys: catalog.filter((entry) => !entry.usable).map(workScopeRepositoryKey),
    },
    ...(repositoryScope ? { repositoryScope } : {}),
    policy: resume.policy,
    actor: resume.actor,
    // Read here, in the step, so the decision itself never touches a clock and
    // a replay replays this step's stored result rather than reading the time
    // again.
    now: new Date().toISOString(),
    attachedKeys: attached.map(workScopeRepositoryKey),
  });
  const selected = (scope?.entries ?? [])
    .filter((entry) => entry.state === "selected")
    .map((entry) => entry.repositoryKey);
  const decision = record.decide({
    kind: "resumed",
    repositoryKeys: record.boundEventKeys(selected),
  });
  const { applyRunWorkScopePlans } = await import("../work-scope/apply-plans.js");
  await applyRunWorkScopePlans({
    subjectKey: resume.subjectKey,
    runId: resume.runId,
    plans: record.plans,
  });
  const repositories: SelectedRepository[] = [];
  for (const key of decision.attach) {
    const entry = byKey.get(key);
    // Guarded rather than asserted: the decision reads the catalog built just
    // above, and inventing a default branch for a repository nobody listed is
    // how a clone fails inside a sandbox instead of here.
    if (!entry) continue;
    repositories.push({
      provider: entry.provider,
      repoPath: entry.repoPath,
      defaultBranch: entry.defaultBranch,
      selectedRationale: "recorded on this work",
    });
  }
  return { repositories, scope, selectionAnswered, answeredRepositoryKeys };
}

async function parseAgentOutputStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: PhaseKind = "impl",
  runtime?: ResolvedHarnessRuntime,
): Promise<{ result: AgentProtocolResult<AgentOutput>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind, runtime?.cliSpec);
  return {
    result: a.parseAgentOutputProtocol(artifacts, phase),
    usage: a.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

async function parseReviewStep(
  agentKind: AgentKind,
  artifacts: CollectedPhaseArtifacts,
  phase: PhaseKind = "review",
  runtime?: ResolvedHarnessRuntime,
): Promise<{ result: AgentProtocolResult<ReviewOutput>; usage: PhaseUsage | null }> {
  "use step";
  const { createAgentAdapter } = await import("../../sandbox/agents/index.js");
  const a = createAgentAdapter(agentKind, runtime?.cliSpec);
  return {
    result: a.parseReviewOutputProtocol(artifacts, phase),
    usage: a.extractUsage(artifacts.stdout, artifacts.structuredOutput),
  };
}

export interface HarnessInvocationBudget {
  limits: RunBudgetLimits;
  observeBudget(
    requireRemainingDuration?: boolean,
    attribution?: RunBudgetAttribution,
    observedAtMs?: number,
  ): Promise<RunBudgetObservation>;
  recordUsage(usage: PhaseUsage | null, model: string): void;
}

/**
 * Profile limits are invocation-local. The workflow observer still runs on
 * every boundary, while the local state contains only this invocation's usage
 * and active time.
 */
export async function createHarnessInvocationBudget(input: {
  workflowLimits: RunBudgetLimits;
  runtime: ResolvedHarnessRuntime;
  observeWorkflowBudget(
    requireRemainingDuration?: boolean,
    attribution?: RunBudgetAttribution,
    observedAtMs?: number,
  ): Promise<RunBudgetObservation>;
  readClock(): Promise<number>;
  priceLookup?(
    model: string,
  ): TokenPrice | null;
  phase: string;
}): Promise<HarnessInvocationBudget> {
  // readClock is a workflow step. Invoking it as a property of `input`
  // captures `input` as the call receiver, and the Workflow SDK then tries to
  // serialize that receiver, which carries the non-serializable budget
  // observer function. Destructure first so every call is a free-function
  // call with serializable arguments only.
  const { observeWorkflowBudget, readClock, priceLookup, phase } = input;
  const limits = combineHarnessRuntimeLimits(
    input.workflowLimits,
    input.runtime,
  );
  let state = createRunBudgetState();
  let lastClockMs = await readClock();
  return {
    limits,
    async observeBudget(
      requireRemainingDuration = true,
      attribution: RunBudgetAttribution = "duration",
      observedAtMs?: number,
    ) {
      const workflow = observedAtMs === undefined
        ? await observeWorkflowBudget(requireRemainingDuration, attribution)
        : await observeWorkflowBudget(requireRemainingDuration, attribution, observedAtMs);
      const now = observedAtMs ?? await readClock();
      state = addElapsed(state, now - lastClockMs, attribution);
      lastClockMs = Math.max(lastClockMs, now);
      const profile = observeRunBudget(
        state,
        limits,
        requireRemainingDuration,
      );
      return {
        ...mergeBudgetObservations(workflow, profile),
        observedAtMs: lastClockMs,
      };
    },
    recordUsage(usage, model) {
      const provider: CostProvider = {
        price: priceLookup?.(model) ?? null,
      };
      state = recordBudgetUsage(state, usage, provider, phase);
    },
  };
}

export function mergeBudgetObservations(
  workflow: RunBudgetObservation,
  profile: RunBudgetObservation,
): RunBudgetObservation {
  const remainingDurationMs = Math.min(
    workflow.remainingDurationMs,
    profile.remainingDurationMs,
  );
  // The larger of the two, not the tighter one. A profile context is created
  // when its block starts, so it has not seen the checks other blocks already
  // spent; taking its smaller total would hand every profile block a fresh
  // checks ceiling and let one run spend the ceiling several times over.
  const checksElapsedMs = Math.max(
    checksElapsedOf(workflow),
    checksElapsedOf(profile),
  );
  const observedAtValues = [workflow.observedAtMs, profile.observedAtMs].filter(
    (value): value is number => value !== undefined,
  );
  const observedAt = observedAtValues.length > 0
    ? { observedAtMs: Math.max(...observedAtValues) }
    : {};
  if (workflow.check.status !== "ok") {
    return { ...workflow, remainingDurationMs, checksElapsedMs, ...observedAt };
  }
  if (profile.check.status !== "ok") {
    return { ...profile, remainingDurationMs, checksElapsedMs, ...observedAt };
  }
  const tighter =
    profile.remainingDurationMs < workflow.remainingDurationMs
      ? profile
      : workflow;
  return {
    ...tighter,
    check: { status: "ok" },
    remainingDurationMs,
    checksElapsedMs,
    ...observedAt,
  };
}
export { attachResearchRepositoriesStep, checksCeilingOption, fetchAttachments, fetchModelPriceStep, listFreshRepositoryCatalogStep, parseAgentOutputStep, parseRepositoryDiscoveryStep, parseResearchStep, parseReviewStep, planPhaseStep, readRunBudgetClockStep, resolveHumanRepositoryExpansionStep, setCommitGuardStep, writeAndStartPhase, writeAttachments };
