import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { neon } from "@neondatabase/serverless";
import type {
  HarnessProfileManifest,
  HarnessRunManifestRecord,
  ReplaySanitizedEnvelope,
  WorkflowDefinitionV2,
  WorkflowReplayAttemptDetail,
  WorkflowRunReplayResponse,
} from "@shared/contracts";
import {
  assertCustomProfilePin,
  assertMinimalCanaryWorkflow,
  assertRunHarnessManifest,
  cancelTimedOutCanaryRun,
  parseHarnessCanaryEnv,
  type HarnessCanaryEnv,
} from "./canary-contract.js";
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
} from "../replay/canary-contract.js";

// The historical query replaced a `--follow` stream: the stream prints a
// keepalive line every few seconds, so a file fed by it never settles, and its
// lines never named the run, so coverage by run id could not pass either.
const REPLAY_CANARY_VERCEL_CLI = "vercel@59.17.0";
const REPLAY_CANARY_LOG_QUERY_LIMIT = 1_000;
// Vercel indexes a request some seconds after it answers, so the query starts
// before the run and is retried until the step route shows up.
const REPLAY_CANARY_LOG_SINCE_GRACE_MS = 30_000;
const REPLAY_CANARY_LOG_QUERY_FLOOR_MS = 30_000;

type SqlClient = ReturnType<typeof neon>;

interface CanaryCase {
  label: "claude" | "codex" | "custom";
  workflowId: number;
  triggerNodeId: string;
  deployedVersion: number;
  reference: { profileId: string; version: number };
  provider: "claude" | "codex";
  skill?: {
    artifactHash: string;
    name: string;
    owner: string;
    repository: string;
    path: string;
    commitSha: string;
  };
}

interface StoredHarnessProfile {
  id: string;
  organizationId: string | null;
  system: boolean;
  archivedAt: string | null;
  publishedVersion: number | null;
  manifest: HarnessProfileManifest | null;
}

interface WorkflowListData {
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
}

interface RunLogsOverview {
  replay: {
    availability: string;
    manifest: ReplaySanitizedEnvelope | null;
    manifestTruncated: boolean;
    definitionVersion: number | null;
    attempts: Array<{ id: number }>;
  };
}

interface RunLogsDetail {
  availability: string;
  attempt: WorkflowReplayAttemptDetail | null;
}

interface ReplayCaseVerification {
  env: ReplayCanaryEnv;
  fixture: ReplayCanaryFixture;
}

interface CanaryMcpClient {
  call<T>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export interface HarnessProfilePreviewCanaryOptions {
  verifyReplay?: boolean;
}

export async function runHarnessProfilePreviewCanary(
  source: NodeJS.ProcessEnv = process.env,
  options: HarnessProfilePreviewCanaryOptions = {},
): Promise<void> {
  const env = parseHarnessCanaryEnv(source);
  const replayEnv = options.verifyReplay ? parseReplayCanaryEnv(source) : null;
  const sql = neon(env.DATABASE_URL);
  const mcp = await createCanaryMcpClient(env);

  try {
    await mcp.call("system.capabilities");
    const ticket = await mcp.call<{ ticketKey: string }>("tickets.get", {
      ticketKey: env.HARNESS_CANARY_TICKET_KEY,
    });
    if (ticket.ticketKey.toUpperCase() !== env.HARNESS_CANARY_TICKET_KEY) {
      throw new Error("Permanent canary ticket did not resolve to the configured key");
    }

    const profiles = await readHarnessProfiles(sql, env);
    const claude = requiredSystemProfile(profiles, "builtin-claude", "claude");
    const codex = requiredSystemProfile(profiles, "builtin-codex", "codex");
    const custom = profiles.find(
      (profile) => profile.id === env.HARNESS_CANARY_CUSTOM_PROFILE_ID,
    );
    if (!custom) throw new Error("Custom canary profile is not available");
    assertCustomProfilePin(custom, {
      profileId: env.HARNESS_CANARY_CUSTOM_PROFILE_ID,
      version: env.HARNESS_CANARY_CUSTOM_PROFILE_VERSION,
      artifactHash: env.HARNESS_CANARY_CUSTOM_SKILL_ARTIFACT_HASH,
      skillName: env.HARNESS_CANARY_CUSTOM_SKILL_NAME,
    });
    const customProvider = custom.manifest!.harness.provider;
    await assertPinnedSkillExists(sql, env, custom.organizationId);

    // The tool schema caps limit at 100 (mcp-contract.json); 200 is rejected as
    // VALIDATION_FAILED before the handler runs.
    const listed = await mcp.call<WorkflowListData>("workflows.list", {
      limit: 100,
    });
    if (listed.truncated) {
      throw new Error("Workflow list is truncated before canary fixture validation");
    }
    const cases = await buildCanaryCases(sql, env, listed, {
      claude,
      codex,
      customProvider,
    });

    const replayFixture = replayEnv
      ? createReplayCanaryFixture(REPLAY_CANARY_FIXTURE_NONCE)
      : null;

    await releaseStaleCanaryClaim(sql, mcp, env.HARNESS_CANARY_TICKET_KEY);

    for (const canary of cases) {
      const replay =
        canary.label === "custom" && replayEnv && replayFixture
          ? { env: replayEnv, fixture: replayFixture }
          : undefined;
      const run = await executeCase(env, mcp, sql, canary, replay);
      assertRunHarnessManifest(run.manifests, {
        reference: canary.reference,
        provider: canary.provider,
        ...(canary.skill ? { skill: canary.skill } : {}),
      });
      console.log(
        `[harness-canary] ${canary.label}: ${run.runId} succeeded with ${canary.reference.profileId}@${canary.reference.version}`,
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

async function buildCanaryCases(
  sql: SqlClient,
  env: HarnessCanaryEnv,
  listed: WorkflowListData,
  profiles: {
    claude: StoredHarnessProfile;
    codex: StoredHarnessProfile;
    customProvider: "claude" | "codex";
  },
): Promise<CanaryCase[]> {
  // Read the deployed definitions from the database rather than through
  // workflows.get_graph: that tool rides workflows:write (the read half of
  // authoring, policy.ts) and the canary's machine token deliberately holds
  // only mcp:read and runs:dispatch, so the call answers INSUFFICIENT_SCOPE.
  const definitions = await Promise.all(
    [
      env.HARNESS_CANARY_CLAUDE_WORKFLOW_ID,
      env.HARNESS_CANARY_CODEX_WORKFLOW_ID,
      env.HARNESS_CANARY_CUSTOM_WORKFLOW_ID,
    ].map(async (id) => {
      const rows = await sql`
        SELECT d.id, d.enabled, d.deployed_version, v.definition
        FROM workflow_definitions d
        LEFT JOIN workflow_definition_versions v
          ON v.definition_id = d.id AND v.version = d.deployed_version
        WHERE d.id = ${id} AND d.archived_at IS NULL
      `;
      const row = rows[0] as
        | {
            id: number;
            enabled: boolean;
            deployed_version: number | null;
            definition: unknown;
          }
        | undefined;
      if (!row) throw new Error(`Workflow ${id} does not exist or is archived`);
      const deployed = row.definition;
      return {
        id: row.id,
        enabled: row.enabled,
        deployedVersion: row.deployed_version,
        definition:
          deployed && typeof deployed === "object" && "schemaVersion" in deployed
            ? (deployed as WorkflowDefinitionV2)
            : null,
      };
    }),
  );
  const inputs = [
    {
      label: "claude" as const,
      workflowId: env.HARNESS_CANARY_CLAUDE_WORKFLOW_ID,
      reference: {
        profileId: profiles.claude.id,
        version: profiles.claude.publishedVersion!,
      },
      provider: "claude" as const,
    },
    {
      label: "codex" as const,
      workflowId: env.HARNESS_CANARY_CODEX_WORKFLOW_ID,
      reference: {
        profileId: profiles.codex.id,
        version: profiles.codex.publishedVersion!,
      },
      provider: "codex" as const,
    },
    {
      label: "custom" as const,
      workflowId: env.HARNESS_CANARY_CUSTOM_WORKFLOW_ID,
      reference: {
        profileId: env.HARNESS_CANARY_CUSTOM_PROFILE_ID,
        version: env.HARNESS_CANARY_CUSTOM_PROFILE_VERSION,
      },
      provider: profiles.customProvider,
      skill: {
        artifactHash: env.HARNESS_CANARY_CUSTOM_SKILL_ARTIFACT_HASH,
        name: env.HARNESS_CANARY_CUSTOM_SKILL_NAME,
        owner: env.HARNESS_CANARY_CUSTOM_SKILL_SOURCE_OWNER,
        repository: env.HARNESS_CANARY_CUSTOM_SKILL_SOURCE_REPOSITORY,
        path: env.HARNESS_CANARY_CUSTOM_SKILL_SOURCE_PATH,
        commitSha: env.HARNESS_CANARY_CUSTOM_SKILL_SOURCE_COMMIT_SHA,
      },
    },
  ];

  return inputs.map((input, index) => {
    const definition = definitions[index]!;
    assertMinimalCanaryWorkflow(definition, input.reference);
    const summary = listed.workflows.find(
      (workflow) => workflow.definitionId === input.workflowId,
    );
    if (!summary) throw new Error(`Workflow ${input.workflowId} is not available`);
    if (
      summary.enabled ||
      summary.deployedSchema !== "v2" ||
      summary.deployedVersion !== definition.deployedVersion ||
      summary.triggers.length !== 1 ||
      summary.triggers[0]?.triggerType !== "trigger_ticket_ai" ||
      !summary.triggers[0].manuallyDispatchable
    ) {
      throw new Error(
        `Workflow ${input.workflowId} must stay disabled with one manually dispatchable ticket trigger`,
      );
    }
    return Object.assign(input, {
      triggerNodeId: summary.triggers[0].triggerNodeId,
      deployedVersion: definition.deployedVersion!,
    });
  });
}

async function executeCase(
  env: HarnessCanaryEnv,
  mcp: CanaryMcpClient,
  sql: SqlClient,
  canary: CanaryCase,
  replay?: ReplayCaseVerification,
): Promise<{ runId: string; manifests: HarnessRunManifestRecord[] }> {
  const input = {
    definitionId: canary.workflowId,
    triggerNodeId: canary.triggerNodeId,
    input: { kind: "ticket", ticketKey: env.HARNESS_CANARY_TICKET_KEY },
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
  try {
    await waitForSuccessfulRun(mcp, dispatched.runId, deadline);
    // Every step and flow request of this run answered between the dispatch and
    // the read that reported it terminal, so that is the window the log query
    // has to cover.
    const runWindow = { startedAt, endedAt: Date.now() };
    const manifests = await waitForHarnessManifest(mcp, dispatched.runId, deadline);
    if (replay) {
      await verifyReplayCase(
        replay,
        mcp,
        sql,
        dispatched.runId,
        deadline,
        runWindow,
      );
    }
    await releaseFinishedRunClaim(sql, env.HARNESS_CANARY_TICKET_KEY, dispatched.runId);
    return { runId: dispatched.runId, manifests };
  } catch (error) {
    if (Date.now() >= deadline) {
      await cancelTimedOutCanaryRun(mcp, dispatched.runId);
    }
    throw error;
  }
}

async function waitForSuccessfulRun(
  mcp: CanaryMcpClient,
  runId: string,
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const run = await mcp.call<RunData>("runs.get", { runId });
    if (run.terminal) {
      const result = await mcp.call<RunResultData>("runs.result", { runId });
      if (
        run.status !== "success" ||
        result.status !== "success" ||
        !result.terminal ||
        result.completionPending
      ) {
        throw new Error(`Canary run ${runId} ended as ${run.status}`);
      }
      return;
    }
    await delay(Math.max(1_000, run.pollAfterMs));
  }
  throw new Error(`Timed out waiting for canary run ${runId}`);
}

async function waitForHarnessManifest(
  mcp: CanaryMcpClient,
  runId: string,
  deadline: number,
): Promise<HarnessRunManifestRecord[]> {
  while (Date.now() < deadline) {
    const logs = await mcp.call<RunLogsOverview>("runs.logs", { runId });
    const value = logs.replay.manifest?.value;
    if (
      logs.replay.availability === "available" &&
      logs.replay.definitionVersion !== null &&
      !logs.replay.manifestTruncated &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const harnesses = (value as Record<string, unknown>).harnesses;
      if (Array.isArray(harnesses)) {
        return harnesses as unknown as HarnessRunManifestRecord[];
      }
    }
    await delay(2_000);
  }
  throw new Error(`Run ${runId} did not expose its Harness Profile manifest`);
}

async function verifyReplayCase(
  replay: ReplayCaseVerification,
  mcp: CanaryMcpClient,
  sql: SqlClient,
  runId: string,
  deadline: number,
  runWindow: ReplayCanaryLogWindow,
): Promise<void> {
  const { summary, details } = await waitForReplayMcp(mcp, runId, deadline);
  const [databaseRows, appendedLogExport] = await Promise.all([
    readReplayDatabaseRows(sql, runId, deadline),
    readCoveredReplayLogWindow(replay.env, runWindow),
  ]);
  assertReplayCanaryEvidence(
    {
      databaseRows,
      apiSummary: summary,
      apiDetails: details,
      appendedLogExport,
    },
    replay.fixture,
  );
}

async function waitForReplayMcp(
  mcp: CanaryMcpClient,
  runId: string,
  deadline: number,
): Promise<{
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
        return { summary, details };
      }
    }
    await delay(2_000);
  }
  throw new Error("Replay MCP tools did not finish capture before the deadline");
}

async function readHarnessProfiles(
  sql: SqlClient,
  env: HarnessCanaryEnv,
): Promise<StoredHarnessProfile[]> {
  const rows = await sql`
    SELECT hp.id, hp.organization_id, hp.system, hp.archived_at,
           hp.published_version, hpv.manifest
    FROM harness_profiles hp
    LEFT JOIN harness_profile_versions hpv
      ON hpv.profile_id = hp.id AND hpv.version = hp.published_version
    WHERE hp.id IN (
      'builtin-claude',
      'builtin-codex',
      ${env.HARNESS_CANARY_CUSTOM_PROFILE_ID}
    )
  `;
  return rows.map((row) => ({
    id: String(row.id),
    organizationId:
      typeof row.organization_id === "string" ? row.organization_id : null,
    system: row.system === true,
    archivedAt: row.archived_at ? String(row.archived_at) : null,
    publishedVersion:
      typeof row.published_version === "number" ? row.published_version : null,
    manifest: (row.manifest as HarnessProfileManifest | null) ?? null,
  }));
}

function requiredSystemProfile(
  profiles: StoredHarnessProfile[],
  id: "builtin-claude" | "builtin-codex",
  provider: "claude" | "codex",
): StoredHarnessProfile {
  const profile = profiles.find((candidate) => candidate.id === id);
  if (
    !profile?.system ||
    profile.organizationId !== null ||
    profile.archivedAt !== null ||
    !profile.publishedVersion ||
    profile.manifest?.harness.provider !== provider
  ) {
    throw new Error(`Stable built-in ${provider} Harness Profile must be published`);
  }
  return profile;
}

async function assertPinnedSkillExists(
  sql: SqlClient,
  env: HarnessCanaryEnv,
  organizationId: string | null,
): Promise<void> {
  if (!organizationId) throw new Error("Custom profile must be organization-owned");
  const rows = await sql`
    SELECT hsa.artifact_hash, hsa.name, hsa.source_owner,
           hsa.source_repository, hsa.source_path, hsa.source_commit_sha
    FROM harness_profile_version_skills hpvs
    JOIN harness_skill_artifacts hsa ON hsa.id = hpvs.artifact_id
    WHERE hpvs.profile_id = ${env.HARNESS_CANARY_CUSTOM_PROFILE_ID}
      AND hpvs.profile_version = ${env.HARNESS_CANARY_CUSTOM_PROFILE_VERSION}
      AND hpvs.skill_name = ${env.HARNESS_CANARY_CUSTOM_SKILL_NAME}
      AND hsa.organization_id = ${organizationId}
      AND hsa.artifact_hash = ${env.HARNESS_CANARY_CUSTOM_SKILL_ARTIFACT_HASH}
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (
    row?.source_owner !== env.HARNESS_CANARY_CUSTOM_SKILL_SOURCE_OWNER ||
    row?.source_repository !==
      env.HARNESS_CANARY_CUSTOM_SKILL_SOURCE_REPOSITORY ||
    row?.source_path !== env.HARNESS_CANARY_CUSTOM_SKILL_SOURCE_PATH ||
    row?.source_commit_sha !==
      env.HARNESS_CANARY_CUSTOM_SKILL_SOURCE_COMMIT_SHA
  ) {
    throw new Error("Pinned skill source does not match the exact expected commit");
  }
}

// The attempt row is written before the run answers terminal and its log
// envelope is patched in afterwards, so a single read can catch the row without
// one. The MCP half already waits for its own copy; this half waits for the
// same cell with the same budget rather than failing on the first miss.
async function readReplayDatabaseRows(
  sql: SqlClient,
  runId: string,
  deadline: number,
): Promise<{ observation: unknown; attempts: unknown[] }> {
  let observationSeen = false;
  let diagnostics: string[] = [];
  for (;;) {
    const observations = await sql`
      SELECT to_jsonb(observation) AS payload
      FROM workflow_run_observations observation
      WHERE observation.run_id = ${runId}
      LIMIT 1
    `;
    // The alias must not be `attempt`: `workflow_block_attempts` has a column of
    // that name, a bare name in an expression binds to the column before the
    // table alias, and `to_jsonb(attempt)` then returns the attempt NUMBER
    // instead of the row. That is why the database half of the evidence used to
    // fail while the explicit column below showed the envelope.
    const attempts = await sql`
      SELECT attempt_row.id AS id,
             to_jsonb(attempt_row) AS payload,
             attempt_row.log_envelope AS log_envelope,
             attempt_row.observation_revision AS observation_revision,
             attempt_row.updated_at AS updated_at
      FROM workflow_block_attempts attempt_row
      WHERE attempt_row.run_id = ${runId}
      ORDER BY attempt_row.id
    `;
    const observation = observations[0]?.payload;
    observationSeen = observation != null;
    diagnostics = attempts.map(
      (row) =>
        `attempt ${String(row.id)}: log_envelope=${row.log_envelope == null ? "null" : "present"} observation_revision=${String(row.observation_revision)} updated_at=${String(row.updated_at)}`,
    );
    if (
      observationSeen &&
      attempts.some((row) => row.log_envelope != null)
    ) {
      // The driver hands jsonb back parsed, but the contract reads keys off the
      // payload, so prove the shape here rather than assume it.
      const payloads = attempts.map((row) => parseJsonPayload(row.payload));
      console.log(
        `[replay-canary] database attempts: ${payloads.length}, payload types: ${payloads.map((payload) => (payload === null ? "null" : typeof payload)).join(", ")}`,
      );
      return { observation, attempts: payloads };
    }
    if (Date.now() >= deadline) break;
    await delay(2_000);
  }
  throw new Error(
    `Replay canary database capture never held a log envelope for ${runId}: observation row ${observationSeen ? "present" : "missing"}, ${diagnostics.length === 0 ? "no attempt rows" : diagnostics.join("; ")}`,
  );
}

function parseJsonPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// A finished run's registry claim is released only by the reconciler inside the
// production poll cron (services/run-lifecycle/reconcile.ts, every 15 minutes),
// and the canary target runs no cron of its own. The canary therefore releases
// the claims of its OWN runs, and only after it has proven them terminal, which
// is the same predicate the reconciler applies later.
async function releaseFinishedRunClaim(
  sql: SqlClient,
  ticketKey: string,
  runId: string,
): Promise<void> {
  await sql`
    DELETE FROM active_runs WHERE ticket_key = ${ticketKey} AND run_id = ${runId}
  `;
  const rows = await sql`
    SELECT run_id FROM active_runs WHERE ticket_key = ${ticketKey} LIMIT 1
  `;
  if (rows.length > 0) {
    throw new Error(
      `Run registry still holds ${ticketKey} for run ${String(rows[0]?.run_id)}`,
    );
  }
}

// A previous canary job that ended between a dispatch and its release (a timeout,
// a cancelled job) leaves a claim the next preflight refuses as already_claimed.
// Release it only when its run is terminal; a live run keeps its claim and the
// canary fails loudly instead of racing it.
async function releaseStaleCanaryClaim(
  sql: SqlClient,
  mcp: CanaryMcpClient,
  ticketKey: string,
): Promise<void> {
  const rows = await sql`
    SELECT run_id FROM active_runs WHERE ticket_key = ${ticketKey}
  `;
  for (const row of rows) {
    const runId = row.run_id as string | null;
    if (!runId) {
      throw new Error(`Run registry holds ${ticketKey} without a run id`);
    }
    const run = await mcp.call<RunData>("runs.get", { runId });
    if (!run.terminal) {
      throw new Error(`Run registry holds ${ticketKey} for live run ${runId}`);
    }
    await releaseFinishedRunClaim(sql, ticketKey, runId);
    console.log(
      `[harness-canary] released the stale claim of terminal run ${runId} on ${ticketKey}`,
    );
  }
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
              .slice(0, 300)
          : "";
        throw new Error(`MCP tool ${name} failed${detail ? `: ${detail}` : ""}`);
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
