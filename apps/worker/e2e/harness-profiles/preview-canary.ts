import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isHarnessGitHubSkillSource,
  type HarnessRunManifestRecord,
  type WorkflowReplayAttemptDetail,
  type WorkflowRunReplayResponse,
} from "@shared/contracts";
import { CANARY_FIXTURE_MODELS } from "@shared/harness";
import {
  parseHarnessCanaryEnv,
  type HarnessCanaryEnv,
} from "./canary-contract.js";
import { ENGINE_CANARY_FIXTURES } from "./engine-canary-fixtures.js";
import { createMcpAuthorizedFetch } from "./mcp-machine-credential.js";
import {
  assertReplayCanaryEvidence,
  createReplayCanaryFixture,
  parseReplayCanaryEnv,
  parseReplayCanaryLogLines,
  REPLAY_CANARY_COVERAGE_PATHS,
  REPLAY_CANARY_FIXTURE_NONCE,
  scanReplayCanaryLogRows,
  type ReplayCanaryEnv,
  type ReplayCanaryFixture,
  type ReplayCanaryLogWindow,
  type ReplayCanaryRunLogs,
} from "../replay/canary-contract.js";

// The canary observes the target only through the MCP surface its machine
// credential reaches (`mcp:read runs:dispatch`): no database connection, no
// SQL. Identity comes from workflows.list before a dispatch and from the run's
// own runs.logs manifest after it, claims are released through runs.cancel, and
// every fixture ticket is checked out of the Ai column before and after its run.

// The historical query replaced a `--follow` stream: the stream prints a
// keepalive line every few seconds, so a file fed by it never settles, and its
// lines never named the run, so coverage by run id could not pass either.
const REPLAY_CANARY_VERCEL_CLI = "vercel@59.17.0";
const REPLAY_CANARY_LOG_QUERY_LIMIT = 1_000;
// Vercel indexes a request some seconds after it answers, so the query starts
// before the run and is retried until the step route shows up.
const REPLAY_CANARY_LOG_SINCE_GRACE_MS = 30_000;
const REPLAY_CANARY_LOG_QUERY_FLOOR_MS = 30_000;

const FIXTURE_LABELS = ["claude", "codex", "custom"] as const;
type FixtureLabel = (typeof FIXTURE_LABELS)[number];

/**
 * Which fixtures a canary run dispatches. The default is the custom-profile
 * case alone (a Haiku profile, definition 38), which also carries the replay
 * leg: the built-in Claude case runs Opus and the built-in Codex case spends
 * on the OpenAI account, and both run on demo, which shares production's
 * database. `all` adds them back for a change that touches a built-in harness.
 */
export type CanaryCaseSelection = "custom" | "all";

const SELECTED_LABELS: Record<CanaryCaseSelection, readonly FixtureLabel[]> = {
  custom: ["custom"],
  all: FIXTURE_LABELS,
};

/** `ENGINE_CANARY_CASES`: empty or absent is `custom`; anything unknown is refused. */
export function canaryCaseSelection(source: NodeJS.ProcessEnv): CanaryCaseSelection {
  const value = source.ENGINE_CANARY_CASES?.trim() ?? "";
  if (value === "" || value === "custom") return "custom";
  if (value === "all") return "all";
  throw new Error(`ENGINE_CANARY_CASES must be "custom" or "all", got "${value}"`);
}

const BUILTIN_PROFILE_IDS = {
  claude: "builtin-claude",
  codex: "builtin-codex",
} as const;

// Newest first (tickets.list_runs orders by start). Only the newest run and a
// run that is still live can hold the fixture ticket's claim, so a short page
// is enough to find them.
const SWEEP_RUN_PAGE_LIMIT = 5;

// Where a fixture ticket rests between runs in the QA project.
const FIXTURE_TICKET_HOME_STATUS = "Do zrobienia";

// A success whose end-of-run write has not landed is withheld by runs.result
// until its own pendingUntil. The grace ends on the server clock and the write
// may land just after it, so the canary keeps reading this much longer before
// it calls the completion stuck.
const COMPLETION_PENDING_SLACK_MS = 30_000;

interface CancelBudget {
  budgetMs: number;
  delayMs: number;
}

// runs.cancel answers unconfirmed (CONFLICT, nothing changed) on a run whose
// stored outcome is final but whose Workflow run has not retired yet, for up to
// two minutes after its completion (RETIRING_RUN_GRACE_MS in cancel-run.ts). The
// release outlasts that window with room for the calls themselves.
const RELEASE_BUDGET: CancelBudget = { budgetMs: 160_000, delayMs: 5_000 };

// Settling a run nobody watched finish: a live run answers cancelled while its
// steps drain and only a later ask converges it to already_terminal, and the
// demo target runs no cron that would converge it instead. The run first has to
// finish draining, then retire, so this budget is longer than the release's.
const SETTLE_BUDGET: CancelBudget = { budgetMs: 300_000, delayMs: 10_000 };

export interface CanaryCase {
  label: FixtureLabel;
  workflowId: number;
  ticketKey: string;
  triggerNodeId: string;
  deployedVersion: number;
}

export interface WorkflowListData {
  workflows: Array<{
    definitionId: number;
    name: string;
    enabled: boolean;
    deployedVersion: number | null;
    deployedSchema: "v2" | "legacy-v1";
    triggers: Array<{
      triggerNodeId: string;
      triggerType: string;
      manuallyDispatchable: boolean;
    }>;
  }>;
  truncated: boolean;
}

// The run level runs.logs reply: the replay half the replay check reads, plus
// the definition the capture was taken from.
export interface CanaryRunLogsOverview {
  replay: ReplayCanaryRunLogs & {
    definitionId: number | null;
    definitionVersion: number | null;
  };
}

interface DispatchPreflightData {
  deployedVersion: number;
  runnable: boolean;
  blocker?: { code: string; message: string };
  preflightDigest: string;
}

interface DispatchData {
  runId: string;
}

interface RunData {
  runId: string;
  status: string;
  terminal: boolean;
  pollAfterMs: number;
}

interface RunResultData {
  status: string;
  terminal: boolean;
  completionPending: boolean;
  pendingUntil: string | null;
  result: Record<string, unknown> | null;
  pollAfterMs: number;
}

interface RunLogsDetail {
  availability: string;
  attempt: WorkflowReplayAttemptDetail | null;
}

interface TicketData {
  ticketKey: string;
  status: string | null;
}

interface TicketRunsData {
  runs: Array<{ runId: string; status: string; terminal: boolean }>;
  truncated: boolean;
}

interface CancelRunData {
  runId: string;
  outcome: string;
}

interface SettingData {
  setting: { key: string; value: unknown };
}

interface ReplayCaseVerification {
  env: ReplayCanaryEnv;
  fixture: ReplayCanaryFixture;
}

interface CanaryMcpCaller {
  call<T>(name: string, args?: Record<string, unknown>): Promise<T>;
}

interface CanaryMcpClient extends CanaryMcpCaller {
  close(): Promise<void>;
}

interface CanaryClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: CanaryClock = { now: () => Date.now(), sleep: delay };

/**
 * A tool that answered isError. The reply text is the error envelope the
 * server renders (tool-catalog.ts, mcpToolErrorResult), so its code is read
 * from there rather than matched in prose.
 */
export class CanaryMcpToolError extends Error {
  readonly tool: string;
  readonly code: string | null;
  /** The envelope's retryable flag, null when the reply does not carry one. */
  readonly retryable: boolean | null;

  constructor(tool: string, reply: string) {
    super(`MCP tool ${tool} failed${reply ? `: ${reply.slice(0, 300)}` : ""}`);
    this.name = "CanaryMcpToolError";
    this.tool = tool;
    const error = readErrorEnvelope(reply);
    this.code = typeof error?.code === "string" ? error.code : null;
    this.retryable =
      typeof error?.retryable === "boolean" ? error.retryable : null;
  }
}

function readErrorEnvelope(
  reply: string,
): { code?: unknown; retryable?: unknown } | null {
  try {
    const parsed = JSON.parse(reply) as {
      error?: { code?: unknown; retryable?: unknown };
    } | null;
    return parsed?.error ?? null;
  } catch {
    return null;
  }
}

export interface HarnessProfilePreviewCanaryOptions {
  verifyReplay?: boolean;
}

export async function runHarnessProfilePreviewCanary(
  source: NodeJS.ProcessEnv = process.env,
  options: HarnessProfilePreviewCanaryOptions = {},
): Promise<void> {
  const env = parseHarnessCanaryEnv(source);
  const selection = canaryCaseSelection(source);
  const replayEnv = options.verifyReplay ? parseReplayCanaryEnv(source) : null;
  const mcp = await createCanaryMcpClient(env);

  try {
    await mcp.call("system.capabilities");
    const aiColumn = await readAiColumn(mcp);

    // The tool schema caps limit at 100 (mcp-contract.json); 200 is rejected as
    // VALIDATION_FAILED before the handler runs.
    const listed = await mcp.call<WorkflowListData>("workflows.list", {
      limit: 100,
    });
    const cases = resolveCanaryCases(listed, selection);

    // A previous job that ended between a dispatch and its release (a timeout,
    // a cancelled job) leaves a claim the next preflight refuses as active_run,
    // and a ticket left in Ai is dispatched again by the poll.
    for (const canary of cases) {
      await sweepFixtureTicket(mcp, canary, aiColumn);
    }

    const replayFixture = replayEnv
      ? createReplayCanaryFixture(REPLAY_CANARY_FIXTURE_NONCE)
      : null;

    for (const canary of cases) {
      const replay =
        canary.label === "custom" && replayEnv && replayFixture
          ? { env: replayEnv, fixture: replayFixture }
          : undefined;
      const runId = await executeCase(env, mcp, canary, aiColumn, replay);
      console.log(
        `[harness-canary] ${canary.label}: ${runId} succeeded on ${canary.ticketKey} with definition ${canary.workflowId}@${canary.deployedVersion}`,
      );
    }
  } finally {
    await mcp.close();
  }

  console.log(
    options.verifyReplay
      ? "[harness-canary] PASS: provider/profile execution and replay sanitization completed on the preview."
      : "[harness-canary] PASS: built-in Claude, built-in Codex, and the exact custom skill profile completed on the preview.",
  );
}

/**
 * Before any dispatch: every fixture definition the file pins is listed,
 * disabled, deployed at the pinned version, and carries exactly one manually
 * dispatchable ticket trigger.
 */
export function resolveCanaryCases(
  listed: WorkflowListData,
  selection: CanaryCaseSelection = "custom",
): CanaryCase[] {
  if (listed.truncated) {
    throw new Error("Workflow list is truncated before canary fixture validation");
  }
  return SELECTED_LABELS[selection].map((label) => {
    const fixture = ENGINE_CANARY_FIXTURES[label];
    const name = `Workflow ${fixture.workflowId} (${label} fixture)`;
    const summary = listed.workflows.find(
      (workflow) => workflow.definitionId === fixture.workflowId,
    );
    if (!summary) throw new Error(`${name} is not listed on the target`);
    if (summary.enabled) throw new Error(`${name} must stay disabled`);
    if (
      summary.deployedSchema !== "v2" ||
      summary.deployedVersion !== fixture.deployedVersion
    ) {
      throw new Error(
        `${name} deploys version ${summary.deployedVersion ?? "none"} (${summary.deployedSchema}), the fixture file pins v2 version ${fixture.deployedVersion}. The pin stands in for the graph the canary cannot read: before bumping deployedVersion in apps/worker/e2e/harness-profiles/engine-canary-fixtures.ts, review the republished graph (two nodes, one edge, workspaceMode "none", and the profile pin)`,
      );
    }
    const trigger = summary.triggers[0];
    if (
      summary.triggers.length !== 1 ||
      trigger?.triggerType !== "trigger_ticket_ai" ||
      !trigger.manuallyDispatchable
    ) {
      throw new Error(
        `${name} must keep one manually dispatchable ticket trigger`,
      );
    }
    return {
      label,
      workflowId: fixture.workflowId,
      ticketKey: fixture.ticketKey,
      triggerNodeId: trigger.triggerNodeId,
      deployedVersion: fixture.deployedVersion,
    };
  });
}

/**
 * After the run: the capture names the pinned definition and version, and the
 * Harness Profile manifest the run recorded is the one the fixture expects. For
 * the custom fixture that is the exact profile version, the cheapest model of
 * its provider, and the pinned GitHub skill down to its commit.
 */
export function assertCanaryRunIdentity(
  overview: CanaryRunLogsOverview,
  canary: Pick<CanaryCase, "label" | "workflowId" | "deployedVersion">,
): void {
  const { replay } = overview;
  const records = readHarnessManifests(overview);
  if (!records) {
    throw new Error(
      `Run did not expose its Harness Profile manifest (availability ${replay.availability}, truncated ${replay.manifestTruncated})`,
    );
  }
  if (replay.definitionId !== canary.workflowId) {
    throw new Error(
      `Run captured definition ${replay.definitionId}, the ${canary.label} fixture pins definition ${canary.workflowId}`,
    );
  }
  if (replay.definitionVersion !== canary.deployedVersion) {
    throw new Error(
      `Run captured definition version ${replay.definitionVersion}, the ${canary.label} fixture pins version ${canary.deployedVersion}`,
    );
  }
  if (canary.label === "custom") {
    assertCustomProfileRun(records);
  } else {
    assertBuiltinProfileRun(records, canary.label);
  }
}

function readHarnessManifests(
  overview: CanaryRunLogsOverview,
): HarnessRunManifestRecord[] | null {
  const { replay } = overview;
  const value = replay.manifest?.value;
  if (
    replay.availability !== "available" ||
    replay.manifestTruncated ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const harnesses = (value as Record<string, unknown>).harnesses;
  return Array.isArray(harnesses)
    ? (harnesses as HarnessRunManifestRecord[])
    : null;
}

function assertBuiltinProfileRun(
  records: HarnessRunManifestRecord[],
  provider: "claude" | "codex",
): void {
  const profileId = BUILTIN_PROFILE_IDS[provider];
  const record = records.find(
    (candidate) => candidate.reference?.profileId === profileId,
  );
  if (!record) {
    throw new Error(`Run did not capture the built-in Harness Profile ${profileId}`);
  }
  if (record.manifest.system !== true) {
    throw new Error(`${profileId} did not run as a system profile`);
  }
  if (record.manifest.harness.provider !== provider) {
    throw new Error(
      `${profileId} ran on provider ${record.manifest.harness.provider}, expected ${provider}`,
    );
  }
}

function assertCustomProfileRun(records: HarnessRunManifestRecord[]): void {
  const fixture = ENGINE_CANARY_FIXTURES.custom;
  const record = records.find(
    (candidate) => candidate.reference?.profileId === fixture.profileId,
  );
  if (!record) {
    throw new Error(
      `Run did not capture the custom Harness Profile ${fixture.profileId}`,
    );
  }
  if (record.reference.version !== fixture.profileVersion) {
    throw new Error(
      `Run captured custom profile version ${record.reference.version}, the fixture file pins ${fixture.profileVersion}`,
    );
  }
  if (record.manifest.system !== false) {
    throw new Error("Custom canary profile ran as a system profile");
  }
  const cheapestModel = CANARY_FIXTURE_MODELS[record.manifest.harness.provider];
  if (record.manifest.model.id !== cheapestModel) {
    throw new Error(
      `Custom canary profile must use ${cheapestModel}, the run used ${record.manifest.model.id}`,
    );
  }
  const skill = record.skills.find(
    (candidate) => candidate.name === fixture.skillName,
  );
  if (!skill) {
    throw new Error(
      `Run did not capture the pinned skill name ${fixture.skillName}`,
    );
  }
  if (skill.artifactHash !== fixture.skillArtifactHash) {
    throw new Error(
      `Run captured skill artifact hash ${skill.artifactHash}, the fixture file pins ${fixture.skillArtifactHash}`,
    );
  }
  // The canary pins a GitHub-imported skill; a deployment-local source in this
  // slot is itself the failure, not a shape to branch on.
  if (!isHarnessGitHubSkillSource(skill.source)) {
    throw new Error("Run captured a pinned skill whose source is not a GitHub import");
  }
  for (const field of ["owner", "repository", "path", "commitSha"] as const) {
    if (skill.source[field] !== fixture.skillSource[field]) {
      throw new Error(
        `Run captured skill source ${field} ${skill.source[field]}, the fixture file pins ${fixture.skillSource[field]}`,
      );
    }
  }
}

/** The Ai column as the target itself is configured, the column the poll reads. */
export async function readAiColumn(mcp: CanaryMcpCaller): Promise<string> {
  const reply = await mcp.call<SettingData>("settings.get", {
    key: "COLUMN_AI",
    limit: 1,
  });
  const value = reply.setting?.value;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Target setting COLUMN_AI does not name a column: ${JSON.stringify(value)}`,
    );
  }
  return value.trim();
}

/**
 * A fixture ticket left in the Ai column is unowned work to the poll, which
 * dispatches a stray run on it (AWP-176, 2026-09-15). runs.cancel withdraws the
 * ticket when it releases a finished run's claim, so a ticket still in Ai
 * afterwards is a product failure to report, not something to move by hand.
 */
export async function assertFixtureTicketOutsideAiColumn(
  mcp: CanaryMcpCaller,
  ticketKey: string,
  aiColumn: string,
): Promise<void> {
  const status = await readFixtureTicketAiStatus(mcp, ticketKey, aiColumn);
  if (status !== null) {
    throw new Error(
      `Fixture ticket ${ticketKey} is still in the Ai column (status "${status}") after runs.cancel; the next poll would dispatch a stray run on it`,
    );
  }
}

/** The ticket's status when it sits in the Ai column, null when it does not. */
async function readFixtureTicketAiStatus(
  mcp: CanaryMcpCaller,
  ticketKey: string,
  aiColumn: string,
): Promise<string | null> {
  const ticket = await mcp.call<TicketData>("tickets.get", { ticketKey });
  if (ticket.ticketKey.toUpperCase() !== ticketKey.toUpperCase()) {
    throw new Error(
      `Fixture ticket ${ticketKey} did not resolve to the configured key (resolved ${ticket.ticketKey})`,
    );
  }
  const status = ticket.status ?? "";
  return status.trim().toLowerCase() === aiColumn.trim().toLowerCase()
    ? status
    : null;
}

/**
 * Release the claim of a run the canary watched finish. The target runs no
 * reconciler cron of its own, so the canary asks the run lifecycle to do the
 * reconciler's bookkeeping: on a finished run runs.cancel answers
 * already_terminal after releasing the claim and withdrawing the ticket. An
 * unconfirmed answer is retried within the release budget. "cancelled" would
 * mean the run was still live, which the canary had already reported it was not.
 */
export async function releaseCanaryRun(
  mcp: CanaryMcpCaller,
  runId: string,
  clock: CanaryClock = SYSTEM_CLOCK,
): Promise<void> {
  // One idempotency key for the whole release: an unconfirmed cancel hands the
  // key back, so its retries ask the same question again.
  const idempotencyKey = randomUUID();
  const deadline = clock.now() + RELEASE_BUDGET.budgetMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const answer = await askRunsCancel(mcp, runId, idempotencyKey);
    if (answer.outcome === "cancelled" && attempts > 1) {
      // The canary saw this run succeed, so the unconfirmed answers were the
      // retiring window, and a cancel after it is the full path on a finished run.
      throw new Error(
        `Canary run ${runId} finished, but Workflow did not retire the run within the two minute window: runs.cancel answered unconfirmed ${attempts - 1} time${attempts === 2 ? "" : "s"}, then cancelled, so the cancel overwrote its outcome`,
      );
    }
    if (answer.outcome === "cancelled") {
      throw new Error(
        `Canary run ${runId} was still live when the canary released it: runs.cancel answered cancelled`,
      );
    }
    if (answer.outcome === "already_terminal") return;
    if (clock.now() + RELEASE_BUDGET.delayMs > deadline) {
      throw new Error(
        `runs.cancel did not confirm run ${runId} within ${RELEASE_BUDGET.budgetMs / 1_000} s (${attempts} attempts): ${answer.reply}`,
      );
    }
    await clock.sleep(RELEASE_BUDGET.delayMs);
  }
}

/**
 * Before the first dispatch on a fixture ticket: settle whatever could still
 * hold its claim. Only a run of the fixture's own definition is the canary's to
 * settle; one of those still live was most likely left by a canary job stopped
 * mid run (the per pull request cancel, the job timeout). Any other run belongs
 * to production (its poll dispatching on a ticket left in Ai), which this
 * target cannot reach: a live one fails the precondition untouched, a finished
 * one is left for production's reconciler.
 */
export async function sweepFixtureTicket(
  mcp: CanaryMcpCaller,
  fixture: { ticketKey: string; workflowId: number },
  aiColumn: string,
  clock: CanaryClock = SYSTEM_CLOCK,
): Promise<void> {
  const { ticketKey, workflowId } = fixture;
  const page = await mcp.call<TicketRunsData>("tickets.list_runs", {
    ticketKey,
    limit: SWEEP_RUN_PAGE_LIMIT,
  });
  // A subject carries at most one claim and a claim refuses every later
  // dispatch, so the holder is the newest run or a run that is still live.
  const candidates = page.runs.filter(
    (run, index) => index === 0 || !run.terminal,
  );
  const owned: string[] = [];
  for (const run of candidates) {
    const captured = await readCapturedDefinitionId(mcp, run.runId);
    if (captured.definitionId === workflowId) {
      owned.push(run.runId);
      continue;
    }
    if (run.terminal) {
      const definition =
        captured.definitionId === null
          ? `a definition that could not be read from runs.logs (${captured.unreadable})`
          : `definition ${captured.definitionId}`;
      console.log(
        `[harness-canary] ${ticketKey}: leaving finished run ${run.runId} of ${definition} untouched; it is not a run of fixture definition ${workflowId}`,
      );
      continue;
    }
    if (captured.definitionId === null) {
      throw new Error(
        `Fixture ticket ${ticketKey} has live run ${run.runId} whose definition could not be read from runs.logs (${captured.unreadable}): it is unknown whose run it is, so nothing was touched. Settle it where it was dispatched, then run the canary again`,
      );
    }
    throw new Error(
      `Fixture ticket ${ticketKey} has live run ${run.runId} of definition ${captured.definitionId}, not fixture definition ${workflowId}: the canary did not dispatch it and leaves it untouched. Production owns it and must settle it first (let it finish or cancel it on production), then run the canary again`,
    );
  }
  let cancelledLiveRun = false;
  for (const runId of owned) {
    const settled = await settleCanaryRun(
      mcp,
      { runId, ticketKey },
      "a run of the fixture definition was still live on the fixture ticket, most likely left by a canary job stopped mid run",
      clock,
    );
    cancelledLiveRun ||= settled.cancelledLiveRun;
  }
  const status = await readFixtureTicketAiStatus(mcp, ticketKey, aiColumn);
  if (status === null) return;
  if (cancelledLiveRun) {
    throw new Error(
      `Fixture ticket ${ticketKey} is still in the Ai column (status "${status}") after runs.cancel; the next poll would dispatch a stray run on it`,
    );
  }
  // Nothing live held the ticket and every finished run answered
  // already_terminal, so no run of the product put it there or kept it there.
  throw new Error(
    `Fixture ticket ${ticketKey} is in the Ai column (status "${status}") with no live run: it was moved into Ai outside the canary. The canary does not move tickets; move it back to "${FIXTURE_TICKET_HOME_STATUS}" by hand, then run the canary again`,
  );
}

/**
 * The definition a run's capture was taken from. When runs.logs does not show
 * one, definitionId is null and unreadable says why (the caught error, or no
 * captured definition in the reply).
 */
async function readCapturedDefinitionId(
  mcp: CanaryMcpCaller,
  runId: string,
): Promise<
  { definitionId: number } | { definitionId: null; unreadable: string }
> {
  try {
    const overview = await mcp.call<Partial<CanaryRunLogsOverview> | null>(
      "runs.logs",
      { runId },
    );
    const definitionId = overview?.replay?.definitionId;
    return typeof definitionId === "number"
      ? { definitionId }
      : { definitionId: null, unreadable: "the reply carries no captured definition" };
  } catch (error) {
    return { definitionId: null, unreadable: errorMessage(error) };
  }
}

/**
 * Everything after a dispatch: the observations, then the release and the Ai
 * check. Any failure among them, the release included, still leaves the target
 * the way the canary found it before the failure is reported.
 */
export async function finishCanaryRun(
  mcp: CanaryMcpCaller,
  target: { runId: string; ticketKey: string; aiColumn: string },
  observe: () => Promise<void>,
  clock: CanaryClock = SYSTEM_CLOCK,
): Promise<void> {
  try {
    await observe();
    await releaseCanaryRun(mcp, target.runId, clock);
    await assertFixtureTicketOutsideAiColumn(
      mcp,
      target.ticketKey,
      target.aiColumn,
    );
  } catch (error) {
    const cleanupFailure = await leaveTargetAfterFailedRun(
      mcp,
      target.runId,
      target.ticketKey,
      target.aiColumn,
      clock,
    );
    if (cleanupFailure) {
      throw new Error(
        `${errorMessage(error)}; leaving the target clean also failed: ${cleanupFailure}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * A failed case still leaves the target the way it found it. The run may be
 * finished (it failed, or an assertion about it did) or live (a timeout, a read
 * that failed mid-poll), so it is settled until runs.cancel answers
 * already_terminal. Returns why the cleanup failed, or null.
 */
export async function leaveTargetAfterFailedRun(
  mcp: CanaryMcpCaller,
  runId: string,
  ticketKey: string,
  aiColumn: string,
  clock: CanaryClock = SYSTEM_CLOCK,
): Promise<string | null> {
  try {
    await settleCanaryRun(
      mcp,
      { runId, ticketKey },
      "the case failed while its run was still live",
      clock,
    );
    await assertFixtureTicketOutsideAiColumn(mcp, ticketKey, aiColumn);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * Ask runs.cancel until it answers already_terminal, the only answer that
 * releases the claim and withdraws the ticket. "cancelled" is not final: the
 * run's steps may still be draining, its claim stays "cancelling" and its
 * ticket stays in Ai until a later ask converges it. An unconfirmed answer (the
 * run is still being retired) is asked again too.
 *
 * Every ask carries a fresh idempotency key: a key whose call answered
 * cancelled is stored and would replay cancelled forever.
 */
async function settleCanaryRun(
  mcp: CanaryMcpCaller,
  target: { runId: string; ticketKey: string },
  whyLive: string,
  clock: CanaryClock,
): Promise<{ cancelledLiveRun: boolean }> {
  const { runId, ticketKey } = target;
  const deadline = clock.now() + SETTLE_BUDGET.budgetMs;
  let cancelledLiveRun = false;
  let unconfirmedBefore = 0;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const answer = await askRunsCancel(mcp, runId, randomUUID());
    if (answer.outcome === "already_terminal") return { cancelledLiveRun };
    if (answer.outcome === "cancelled" && !cancelledLiveRun) {
      cancelledLiveRun = true;
      console.warn(
        unconfirmedBefore === 0
          ? `[harness-canary] WARNING: cancelled live run ${runId} on ${ticketKey}; ${whyLive}`
          : `[harness-canary] WARNING: cancelled run ${runId} on ${ticketKey} after ${unconfirmedBefore} unconfirmed answer${unconfirmedBefore === 1 ? "" : "s"}; if the run had already finished on its own, Workflow did not retire it within the two minute window and the cancel overwrote its outcome`,
      );
    }
    if (answer.outcome === "unconfirmed" && !cancelledLiveRun) {
      unconfirmedBefore += 1;
    }
    if (clock.now() + SETTLE_BUDGET.delayMs > deadline) {
      const last =
        answer.outcome === "cancelled"
          ? "cancelled (the run was still draining)"
          : answer.reply;
      throw new Error(
        `Run ${runId} did not settle to already_terminal within ${SETTLE_BUDGET.budgetMs / 1_000} s (${attempts} runs.cancel attempts); the last answer was ${last}. Its claim may still be held and fixture ticket ${ticketKey} may still be in the Ai column`,
      );
    }
    await clock.sleep(SETTLE_BUDGET.delayMs);
  }
}

type CancelAnswer =
  | { outcome: "cancelled" }
  | { outcome: "already_terminal" }
  | { outcome: "unconfirmed"; reply: string };

/** One runs.cancel call. Only a retryable CONFLICT comes back unconfirmed; any other refusal throws. */
async function askRunsCancel(
  mcp: CanaryMcpCaller,
  runId: string,
  idempotencyKey: string,
): Promise<CancelAnswer> {
  let reply: CancelRunData;
  try {
    reply = await mcp.call<CancelRunData>("runs.cancel", {
      runId,
      idempotencyKey,
    });
  } catch (error) {
    if (
      error instanceof CanaryMcpToolError &&
      error.code === "CONFLICT" &&
      error.retryable !== false
    ) {
      return { outcome: "unconfirmed", reply: error.message };
    }
    throw new Error(
      `runs.cancel did not confirm run ${runId}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (reply.outcome !== "already_terminal" && reply.outcome !== "cancelled") {
    throw new Error(
      `runs.cancel answered an unexpected outcome for run ${runId}: ${JSON.stringify(reply)}`,
    );
  }
  return reply.outcome === "cancelled"
    ? { outcome: "cancelled" }
    : { outcome: "already_terminal" };
}

async function executeCase(
  env: HarnessCanaryEnv,
  mcp: CanaryMcpClient,
  canary: CanaryCase,
  aiColumn: string,
  replay?: ReplayCaseVerification,
): Promise<string> {
  const input = {
    definitionId: canary.workflowId,
    triggerNodeId: canary.triggerNodeId,
    input: { kind: "ticket", ticketKey: canary.ticketKey },
  };
  const preflight = await mcp.call<DispatchPreflightData>(
    "workflows.dispatch_preflight",
    input,
  );
  if (!preflight.runnable) {
    throw new Error(
      `${canary.label} dispatch preflight refused: ${preflight.blocker?.code ?? "unknown"}`,
    );
  }
  if (preflight.deployedVersion !== canary.deployedVersion) {
    throw new Error(`Workflow ${canary.workflowId} deployment changed after validation`);
  }
  const startedAt = Date.now();
  const dispatched = await mcp.call<DispatchData>("workflows.dispatch", {
    ...input,
    expectedDeployedVersion: preflight.deployedVersion,
    preflightDigest: preflight.preflightDigest,
    idempotencyKey: randomUUID(),
  });
  const deadline = Date.now() + env.HARNESS_CANARY_TIMEOUT_MS;
  await finishCanaryRun(
    mcp,
    { runId: dispatched.runId, ticketKey: canary.ticketKey, aiColumn },
    async () => {
      await waitForSuccessfulRun(mcp, dispatched.runId, deadline);
      // Every step and flow request of this run answered between the dispatch
      // and the read that reported it settled, so that is the window the log
      // query has to cover.
      const runWindow = { startedAt, endedAt: Date.now() };
      const overview = await waitForHarnessManifest(
        mcp,
        dispatched.runId,
        deadline,
      );
      assertCanaryRunIdentity(overview, canary);
      if (replay) {
        await verifyReplayCase(replay, mcp, dispatched.runId, deadline, runWindow);
      }
    },
  );
  return dispatched.runId;
}

/**
 * Wait for the run to succeed and for its end-of-run write to land. Releasing
 * before that write is how the release raced the run's own finalization, so a
 * success with completionPending is waited on, honouring the reply's
 * pollAfterMs, until a read carries a result and no pending completion.
 */
export async function waitForSuccessfulRun(
  mcp: CanaryMcpCaller,
  runId: string,
  deadline: number,
  clock: CanaryClock = SYSTEM_CLOCK,
): Promise<void> {
  let pendingBound: number | null = null;
  while (clock.now() < deadline) {
    const run = await mcp.call<RunData>("runs.get", { runId });
    if (!run.terminal) {
      await clock.sleep(Math.max(1_000, run.pollAfterMs));
      continue;
    }
    const result = await mcp.call<RunResultData>("runs.result", { runId });
    if (
      run.status !== "success" ||
      result.status !== "success" ||
      !result.terminal
    ) {
      throw new Error(`Canary run ${runId} ended as ${run.status}`);
    }
    if (!result.completionPending && result.result !== null) return;
    const pendingUntil =
      result.pendingUntil === null ? Number.NaN : Date.parse(result.pendingUntil);
    if (!Number.isNaN(pendingUntil)) {
      pendingBound = pendingUntil + COMPLETION_PENDING_SLACK_MS;
    }
    pendingBound ??= clock.now() + COMPLETION_PENDING_SLACK_MS;
    if (clock.now() >= pendingBound) {
      throw new Error(
        `Canary run ${runId} succeeded but its completion never settled: completionPending ${result.completionPending}, result ${result.result === null ? "withheld" : "present"}, pendingUntil ${result.pendingUntil ?? "none"}`,
      );
    }
    await clock.sleep(Math.max(1_000, result.pollAfterMs));
  }
  throw new Error(`Timed out waiting for canary run ${runId}`);
}

async function waitForHarnessManifest(
  mcp: CanaryMcpClient,
  runId: string,
  deadline: number,
): Promise<CanaryRunLogsOverview> {
  while (Date.now() < deadline) {
    const overview = await mcp.call<CanaryRunLogsOverview>("runs.logs", {
      runId,
    });
    if (
      overview.replay.definitionVersion !== null &&
      readHarnessManifests(overview) !== null
    ) {
      return overview;
    }
    await delay(2_000);
  }
  throw new Error(`Run ${runId} did not expose its Harness Profile manifest`);
}

async function verifyReplayCase(
  replay: ReplayCaseVerification,
  mcp: CanaryMcpClient,
  runId: string,
  deadline: number,
  runWindow: ReplayCanaryLogWindow,
): Promise<void> {
  const { runLogs, summary, details } = await waitForReplayMcp(
    mcp,
    runId,
    deadline,
  );
  const appendedLogExport = await readCoveredReplayLogWindow(
    replay.env,
    runWindow,
  );
  assertReplayCanaryEvidence(
    {
      runLogs,
      apiSummary: summary,
      apiDetails: details,
      appendedLogExport,
    },
    replay.fixture,
  );
}

// The attempt row is written before the run answers terminal and its log
// envelope is patched in afterwards, so a single read can catch an attempt
// without one. The wait covers the trace, every attempt's detail and the run
// level index together, so the three surfaces the check compares describe the
// same capture.
async function waitForReplayMcp(
  mcp: CanaryMcpClient,
  runId: string,
  deadline: number,
): Promise<{
  runLogs: ReplayCanaryRunLogs;
  summary: WorkflowRunReplayResponse;
  details: WorkflowReplayAttemptDetail[];
}> {
  while (Date.now() < deadline) {
    const summary = await mcp.call<WorkflowRunReplayResponse & {
      snapshotOmitted?: boolean;
    }>("runs.trace", { runId });
    if (summary.nextCursor !== null) {
      throw new Error("Minimal replay canary unexpectedly exceeded one trace page");
    }
    const expectedAttempts = summary.snapshot?.graph.nodes.length ?? 0;
    const terminal =
      summary.attempts.length >= expectedAttempts &&
      summary.attempts.every(
        (attempt) =>
          ![
            "running",
            "waiting_loop",
            "waiting_for_clarification",
          ].includes(attempt.state),
      );
    if (
      summary.availability === "available" &&
      summary.snapshot &&
      !summary.snapshotOmitted &&
      expectedAttempts > 0 &&
      terminal
    ) {
      const details = await Promise.all(
        summary.attempts.map(async (attempt) => {
          const logs = await mcp.call<RunLogsDetail>("runs.logs", {
            runId,
            attemptId: attempt.id,
          });
          return logs.attempt;
        }),
      );
      if (
        details.every(
          (detail): detail is WorkflowReplayAttemptDetail => detail !== null,
        ) &&
        details.some((detail) => detail.logs !== null)
      ) {
        const overview = await mcp.call<CanaryRunLogsOverview>("runs.logs", {
          runId,
        });
        const indexed = new Set(
          overview.replay.attempts.map((attempt) => attempt.id),
        );
        if (
          overview.replay.availability === "available" &&
          overview.replay.manifest !== null &&
          summary.attempts.every((attempt) => indexed.has(attempt.id))
        ) {
          return { runLogs: overview.replay, summary, details };
        }
      }
    }
    await delay(2_000);
  }
  throw new Error("Replay MCP tools did not finish capture before the deadline");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Coverage and the leak scan both come from one historical query, retried until
// the indexer has the run's step requests or the wait budget runs out.
async function readCoveredReplayLogWindow(
  env: ReplayCanaryEnv,
  runWindow: ReplayCanaryLogWindow,
): Promise<string> {
  const deadline = Date.now() + env.REPLAY_CANARY_LOG_WAIT_MS;
  let lastFailure = "the query returned no rows";
  for (;;) {
    try {
      const stdout = await queryDeploymentLogs(env, runWindow, deadline);
      const scan = scanReplayCanaryLogRows(
        parseReplayCanaryLogLines(stdout),
        runWindow,
      );
      if (scan.covered) {
        console.log(
          `[replay-canary] log window: ${scan.rowCount} rows, coveredRows ${scan.coveredRows}, logTextBytes ${scan.logTextBytes}`,
        );
        // A covered window with no runtime text means the leak assertion below
        // proves nothing, so it says so instead of passing silently.
        if (scan.logTextBytes === 0) {
          console.log(
            `replay canary: runtime log text empty for ${scan.coveredRows} covered rows in the window, the leak assertion ran against 0 bytes`,
          );
        }
        return scan.logText;
      }
      lastFailure = `${scan.rowCount} rows fell inside the run window and none answered ${REPLAY_CANARY_COVERAGE_PATHS.join(" or ")}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) break;
    await delay(2_000);
  }
  throw new Error(
    `Replay canary runtime log query did not prove coverage of the run: ${lastFailure}`,
  );
}

// `spawn` rather than `execFile`: the access token rides argv, and an execFile
// failure puts the whole argument list into its own error message.
function queryDeploymentLogs(
  env: ReplayCanaryEnv,
  runWindow: ReplayCanaryLogWindow,
  deadline: number,
): Promise<string> {
  const args = [
    "--yes",
    REPLAY_CANARY_VERCEL_CLI,
    "logs",
    env.ENGINE_CANARY_LOG_SOURCE_URL,
    "--json",
    "--scope",
    "blazity",
    "--token",
    env.VERCEL_TOKEN,
    "--since",
    new Date(
      runWindow.startedAt - REPLAY_CANARY_LOG_SINCE_GRACE_MS,
    ).toISOString(),
    "--until",
    new Date().toISOString(),
    "--limit",
    String(REPLAY_CANARY_LOG_QUERY_LIMIT),
  ];
  const timeoutMs = Math.max(
    REPLAY_CANARY_LOG_QUERY_FLOOR_MS,
    deadline - Date.now(),
  );
  return new Promise((resolve, reject) => {
    // `detached` puts npx and the CLI it spawns in one process group. Killing
    // only npx would leave the CLI holding the pipes open, and `close` would
    // never fire.
    const child = spawn("npx", args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure: string | null = null;
    const stop = (message: string) => {
      failure ??= message;
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(
      () => stop("the Vercel CLI log query did not answer in time"),
      timeoutMs,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > env.REPLAY_CANARY_LOG_MAX_BYTES) {
        stop("the runtime log query exceeded its bounded scan limit");
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("the Vercel CLI could not be started"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) {
        reject(new Error(failure));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `the Vercel CLI log query exited with ${code}: ${withoutSecret(stderr, env.VERCEL_TOKEN)}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

function withoutSecret(text: string, secret: string): string {
  return secret.length > 0 ? text.split(secret).join("[redacted]") : text;
}

async function createCanaryMcpClient(
  env: HarnessCanaryEnv,
): Promise<CanaryMcpClient> {
  const endpoint = new URL("/mcp", env.HARNESS_CANARY_BASE_URL);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: createMcpAuthorizedFetch({
      baseUrl: env.HARNESS_CANARY_BASE_URL,
      bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET,
      clientId: env.ENGINE_CANARY_MCP_CLIENT_ID,
      clientSecret: env.ENGINE_CANARY_MCP_CLIENT_SECRET,
    }) as FetchLike,
  });
  const client = new Client({
    name: "ai-workflow-engine-canary",
    version: "1.0.0",
  });
  await client.connect(transport);
  return {
    call: async <T>(name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const envelope = result.structuredContent as { data?: T } | undefined;
      if (result.isError || envelope?.data === undefined) {
        const detail = Array.isArray(result.content)
          ? result.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join(" ")
          : "";
        throw new CanaryMcpToolError(name, detail);
      }
      return envelope.data;
    },
    close: () => client.close(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runHarnessProfilePreviewCanary().catch((error) => {
    console.error(
      `[harness-canary] FAIL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
