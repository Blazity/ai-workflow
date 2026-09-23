/**
 * The read half of agent visibility: what one send gave a model, served a page
 * at a time.
 *
 * ONE READ MODEL, TWO SURFACES. The route and the MCP tool are both thin over
 * the functions here, so the dashboard cannot show a byte the terminal cannot.
 * Everything comes from the stored briefing: the catalog, the prompt library
 * and the harness profiles are never re-read, because the page has to show what
 * the agent got and not what is true now.
 *
 * WHO MAY READ ONE. Exactly the replay's audience, resolved from the run's
 * `replay_organization_id`, which is the only tenant the runs table carries. A
 * briefing holds ticket bodies, AGENTS.md files, memory and repository
 * descriptions, so a run whose audience cannot be worked out is refused out
 * loud rather than opened or hidden behind a 404 that would read as "there is
 * nothing here". Briefings carrying their own tenant column is the durable fix
 * and is not this stage's.
 *
 * WHAT COUNTS AS A BLOCK ATTEMPT. Two stores name them and neither is complete.
 * Attempt rows live and die with the replay observations, so an attempt whose
 * replay was swept has none; briefings outlive the replay, so a run that never
 * reached a send has none of those. A list is the union, and each attempt is
 * described from whichever of the two still names it.
 */
import {
  agentBriefingIndexSchema,
  agentBriefingOverviewSchema,
  agentBriefingRepositoryContextSchema,
  agentBriefingSectionHeader,
  byteRangeInPage,
  explainMissingBriefing,
  pageSectionText,
  readVisibilityRecord,
  shortenVisibilityId,
  type AgentBriefingIndex,
  type AgentBriefingOverview,
  type AgentBriefingPart,
  type AgentBriefingRedactionSpan,
  type AgentBriefingRepository,
  type AgentBriefingSection,
  type AgentBriefingSectionHeader,
  type AgentBriefingSectionPage,
  type AgentBriefingUnresolvedSource,
  type MissingBriefingFacts,
  type MissingBriefingReason,
} from "@shared/agent-visibility";
import {
  listAgentBriefingOverviewRows,
  listBlockAttemptFactRows,
  listConnectedAgentBriefingOverviewRows,
  listConnectedBlockAttemptFactRows,
  readAgentBriefingIndexRow,
  readAgentBriefingRunSummary,
  readAgentBriefingText,
  readConnectedAgentBriefingIndexRow,
  readConnectedAgentBriefingRunSummary,
  readConnectedAgentBriefingText,
  readConnectedRunVisibilityFacts,
  readRunVisibilityFacts,
  type AgentBriefingFilter,
  type AgentBriefingOverviewRow,
  type AgentBriefingRow,
  type AgentBriefingRunSummary,
  type BlockAttemptFactRow,
  type RunVisibilityFacts,
} from "../../db/repositories/agent-visibility.js";
import type { Db } from "../../db/types.js";
import {
  cannotConfirmAudience,
  dropUndefined,
  keyedListPage,
  notFound,
  pageLimit,
  paging,
  storageFault,
  storedListPage,
  unreadableOf,
  type AgentVisibilityPage,
  type AgentVisibilityUnreadable,
} from "./pages.js";
import { knownSecretValues } from "../integrations/index.js";
import { serveSafeText } from "./serve-safe.js";

/**
 * The blocks that put a prompt in front of a model, decided from the block type
 * the run really executed.
 *
 * Every other block is answered `sendsPrompts: false` with no reason at all: a
 * script, a transition or a ticket comment has no briefing to be missing, and
 * telling a person it was "not recorded" would send them looking for a bug in
 * capture. `prepare_workspace` is here for the discovery send it makes; the
 * planning block makes one too on the lazy path, which its own briefings show.
 */
export const PROMPT_SENDING_BLOCK_TYPES: ReadonlyMap<string, "discovery" | "agent" | "llm"> = new Map([
  ["planning_agent", "agent"],
  ["implementation_agent", "agent"],
  ["review_agent", "agent"],
  ["fix_agent", "agent"],
  ["generic_agent", "agent"],
  ["prepare_workspace", "discovery"],
  ["call_llm", "llm"],
  ["investigate", "llm"],
  // It composes and sends a prompt of its own (engine/blocks/leak-review),
  // which is why it is here beside the agent blocks rather than with the
  // script and transition blocks.
  ["leak_review", "agent"],
]);

/**
 * Of the blocks above, the ones that ask a model only WHEN THEY NEED TO.
 *
 * THE STANDARD FOR MEMBERSHIP, and every entry below was read against it: the
 * block has a path that COMPLETES (`kind: "next"`, so the attempt row ends
 * `completed`) before any briefing is planned. A failure or a pause does not
 * count, because those already have their own answers, and neither does a path
 * that reached `recordSendBriefing` or `recordSkippedSend`, because a row then
 * exists. Such an attempt leaves the same silence a lost write leaves, and the
 * two are told apart by the run's own loss counter rather than by this list.
 *
 * `prepare_workspace`: its discovery send happens only where selection came
 * back with nothing. A ticket that names its repository is resolved by
 * `engine/pre-sandbox/steps/repo-selection.ts`, and the discovery prompt is
 * composed only inside `selected.length === 0 && preSandbox.repositoryDiscovery`
 * (`engine/blocks/prepare-workspace/execute.ts:1238`).
 *
 * `leak_review`: three completions before its scan prompt exists, all of them
 * `engine/blocks/leak-review/execute.ts` and all before the `deferredBriefing`
 * at :751 is even constructed. :648 nothing writable has a baseline; :688
 * nothing changed; :715 `llmScan` is switched off for the block. Its fourth
 * quiet ending, :741 after a provider error, is NOT one of these: the step
 * records the send before it calls the model (:525), so a row is there.
 *
 * `fix_agent`: `engine/blocks/fix-agent/execute.ts:694`, an honest no-op on a
 * pull-request run whose review ledger left no open thread (guard at :675).
 * `planBlockAgentBriefing` is not reached until :820.
 *
 * `investigate`: `engine/blocks/investigate/execute.ts:531`, a ticket with
 * neither a summary nor a description, answered `insufficient_data` without
 * asking anything. Its two `planLlmBriefing` calls are at :575 and :632.
 *
 * The blocks deliberately NOT here, each checked the same way and each with
 * its briefing planned on the way to every success it has: `planning_agent`
 * (`engine/agent-workflow.ts:3047`), `implementation_agent` (:3645),
 * `review_agent` (:3916), `generic_agent`
 * (`engine/blocks/generic-agent/execute.ts:528`) and `call_llm`
 * (`engine/blocks/call-llm/execute.ts:156`). Every earlier exit of those five
 * is a failure or a pause, which already have answers of their own.
 *
 * NOTHING GOES IN HERE WITHOUT THAT EVIDENCE. A block listed by mistake tells
 * a person nothing was missing while a send of theirs really was lost, which
 * is the one failure this whole feature exists to prevent; a block left out
 * keeps today's louder answer, which is merely noisy.
 */
const CONDITIONALLY_SENDING_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "prepare_workspace",
  "leak_review",
  "fix_agent",
  "investigate",
]);

/** Run statuses that mean the run is over. A run still queued or still working
 *  has not failed to record anything yet. */
const ENDED_RUN_STATUSES: ReadonlySet<string> = new Set(["success", "failed", "blocked"]);

/**
 * What the run as a whole can still show, beside the attempts on this page.
 *
 * `missing` answers "why has THIS attempt no briefing" and cannot answer "why
 * has this run nothing at all": once retention sweeps the briefings and the
 * replay takes the attempt rows with it, there is no attempt left to carry a
 * reason, and every per-attempt answer would be the wrong one.
 *
 * - `available`: the list is what this run has.
 * - `expired`: this run captured briefings and retention removed them.
 * - `replay_gone`: the attempt rows went with the replay, so attempts that
 *   never sent cannot be listed at all; what is listed is what briefings name.
 * - `predates_capture`: nothing capture-capable ever recorded anything for this
 *   run. That is what a run from before capture looks like, AND what a run
 *   looks like whose every record write was lost, and this state does not tell
 *   them apart.
 */
export type RunBriefingState = "available" | "expired" | "replay_gone" | "predates_capture";

/** A briefing of an attempt, as a list of attempts shows it. */
interface BriefingListEntry {
  /**
   * THE STORE'S ROW SERIAL, AND A PROMISE THAT IT IS A NUMBER. Every surface
   * takes it back as one: the routes parse it with `parseBriefingId`, the MCP
   * schema declares an integer, and it ends up in a dashboard URL, so a reader
   * that stringifies it must be able to turn it back without losing anything.
   * It is not a display value and carries no meaning beyond identity: newer
   * briefings have larger ids WITHIN one deployment's table and nothing else
   * may be read into the number.
   */
  briefingId: number;
  overview: AgentBriefingOverview;
}

/** One Block Attempt: what it sent, and why anything expected is not here. */
export interface BlockAttemptBriefings {
  nodeId: string;
  attempt: number;
  activationScopeId: string;
  /** When the run started this attempt, or null once its row went with the
   *  replay. A list ordered by node id answers no question a person has. */
  startedAt: string | null;
  /** Which iteration of which loop this attempt ran in, as the run's own scope
   *  id spells it, or null outside a loop and where the spelling is not one
   *  this build knows. Fifty iterations differing only by an opaque id are
   *  unreadable without it. */
  iteration: { loopNodeId: string; index: number } | null;
  /**
   * False for a block that puts no prompt in front of a model, and NULL where
   * this deployment can no longer tell.
   *
   * The third state is not a nicety: a `false` that means "unknown" tells a
   * person a planning block had no prompt to be missing. It is reached when the
   * run's captured graph no longer says what this node was AND the attempt left
   * neither a briefing nor a marker row to say what kind of send it made.
   * `missing` is null whenever this is not true: there is either nothing to be
   * missing, or nothing we may claim about it.
   */
  sendsPrompts: boolean | null;
  /** In send order. */
  briefings: BriefingListEntry[];
  /** What capture itself said about a send it did not keep, as it recorded it,
   *  or null. Without it "not recorded, capture skipped" is a verdict with no
   *  reason behind it. */
  captureDetail: string | null;
  /** Computed even beside existing briefings, so a planning attempt that
   *  captured discovery and whose pass never went out says which. */
  missing: MissingBriefingReason | null;
}

/**
 * Which sends a read is about. `attempt` and `activationScopeId` narrow a loop
 * body to one iteration.
 *
 * NAMED AS THE GRAPH NAMES THEM, in full. Capture shortens an id past 200
 * characters before it stores one, and the replay's attempt rows keep the raw
 * one, so a filter is carried to each table in the spelling that table uses
 * rather than made the caller's problem.
 */
export interface BriefingFilters {
  nodeId?: string;
  attempt?: number;
  activationScopeId?: string;
}

/** The stores this read model reads, so a test can hand it rows instead of a
 *  database and the connected build can hand it the pool. */
export interface BriefingReads {
  overviews(filter: AgentBriefingFilter): Promise<AgentBriefingOverviewRow[]>;
  attempts(filter: AgentBriefingFilter): Promise<BlockAttemptFactRow[]>;
  run(runId: string): Promise<RunVisibilityFacts | null>;
  runSummary(runId: string): Promise<AgentBriefingRunSummary | null>;
  briefing(input: { runId: string; briefingId: number }): Promise<AgentBriefingRow | null>;
  text(sha256: string): Promise<string | null>;
  /** Every secret the deployment knows, which everything served is redacted
   *  with. Throws when the integration settings cannot be read, and the read
   *  serves nothing rather than text redacted with part of the set. */
  knownSecrets(): Promise<string[]>;
}

export function briefingReadsOf(db: Db): BriefingReads {
  return {
    overviews: (filter) => listAgentBriefingOverviewRows(db, filter),
    attempts: (filter) => listBlockAttemptFactRows(db, filter),
    run: (runId) => readRunVisibilityFacts(db, runId),
    runSummary: (runId) => readAgentBriefingRunSummary(db, runId),
    briefing: (input) => readAgentBriefingIndexRow(db, input),
    text: (sha256) => readAgentBriefingText(db, sha256),
    knownSecrets: () => knownSecretValues({ db }),
  };
}

export const connectedBriefingReads: BriefingReads = {
  overviews: listConnectedAgentBriefingOverviewRows,
  attempts: listConnectedBlockAttemptFactRows,
  run: readConnectedRunVisibilityFacts,
  runSummary: readConnectedAgentBriefingRunSummary,
  briefing: readConnectedAgentBriefingIndexRow,
  text: readConnectedAgentBriefingText,
  knownSecrets: () => knownSecretValues(),
};

/** Everything a read of this run needs before it reads anything of it. */
async function runOf(
  reads: BriefingReads,
  input: { runId: string; organizationId: string },
): Promise<RunVisibilityFacts> {
  const run = await reads.run(input.runId);
  // A run of another organization and a run that never existed answer the same
  // way on purpose: the second must not be told apart from the first.
  if (!run || (run.replayOrganizationId !== null && run.replayOrganizationId !== input.organizationId)) {
    throw notFound(`There is no run ${input.runId} you may read.`);
  }
  if (run.replayOrganizationId === null) {
    throw cannotConfirmAudience(
      `Run ${input.runId} recorded no organization for its trace, so this deployment cannot confirm who may read what its agents were sent. Nothing of it is served. A run whose replay capture succeeded records one.`,
    );
  }
  return run;
}

/**
 * The failure to quote beside "never sent": the attempt's own, or the run's
 * where the attempt recorded none.
 *
 * A cancelled or a skipped attempt gets none, because neither is a failure and
 * the package's reason says so by leaving it null. The message is normalized
 * on the way out: it is a run's recorded reason, which never met the capture
 * detector and would otherwise read differently over MCP than on a screen.
 */
function failureOf(
  attempt: BlockAttemptFactRow | undefined,
  run: RunVisibilityFacts,
  safe: (text: string) => string,
): MissingBriefingFacts["failure"] {
  if (attempt?.outcomeKind === "failed") {
    const category = attempt.outcomeStatus ?? "failed";
    return { category, message: safe(run.statusReason ?? category) };
  }
  if (attempt?.outcomeKind === "cancelled" || attempt?.outcomeKind === "skipped") return null;
  if (run.status === "failed" && run.statusReason !== null) {
    return { category: run.status, message: safe(run.statusReason) };
  }
  return null;
}

/** `root/loop:<node>:<index>`, as the scheduler spells an iteration scope. A
 *  spelling this build does not know reads as no iteration rather than a
 *  guessed one. */
const ITERATION_SCOPE = /\/loop:(.+):(\d+)$/u;

function iterationOf(activationScopeId: string): { loopNodeId: string; index: number } | null {
  const match = ITERATION_SCOPE.exec(activationScopeId);
  return match ? { loopNodeId: match[1]!, index: Number(match[2]) } : null;
}

interface AttemptRows {
  nodeId: string;
  attempt: number;
  activationScopeId: string;
  /** Undefined once the replay that held it was swept. */
  facts: BlockAttemptFactRow | undefined;
  rows: AgentBriefingOverviewRow[];
  /** When the run reached this attempt, or when its first send happened. */
  at: number;
}

/**
 * The identity of a Block Attempt as one string.
 *
 * BASE64URL, BECAUSE THIS STRING IS ALSO A CURSOR. MCP rewrites every string it
 * serves, and the separators that would read well here are the ones it deletes:
 * a NUL-joined key reached an agent with the NULs gone, and feeding it back
 * answered "the cursor names an entry this list no longer has", so a run whose
 * attempts did not fit one page could not be paged over MCP at all. Base64url
 * has no character the sanitizer touches, and encoding the three fields as JSON
 * means a node id cannot forge the key of another attempt.
 */
function attemptKey(of: { nodeId: string; attempt: number; activationScopeId: string }): string {
  return Buffer.from(
    JSON.stringify([of.nodeId, of.attempt, of.activationScopeId]),
    "utf8",
  ).toString("base64url");
}

/**
 * What the two tables agree on.
 *
 * A briefing row carries the SHORTENED id and its attempt row the raw one, so
 * an attempt whose scope id is past the bound would otherwise group as two
 * entries: one with the row and no briefing ("never sent"), one with the
 * briefing and no row. Grouping happens in capture's spelling; what is SERVED
 * is whichever spelling reached here first, and attempt rows are read first
 * precisely so a person is given the id their graph shows.
 */
function joinKey(of: { nodeId: string; attempt: number; activationScopeId: string }): string {
  return attemptKey({
    nodeId: shortenVisibilityId(of.nodeId),
    attempt: of.attempt,
    activationScopeId: shortenVisibilityId(of.activationScopeId),
  });
}

function groupAttempts(
  overviews: readonly AgentBriefingOverviewRow[],
  attempts: readonly BlockAttemptFactRow[],
): AttemptRows[] {
  const grouped = new Map<string, AttemptRows>();
  const reach = (of: { nodeId: string; attempt: number; activationScopeId: string }): AttemptRows => {
    const key = joinKey(of);
    const existing = grouped.get(key);
    if (existing) return existing;
    const created: AttemptRows = {
      nodeId: of.nodeId,
      attempt: of.attempt,
      activationScopeId: of.activationScopeId,
      facts: undefined,
      rows: [],
      at: Number.POSITIVE_INFINITY,
    };
    grouped.set(key, created);
    return created;
  };
  for (const row of attempts) {
    const entry = reach(row);
    entry.facts = row;
    entry.at = Math.min(entry.at, row.startedAt.getTime());
  }
  for (const row of overviews) {
    const entry = reach(row);
    entry.rows.push(row);
    entry.at = Math.min(entry.at, row.capturedAt.getTime());
  }
  for (const entry of grouped.values()) {
    entry.rows.sort((left, right) => left.sequence - right.sequence);
  }
  // Execution order, which is the order a person reads a run in. The three
  // identity fields break a tie, so the order is total and a cursor over it is
  // stable; a new attempt always starts later and joins the end.
  return [...grouped.values()].sort(
    (left, right) =>
      left.at - right.at ||
      left.nodeId.localeCompare(right.nodeId) ||
      left.attempt - right.attempt ||
      left.activationScopeId.localeCompare(right.activationScopeId),
  );
}

/**
 * The block type this attempt ran, from the run's OWN captured graph.
 *
 * Never from today's definition: a block whose type changed since has to read
 * back as what it was. And never from the briefing's own `blockType` either,
 * although one is stored there: not every send comes from a graph node. The
 * repo-memory distill records under `run:repo-memory-distill` with a type no
 * definition has, and asking the block catalog whether THAT type sends prompts
 * answers "no" about a send whose briefing is sitting right there. What a send
 * left behind is the better witness, and `describeAttempt` uses it.
 */
function graphBlockTypeOf(entry: AttemptRows, run: RunVisibilityFacts): string | null {
  return run.nodeTypes.get(entry.nodeId) ?? null;
}

interface AttemptDescription {
  item: BlockAttemptBriefings;
  unreadable: AgentVisibilityUnreadable[];
}

function describeAttempt(
  entry: AttemptRows,
  position: number,
  run: RunVisibilityFacts,
  runSummary: AgentBriefingRunSummary | null,
  now: Date,
  safe: (text: string) => string,
): AttemptDescription {
  const unreadable: AgentVisibilityUnreadable[] = [];
  const briefings: BriefingListEntry[] = [];
  const capturedKinds: string[] = [];
  const recordedKinds: string[] = [];
  let captureDisabled = false;
  let marker = false;
  let detail: string | null = null;
  entry.rows.forEach((row) => {
    recordedKinds.push(row.kind);
    if (row.capture !== "captured") {
      // A marker row is written where the send happened and the record was
      // not, so its existence is what proves the prompt went out.
      marker = true;
      if (row.capture === "capture_disabled") captureDisabled = true;
      // What capture itself said about the refusal, already sanitized when it
      // was stored. Without it "capture skipped" is a verdict with no reason.
      if (row.detail !== null) detail = row.detail;
      return;
    }
    const read = readVisibilityRecord(agentBriefingOverviewSchema, row.overview);
    if (!read.ok) {
      unreadable.push(unreadableOf("briefings", position, String(row.id), read));
      return;
    }
    capturedKinds.push(row.kind);
    briefings.push({ briefingId: row.id, overview: read.value });
  });

  // The graph knows the block type until the replay is swept. After that a row
  // of this attempt still knows what KIND of send it made, which is the same
  // question `sendsPrompts` is really asking: a marker row left by a planning
  // block would otherwise read as a block with no prompt to be missing.
  const blockType = graphBlockTypeOf(entry, run);
  // Nothing left to decide it with: neither the graph nor a row of this attempt
  // says what it was. `false` here would be a claim, so it is `null`.
  const unknowable = blockType === null && recordedKinds.length === 0;
  const expectedKind =
    blockType === null ? recordedKinds.at(-1) : PROMPT_SENDING_BLOCK_TYPES.get(blockType);
  const sendsPrompts = unknowable ? null : expectedKind !== undefined;
  // DECIDED AGAINST THE ATTEMPT'S LAST SEND, NOT THE SET OF KINDS. A planning
  // attempt that captured its first pass and died before the second has the
  // kind in hand and is still missing the briefing the person opened the tab
  // for. An attempt whose row went with the replay is taken as finished: we
  // cannot tell it from an interrupted one, and the briefing we DO hold beats
  // a reason we would be guessing.
  const attemptFinished = entry.facts === undefined || entry.facts.state === "completed";
  const sentItsOwn =
    expectedKind !== undefined && capturedKinds.includes(expectedKind) && attemptFinished;

  const facts: MissingBriefingFacts = {
    attemptState: entry.facts?.state ?? null,
    runStatus: run.status,
    failure: failureOf(entry.facts, run, safe),
    promptSent: marker ? true : "unknown",
    captureCapable: runSummary !== null,
    captureDisabled,
    capturedKinds,
    replayExpired: run.replayExpiresAt !== null && run.replayExpiresAt.getTime() <= now.getTime(),
    // A block type this deployment cannot name is taken as sending every
    // time, so the quieter answer is never given about a block we cannot
    // identify.
    sendsEveryAttempt: blockType === null || !CONDITIONALLY_SENDING_BLOCK_TYPES.has(blockType),
    // Counted by capture as each send happened, and the reason the line above
    // is allowed to be quiet at all: a run that lost nothing is not hiding a
    // send behind an attempt that recorded none.
    runLostASend: runSummary !== null && runSummary.failedCount > 0,
  };

  return {
    item: {
      nodeId: entry.nodeId,
      attempt: entry.attempt,
      activationScopeId: entry.activationScopeId,
      startedAt: entry.facts?.startedAt.toISOString() ?? null,
      iteration: iterationOf(entry.activationScopeId),
      sendsPrompts,
      briefings,
      captureDetail: detail,
      missing:
        sendsPrompts !== true || sentItsOwn ? null : sweptOrMissing(facts, entry, run, runSummary),
    },
    unreadable,
  };
}

/**
 * The reason, with retention given its say.
 *
 * A briefing expires per SEND (the later of the run's replay expiry and thirty
 * days from that send) and the sweep runs under a limit, so a run whose sends
 * are days apart is half swept for weeks by design. The package can only answer
 * `expired` for an attempt whose own captured kinds it can still see, so an
 * attempt whose row is already gone falls through to `capture_skipped`, which
 * the package documents as the write having been refused or lost. That is an
 * incident report about a run that is fine, so where the run counted more
 * captures than it still holds, retention is the answer for an attempt holding
 * none.
 *
 * IT OVERRULES "THERE WAS NOTHING TO ASK" FOR THE SAME REASON, and this is the
 * more dangerous of the two. A block that asks a model only when it needs to
 * leaves the same empty attempt whether it never asked or whether the briefing
 * it did capture has since been swept, and "nothing is missing" told about a
 * briefing retention removed is a false all-clear rather than merely a noisy
 * one. Only the attempt's own rows can tell those apart, and they are exactly
 * what the sweep took.
 */
function sweptOrMissing(
  facts: MissingBriefingFacts,
  entry: AttemptRows,
  run: RunVisibilityFacts,
  runSummary: AgentBriefingRunSummary | null,
): MissingBriefingReason {
  const reason = explainMissingBriefing(facts);
  const partlySwept = runSummary !== null && run.capturedBriefings < runSummary.capturedCount;
  const holdsNone = entry.rows.every((row) => row.capture !== "captured");
  const couldBeSwept =
    (reason.kind === "not_recorded" && reason.cause === "capture_skipped") ||
    (reason.kind === "never_sent" && reason.cause === "not_needed");
  if (couldBeSwept && partlySwept && holdsNone) {
    return { schemaVersion: reason.schemaVersion, kind: "expired" };
  }
  return reason;
}

/**
 * What this run can still show, from run-level facts only.
 *
 * Never from the page: a filter that matches nothing says nothing about the
 * run, and "predates capture" told about a run that simply has no attempts on
 * this node would be a lie with no way back.
 */
function runBriefingState(
  run: RunVisibilityFacts,
  summary: AgentBriefingRunSummary | null,
): RunBriefingState {
  if (summary !== null && summary.capturedCount > 0 && run.capturedBriefings === 0) return "expired";
  if (summary === null && run.recordedSends === 0 && !run.hasAttemptRows) {
    // ONLY ONCE THE RUN IS OVER. A run still queued, or working on its first
    // block, has recorded nothing YET; saying it predates capture would tell a
    // person to stop waiting for a briefing that is on its way.
    return run.status !== null && ENDED_RUN_STATUSES.has(run.status)
      ? "predates_capture"
      : "available";
  }
  if (!run.hasAttemptRows) return "replay_gone";
  return "available";
}

export interface ReadBriefingAttemptsInput extends BriefingFilters {
  runId: string;
  organizationId: string;
  cursor?: string | null;
  limit?: number;
  bounds?: PageBounds;
  now?: Date;
}

/**
 * What this run's capture did, counted as it happened, whatever became of the
 * briefings afterwards.
 *
 * WHY IT IS ON EVERY PAGE. `buildAgentBriefing` refuses quietly when a section's
 * parts do not reproduce its text, and a refusal is invisible until somebody
 * opens the one briefing that is missing. Counted here beside the state, a
 * person or an alert reads "eleven sends, two refused" without opening
 * anything. Null where no capture-capable code ever recorded for this run,
 * which is the same fact `predates_capture` carries.
 */
export interface RunCaptureCounts {
  /** Sends whose briefing was stored. */
  captured: number;
  /** Sends made while capture was switched off. */
  disabled: number;
  /** Sends whose record was refused: a credential that survived the detector,
   *  or a prompt this build could not take apart and put back together. */
  skipped: number;
  /** Sends whose write was lost. */
  failed: number;
  /** Sends that met a different briefing already stored under their identity. */
  conflict: number;
  /**
   * Every send capture was told about: the five above, added up here rather
   * than by each reader, so two screens cannot disagree about what a send is.
   * A counter added to this record later has to be added to this sum too.
   */
  sends: number;
  firstRecordedAt: string;
  lastRecordedAt: string;
}

export type BriefingAttemptsPage = AgentVisibilityPage<BlockAttemptBriefings> & {
  state: RunBriefingState;
  capture: RunCaptureCounts | null;
};

function captureCounts(summary: AgentBriefingRunSummary | null): RunCaptureCounts | null {
  if (summary === null) return null;
  return {
    captured: summary.capturedCount,
    disabled: summary.disabledCount,
    skipped: summary.skippedCount,
    failed: summary.failedCount,
    conflict: summary.conflictCount,
    sends:
      summary.capturedCount +
      summary.disabledCount +
      summary.skippedCount +
      summary.failedCount +
      summary.conflictCount,
    firstRecordedAt: summary.firstRecordedAt.toISOString(),
    lastRecordedAt: summary.lastRecordedAt.toISOString(),
  };
}

/**
 * Every Block Attempt of a run that either sent something or could have, one
 * page at a time.
 *
 * Both reads are narrow (a briefing's index WITHOUT its sections, an attempt
 * row's state and outcome), and grouping them is what decides how many attempts
 * there are, so `total` is counted from rows already in hand rather than read a
 * second time.
 */
export async function readBriefingAttempts(
  reads: BriefingReads,
  input: ReadBriefingAttemptsInput,
): Promise<BriefingAttemptsPage> {
  const { described, limit, extra } = await describeRunAttempts(reads, input);
  // An unreadable briefing belongs to one attempt, so a page reports the ones
  // whose attempt it is showing and counts the rest: a schema version this
  // build does not know makes every briefing of a run unreadable at once, and a
  // page carrying all of them carried nothing else.
  const byAttempt = new Map(
    described.map((entry) => [attemptKey(entry.item), entry.unreadable] as const),
  );
  const page = keyedListPage(
    described.map((entry) => entry.item),
    {
      keyOf: attemptKey,
      cursor: input.cursor ?? null,
      limit,
      unreadable: described.flatMap((entry) => entry.unreadable),
      unreadableFor: (served) => served.flatMap((item) => byAttempt.get(attemptKey(item)) ?? []),
      extra,
    },
  );
  return dropUndefined(page as BriefingAttemptsPage);
}

/** The newest Block Attempt of a run, and what the run itself can still say. */
export interface NewestBriefingAttempt {
  /** Null where the filter matched no attempt at all. */
  attempt: BlockAttemptBriefings | null;
  state: RunBriefingState;
  capture: RunCaptureCounts | null;
}

/**
 * The NEWEST attempt of the filtered set, whatever fits.
 *
 * NOT the last item of the first page. Attempts are served oldest first, so a
 * block with more attempts than one page holds would hand back the last one
 * that FITTED and call it the last one sent, which is an older prompt under the
 * word "newest": an operator would edit against text the block no longer
 * produces. The one attempt served still goes through the pager, so a single
 * enormous attempt is shortened rather than blowing the caller's cap.
 */
export async function readNewestBriefingAttempt(
  reads: BriefingReads,
  input: ReadBriefingAttemptsInput,
): Promise<NewestBriefingAttempt> {
  const { described, limit, extra } = await describeRunAttempts(reads, input);
  const newest = described.at(-1);
  if (newest === undefined) return { attempt: null, ...extra };
  const page = keyedListPage([newest.item], {
    keyOf: attemptKey,
    limit,
    total: described.length,
    unreadable: newest.unreadable,
  });
  return { attempt: dropUndefined(page.items[0] ?? null), ...extra };
}

interface DescribedAttempts {
  /** Every Block Attempt the filter matched, oldest first. */
  described: AttemptDescription[];
  limit: number;
  /** What the run itself says, which no attempt can: carried on every page. */
  extra: { state: RunBriefingState; capture: RunCaptureCounts | null };
}

async function describeRunAttempts(
  reads: BriefingReads,
  input: ReadBriefingAttemptsInput,
): Promise<DescribedAttempts> {
  const limit = pageLimit(input.limit, input.bounds);
  const run = await runOf(reads, input);
  // ONE FILTER PER SPELLING. The caller names the node the graph names, and the
  // graph is also what the replay's attempt rows were written from; capture
  // shortened the same id before storing its briefings. Sending the caller's
  // words to both tables finds nothing in one of them for every id past the
  // bound, and an empty list reads as "this block never sent anything".
  const filter = (of: (id: string) => string): AgentBriefingFilter => ({
    runId: input.runId,
    ...(input.nodeId === undefined ? {} : { nodeId: of(input.nodeId) }),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.activationScopeId === undefined
      ? {}
      : { activationScopeId: of(input.activationScopeId) }),
  });
  const [overviews, attempts, runSummary] = await Promise.all([
    reads.overviews(filter(shortenVisibilityId)),
    reads.attempts(filter((id) => id)),
    reads.runSummary(input.runId),
  ]);
  const now = input.now ?? new Date();
  const safe = serveSafeText(await reads.knownSecrets());
  const described = groupAttempts(overviews, attempts).map((entry, position) =>
    describeAttempt(entry, position, run, runSummary, now, safe),
  );
  return {
    described,
    limit,
    extra: { state: runBriefingState(run, runSummary), capture: captureCounts(runSummary) },
  };
}

/** One briefing's stored index, read and parsed, with the row it came from. */
interface LoadedBriefing {
  row: AgentBriefingRow;
  index: AgentBriefingIndex;
}

async function loadBriefing(
  reads: BriefingReads,
  input: { runId: string; briefingId: number; organizationId: string },
): Promise<LoadedBriefing> {
  const run = await runOf(reads, input);
  const row = await reads.briefing(input);
  if (!row) {
    // A briefing swept between two reads is not a caller who typed the wrong
    // number, and saying "a briefing id belongs to one run" to somebody
    // following a link from a page they had open blames them for retention.
    const summary = await reads.runSummary(input.runId);
    const state = runBriefingState(run, summary);
    throw notFound(
      state === "expired" || state === "replay_gone"
        ? `Briefing ${input.briefingId} of run ${input.runId} is no longer stored: this run's briefings have passed retention. The run's briefing list says so too.`
        : `Run ${input.runId} has no briefing ${input.briefingId}. List its briefings first; a briefing id belongs to one run.`,
    );
  }
  if (row.capture !== "captured" || row.index === null) {
    throw notFound(
      `Briefing ${input.briefingId} of run ${input.runId} records a send that was not kept (${row.capture}), so it has no sections. The run's briefing list says why.`,
    );
  }
  const read = readVisibilityRecord(agentBriefingIndexSchema, row.index);
  if (!read.ok) {
    throw storageFault(
      `The stored briefing ${input.briefingId} of run ${input.runId} could not be read: ${read.message}`,
    );
  }
  return { row, index: read.value };
}

function sectionOf(loaded: LoadedBriefing, index: number): AgentBriefingSection {
  const section = loaded.index.sections[index];
  if (!section) {
    throw notFound(
      `Briefing ${loaded.row.id} has ${loaded.index.sections.length} sections, numbered from 0; section ${index} is not one of them.`,
    );
  }
  return section;
}

/** Bounds a surface puts on one page, tighter than the package's where the
 *  transport needs it to be. */
export interface PageBounds {
  default: number;
  maximum: number;
}

export interface BriefingChildInput {
  runId: string;
  organizationId: string;
  briefingId: number;
  cursor?: string | null;
  limit?: number;
  bounds?: PageBounds;
}

/** The section headers of one briefing: everything about a section but its
 *  text, its parts and its spans, each of which is a list of its own. */
export async function readBriefingSections(
  reads: BriefingReads,
  input: BriefingChildInput,
): Promise<AgentVisibilityPage<AgentBriefingSectionHeader>> {
  const limit = pageLimit(input.limit, input.bounds);
  const loaded = await loadBriefing(reads, input);
  return dropUndefined(
    storedListPage(loaded.index.sections.map(agentBriefingSectionHeader), {
      cursor: input.cursor ?? null,
      limit,
    }),
  );
}

export interface BriefingSectionInput {
  runId: string;
  organizationId: string;
  briefingId: number;
  sectionIndex: number;
  offset?: number;
  limit?: number;
  bounds?: PageBounds;
}

/**
 * One page of one section's stored text.
 *
 * The bytes are the stored bytes: capture already made them a fixed point of
 * MCP's serve-time sanitizer, whole and in any page cut out of them, so this
 * page reaches a terminal exactly as it reaches a screen.
 */
export async function readBriefingSectionPage(
  reads: BriefingReads,
  input: BriefingSectionInput,
): Promise<AgentBriefingSectionPage> {
  const limit = pageLimit(input.limit, input.bounds);
  const loaded = await loadBriefing(reads, input);
  const section = sectionOf(loaded, input.sectionIndex);
  const text = await reads.text(section.storedSha256);
  if (text === null) {
    throw storageFault(
      `The stored text of section ${input.sectionIndex} of briefing ${input.briefingId} (sha256 ${section.storedSha256}) is not in the store, so this page cannot be served. The send WAS recorded and its size and digest are in the section header: this is a storage fault, not an agent that was given nothing.`,
    );
  }
  return paging(() =>
    pageSectionText({
      sectionIndex: input.sectionIndex,
      text,
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      maxBytes: limit,
    }),
  );
}

export interface BriefingSectionChildInput extends BriefingChildInput {
  sectionIndex: number;
}

/** The named pieces of one section, in order. Together they are its whole
 *  stored text. */
export async function readBriefingSectionParts(
  reads: BriefingReads,
  input: BriefingSectionChildInput,
): Promise<AgentVisibilityPage<AgentBriefingPart>> {
  const limit = pageLimit(input.limit, input.bounds);
  const loaded = await loadBriefing(reads, input);
  return dropUndefined(
    storedListPage(sectionOf(loaded, input.sectionIndex).parts, { cursor: input.cursor ?? null, limit }),
  );
}

/** Where text was removed from one section's stored copy. */
export async function readBriefingSectionSpans(
  reads: BriefingReads,
  input: BriefingSectionChildInput,
): Promise<AgentVisibilityPage<AgentBriefingRedactionSpan>> {
  const limit = pageLimit(input.limit, input.bounds);
  const loaded = await loadBriefing(reads, input);
  return dropUndefined(
    storedListPage(sectionOf(loaded, input.sectionIndex).redactions, {
      cursor: input.cursor ?? null,
      limit,
    }),
  );
}

/** The sources the compiler could not resolve, which is why an expected
 *  AGENTS.md or profile may be missing from the sections. */
export async function readBriefingUnresolvedSources(
  reads: BriefingReads,
  input: BriefingChildInput,
): Promise<AgentVisibilityPage<AgentBriefingUnresolvedSource>> {
  const limit = pageLimit(input.limit, input.bounds);
  const loaded = await loadBriefing(reads, input);
  return dropUndefined(
    storedListPage(loaded.index.unresolvedSources, { cursor: input.cursor ?? null, limit }),
  );
}

export interface BriefingRepositoryContext {
  schemaVersion: number;
  /** Catalog repositories the map summarized as a count instead of listing. */
  unlistedCount: number;
  workScope: { version: number; leftOutKeys: string[] } | null;
  repositories: AgentVisibilityPage<AgentBriefingRepository>;
}

/**
 * The repositories one send described, as the send described them.
 *
 * The document is stored beside the section texts under its own digest, so six
 * planning passes that saw the same map read one document. Nothing here is
 * re-read from the catalog: a repository renamed or disabled since still reads
 * as what the agent was shown.
 */
export async function readBriefingRepositoryContext(
  reads: BriefingReads,
  input: BriefingChildInput,
): Promise<BriefingRepositoryContext> {
  const limit = pageLimit(input.limit, input.bounds);
  const loaded = await loadBriefing(reads, input);
  const reference = loaded.index.repositoryContext;
  if (reference === null) {
    throw notFound(
      `Briefing ${input.briefingId} of run ${input.runId} rendered no repository context, so there is none to read.`,
    );
  }
  const stored = await reads.text(reference.sha256);
  if (stored === null) {
    throw storageFault(
      `The repository context of briefing ${input.briefingId} (sha256 ${reference.sha256}) is not in the store, so it cannot be served. The send WAS recorded and the briefing's overview counts what the document held: this is a storage fault, not an agent that was shown no repositories.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    throw storageFault(
      `The repository context of briefing ${input.briefingId} (sha256 ${reference.sha256}) is not the JSON document it was stored as: ${(error as Error).message}`,
    );
  }
  const read = readVisibilityRecord(agentBriefingRepositoryContextSchema, parsed);
  if (!read.ok) {
    throw storageFault(
      `The repository context of briefing ${input.briefingId} could not be read: ${read.message}`,
    );
  }
  return dropUndefined({
    schemaVersion: read.value.schemaVersion,
    unlistedCount: read.value.unlistedCount,
    workScope: read.value.workScope,
    repositories: storedListPage(read.value.repositories, { cursor: input.cursor ?? null, limit }),
  });
}

// Re-exported for a reader that pages a section and then marks its parts and
// spans on the page it got: the package decides where a byte range falls, and
// nobody else should be computing it a second time.
export { byteRangeInPage };
