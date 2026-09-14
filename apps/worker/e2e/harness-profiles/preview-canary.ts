import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
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
  REPLAY_CANARY_FIXTURE_NONCE,
  type ReplayCanaryEnv,
  type ReplayCanaryFixture,
} from "../replay/canary-contract.js";

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
  logCapture: ReplayLogCapture;
}

interface ReplayLogCapture {
  path: string;
  startOffset: number;
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

    const replayLogCapture = replayEnv
      ? await prepareReplayLogCapture(replayEnv)
      : null;
    const replayFixture = replayEnv
      ? createReplayCanaryFixture(REPLAY_CANARY_FIXTURE_NONCE)
      : null;

    for (const canary of cases) {
      const replay =
        canary.label === "custom" &&
        replayEnv &&
        replayLogCapture &&
        replayFixture
          ? {
              env: replayEnv,
              fixture: replayFixture,
              logCapture: replayLogCapture,
            }
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
  const dispatched = await mcp.call<DispatchData>("workflows.dispatch", {
    ...input,
    expectedDeployedVersion: preflight.deployedVersion,
    preflightDigest: preflight.preflightDigest,
    idempotencyKey: randomUUID(),
  });
  const deadline = Date.now() + env.HARNESS_CANARY_TIMEOUT_MS;
  try {
    await waitForSuccessfulRun(mcp, dispatched.runId, deadline);
    const manifests = await waitForHarnessManifest(mcp, dispatched.runId, deadline);
    if (replay) {
      await verifyReplayCase(replay, mcp, sql, dispatched.runId, deadline);
    }
    await waitForRegistryRelease(sql, env.HARNESS_CANARY_TICKET_KEY, 120_000);
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
): Promise<void> {
  const { summary, details } = await waitForReplayMcp(mcp, runId, deadline);
  const [databaseRows, appendedLogExport] = await Promise.all([
    readReplayDatabaseRows(sql, runId),
    waitForReplayLogExport(replay.env, replay.logCapture, runId),
  ]);
  assertReplayCanaryEvidence(
    {
      runId,
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

async function prepareReplayLogCapture(
  env: ReplayCanaryEnv,
): Promise<ReplayLogCapture> {
  const metadata = await stat(env.REPLAY_CANARY_LOG_EXPORT_PATH).catch(
    () => null,
  );
  if (!metadata?.isFile()) {
    throw new Error(
      "Replay canary log export must exist as a regular file before dispatch",
    );
  }
  return {
    path: env.REPLAY_CANARY_LOG_EXPORT_PATH,
    startOffset: metadata.size,
  };
}

async function readReplayDatabaseRows(
  sql: SqlClient,
  runId: string,
): Promise<{ observation: unknown; attempts: unknown[] }> {
  const observations = await sql`
    SELECT to_jsonb(observation) AS payload
    FROM workflow_run_observations observation
    WHERE observation.run_id = ${runId}
    LIMIT 1
  `;
  const attempts = await sql`
    SELECT to_jsonb(attempt) AS payload
    FROM workflow_block_attempts attempt
    WHERE attempt.run_id = ${runId}
    ORDER BY attempt.id
  `;
  if (!observations[0]?.payload || attempts.length === 0) {
    throw new Error("Replay canary database capture is incomplete");
  }
  return {
    observation: observations[0].payload,
    attempts: attempts.map((row) => row.payload),
  };
}

async function waitForRegistryRelease(
  sql: SqlClient,
  ticketKey: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql`
      SELECT 1 FROM active_runs WHERE ticket_key = ${ticketKey} LIMIT 1
    `;
    if (rows.length === 0) return;
    await delay(2_000);
  }
  throw new Error(`Run registry did not release ${ticketKey}`);
}

async function waitForReplayLogExport(
  env: ReplayCanaryEnv,
  capture: ReplayLogCapture,
  runId: string,
): Promise<string> {
  const deadline = Date.now() + env.REPLAY_CANARY_LOG_WAIT_MS;
  let lastSize = -1;
  let unchangedSince = 0;
  let latest = "";
  while (Date.now() < deadline) {
    const current = await stat(capture.path).catch(() => null);
    if (!current?.isFile() || current.size < capture.startOffset) {
      throw new Error("Replay canary log export was removed or truncated");
    }
    const appendedBytes = current.size - capture.startOffset;
    if (appendedBytes > env.REPLAY_CANARY_LOG_MAX_BYTES) {
      throw new Error("Replay canary log export exceeds its bounded scan limit");
    }
    if (current.size !== lastSize) {
      latest = await readLogRange(
        capture.path,
        capture.startOffset,
        appendedBytes,
      );
      lastSize = current.size;
      unchangedSince = Date.now();
    }
    if (
      latest.includes(runId) &&
      unchangedSince > 0 &&
      Date.now() - unchangedSince >= env.REPLAY_CANARY_LOG_SETTLE_MS
    ) {
      return latest;
    }
    await delay(2_000);
  }
  throw new Error(
    "Replay canary log export did not cover and settle after the canary run",
  );
}

async function readLogRange(
  path: string,
  startOffset: number,
  byteLength: number,
): Promise<string> {
  if (byteLength === 0) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(byteLength);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        startOffset + offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, offset),
    );
  } catch {
    throw new Error("Replay canary log export is not valid UTF-8");
  } finally {
    await handle.close();
  }
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
