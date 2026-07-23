import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";
import type {
  HarnessProfileDetailResponse,
  HarnessProfilesResponse,
  HarnessRunManifestRecord,
  RunDetailResponse,
  WorkflowDefinitionDetailResponse,
  WorkflowDefinitionMeta,
  WorkflowDefinitionsResponse,
} from "@shared/contracts";
import {
  assertCustomProfilePin,
  assertMinimalCanaryWorkflow,
  assertRunHarnessManifest,
  parseHarnessCanaryEnv,
  type HarnessCanaryEnv,
} from "./canary-contract.js";

type SqlClient = ReturnType<typeof neon>;

interface DurableRun {
  runId: string;
  status: string | null;
  definitionVersion: number | null;
  harnessManifests: HarnessRunManifestRecord[] | null;
}

interface CanaryCase {
  label: "claude" | "codex" | "custom";
  workflowId: number;
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

export async function runHarnessProfilePreviewCanary(
  source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const env = parseHarnessCanaryEnv(source);
  const sql = neon(env.DATABASE_URL);
  const api = createWorkerApi(env);

  const session = await api.get<{
    role: string;
    canEditWorkflows: boolean;
  }>("/api/v1/session");
  if (
    !session.canEditWorkflows ||
    (session.role !== "owner" && session.role !== "admin")
  ) {
    throw new Error("Canary session must belong to an owner or admin");
  }

  const [{ profiles }, definitions] = await Promise.all([
    api.get<HarnessProfilesResponse>("/api/v1/harness-profiles"),
    api.get<WorkflowDefinitionsResponse>("/api/v1/workflow-definitions"),
  ]);
  const claude = profiles.find((profile) => profile.id === "builtin-claude");
  const codex = profiles.find((profile) => profile.id === "builtin-codex");
  if (
    !claude?.system ||
    !claude.publishedVersion ||
    !codex?.system ||
    !codex.publishedVersion
  ) {
    throw new Error("Both stable built-in Harness Profiles must be published");
  }

  const custom = await api.get<HarnessProfileDetailResponse>(
    `/api/v1/harness-profiles/${encodeURIComponent(
      env.HARNESS_CANARY_CUSTOM_PROFILE_ID,
    )}?version=${env.HARNESS_CANARY_CUSTOM_PROFILE_VERSION}`,
  );
  assertCustomProfilePin(custom, {
    profileId: env.HARNESS_CANARY_CUSTOM_PROFILE_ID,
    version: env.HARNESS_CANARY_CUSTOM_PROFILE_VERSION,
    artifactHash: env.HARNESS_CANARY_CUSTOM_SKILL_ARTIFACT_HASH,
    skillName: env.HARNESS_CANARY_CUSTOM_SKILL_NAME,
  });
  const customProvider = custom.published!.manifest.harness.provider;

  await assertPinnedSkillExists(sql, env, custom.profile.organizationId);
  await assertNoActiveRuns(sql);

  const restore = findDefinition(
    definitions.definitions,
    env.HARNESS_CANARY_RESTORE_WORKFLOW_ID,
  );
  if (
    !restore.enabled ||
    !restore.triggerTypes.includes("trigger_ticket_ai")
  ) {
    throw new Error(
      "The exact restore workflow must currently own trigger_ticket_ai",
    );
  }
  const otherEnabledTicketDefinitions = definitions.definitions.filter(
    (definition) =>
      definition.id !== restore.id &&
      definition.enabled &&
      definition.triggerTypes.includes("trigger_ticket_ai"),
  );
  if (otherEnabledTicketDefinitions.length > 0) {
    throw new Error("More than one workflow claims trigger_ticket_ai");
  }

  const cases: CanaryCase[] = [
    {
      label: "claude",
      workflowId: env.HARNESS_CANARY_CLAUDE_WORKFLOW_ID,
      reference: {
        profileId: claude.id,
        version: claude.publishedVersion,
      },
      provider: "claude",
    },
    {
      label: "codex",
      workflowId: env.HARNESS_CANARY_CODEX_WORKFLOW_ID,
      reference: {
        profileId: codex.id,
        version: codex.publishedVersion,
      },
      provider: "codex",
    },
    {
      label: "custom",
      workflowId: env.HARNESS_CANARY_CUSTOM_WORKFLOW_ID,
      reference: {
        profileId: custom.profile.id,
        version: env.HARNESS_CANARY_CUSTOM_PROFILE_VERSION,
      },
      provider: customProvider,
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

  for (const canary of cases) {
    const meta = findDefinition(definitions.definitions, canary.workflowId);
    if (meta.enabled) {
      throw new Error(`Canary workflow ${canary.workflowId} must start disabled`);
    }
    const detail = await api.get<WorkflowDefinitionDetailResponse>(
      `/api/v1/workflow-definitions/${canary.workflowId}`,
    );
    assertMinimalCanaryWorkflow(detail, canary.reference);
  }

  let restoreDisabled = false;
  let activeCanary: number | null = null;
  try {
    await api.patch(`/api/v1/workflow-definitions/${restore.id}`, {
      enabled: false,
    });
    restoreDisabled = true;

    for (const canary of cases) {
      await api.patch(`/api/v1/workflow-definitions/${canary.workflowId}`, {
        enabled: true,
      });
      activeCanary = canary.workflowId;
      try {
        const run = await executeCase(env, api, sql, canary);
        assertRunHarnessManifest(run.harnessManifests, {
          reference: canary.reference,
          provider: canary.provider,
          ...(canary.skill ? { skill: canary.skill } : {}),
        });
        console.log(
          `[harness-canary] ${canary.label}: ${run.runId} succeeded with ${canary.reference.profileId}@${canary.reference.version}`,
        );
      } finally {
        await api.patch(
          `/api/v1/workflow-definitions/${canary.workflowId}`,
          { enabled: false },
        );
        activeCanary = null;
      }
    }
  } finally {
    if (activeCanary !== null) {
      await api
        .patch(`/api/v1/workflow-definitions/${activeCanary}`, {
          enabled: false,
        })
        .catch(() => undefined);
    }
    if (restoreDisabled) {
      await api.patch(`/api/v1/workflow-definitions/${restore.id}`, {
        enabled: true,
      });
    }
  }

  console.log(
    "[harness-canary] PASS: built-in Claude, built-in Codex, and the exact custom skill profile completed on the preview.",
  );
}

async function executeCase(
  env: HarnessCanaryEnv,
  api: ReturnType<typeof createWorkerApi>,
  sql: SqlClient,
  canary: CanaryCase,
): Promise<DurableRun> {
  const ticketKey = await createTicket(env, canary.label);
  try {
    await transitionTicket(env, ticketKey, env.COLUMN_AI);
    const deadline = Date.now() + env.HARNESS_CANARY_TIMEOUT_MS;
    let run: DurableRun | null = null;
    while (Date.now() < deadline) {
      await callCron(env);
      run = await findDurableRun(sql, ticketKey, canary.workflowId);
      if (run) {
        const detail = await api.get<RunDetailResponse>(
          `/api/v1/runs/${encodeURIComponent(run.runId)}`,
        );
        if (detail.run?.status === "success") {
          const captured = await waitForHarnessManifest(
            sql,
            run.runId,
            deadline,
          );
          if (captured.definitionVersion === null) {
            throw new Error(`Run ${run.runId} did not pin a definition version`);
          }
          return captured;
        }
        if (
          detail.run &&
          ["failed", "blocked", "awaiting"].includes(detail.run.status)
        ) {
          throw new Error(
            `${canary.label} canary run ${run.runId} ended as ${detail.run.status}`,
          );
        }
      }
      await delay(5_000);
    }
    throw new Error(
      `Timed out waiting for ${canary.label} canary workflow ${canary.workflowId}`,
    );
  } finally {
    await transitionTicket(env, ticketKey, env.COLUMN_BACKLOG).catch(
      () => undefined,
    );
    await waitForRegistryRelease(sql, ticketKey, 120_000).catch(
      () => undefined,
    );
    await deleteTicket(env, ticketKey).catch(() => undefined);
  }
}

function createWorkerApi(env: HarnessCanaryEnv) {
  const base = env.HARNESS_CANARY_BASE_URL.replace(/\/+$/, "");
  const request = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.HARNESS_CANARY_SESSION_TOKEN}`,
        "Content-Type": "application/json",
        "x-vercel-protection-bypass":
          env.VERCEL_AUTOMATION_BYPASS_SECRET,
        ...init.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Preview API ${init.method ?? "GET"} ${path} failed: ${
          response.status
        } ${text.slice(0, 500)}`,
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  };
  return {
    get: <T>(path: string) => request<T>(path),
    patch: (path: string, body: unknown) =>
      request<WorkflowDefinitionMeta>(path, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  };
}

function findDefinition(
  definitions: WorkflowDefinitionMeta[],
  id: number,
): WorkflowDefinitionMeta {
  const definition = definitions.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Workflow ${id} is not available`);
  return definition;
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

async function assertNoActiveRuns(sql: SqlClient): Promise<void> {
  const rows = await sql`SELECT count(*)::int AS count FROM active_runs`;
  if (Number(rows[0]?.count ?? 0) !== 0) {
    throw new Error("Preview has active runs; retry the canary when it is idle");
  }
}

async function findDurableRun(
  sql: SqlClient,
  ticketKey: string,
  definitionId: number,
): Promise<DurableRun | null> {
  const rows = await sql`
    SELECT run_id, status, definition_version, harness_manifests
    FROM workflow_runs
    WHERE ticket_key = ${ticketKey}
      AND definition_id = ${definitionId}
    ORDER BY first_seen_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        runId: String(row.run_id),
        status: typeof row.status === "string" ? row.status : null,
        definitionVersion:
          typeof row.definition_version === "number"
            ? row.definition_version
            : null,
        harnessManifests:
          (row.harness_manifests as HarnessRunManifestRecord[] | null) ?? null,
      }
    : null;
}

async function waitForHarnessManifest(
  sql: SqlClient,
  runId: string,
  deadline: number,
): Promise<DurableRun> {
  while (Date.now() < deadline) {
    const rows = await sql`
      SELECT run_id, status, definition_version, harness_manifests
      FROM workflow_runs
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row?.harness_manifests) {
      return {
        runId,
        status: typeof row.status === "string" ? row.status : null,
        definitionVersion:
          typeof row.definition_version === "number"
            ? row.definition_version
            : null,
        harnessManifests:
          row.harness_manifests as HarnessRunManifestRecord[],
      };
    }
    await delay(2_000);
  }
  throw new Error(`Run ${runId} did not persist its Harness Profile manifest`);
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

let cloudId: string | null = null;

async function jiraRequest<T>(
  env: HarnessCanaryEnv,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!cloudId) {
    const tenant = new URL(env.JIRA_BASE_URL).origin;
    const response = await fetch(`${tenant}/_edge/tenant_info`);
    if (!response.ok) throw new Error("Jira cloud ID discovery failed");
    cloudId = String(((await response.json()) as { cloudId?: string }).cloudId);
  }
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${cloudId}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${env.JIRA_API_TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Jira ${init.method ?? "GET"} ${path} failed: ${response.status}`);
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

async function createTicket(
  env: HarnessCanaryEnv,
  label: string,
): Promise<string> {
  const result = await jiraRequest<{ key: string }>(
    env,
    "/rest/api/3/issue",
    {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: env.JIRA_PROJECT_KEY },
          summary: `[E2E] Harness Profile preview canary: ${label}`,
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Return the deployed canary workflow's structured success response. Do not modify repositories or external systems.",
                  },
                ],
              },
            ],
          },
          issuetype: { name: "Task" },
        },
      }),
    },
  );
  return result.key;
}

async function transitionTicket(
  env: HarnessCanaryEnv,
  ticketKey: string,
  column: string,
): Promise<void> {
  const result = await jiraRequest<{
    transitions: Array<{ id: string; name: string }>;
  }>(env, `/rest/api/3/issue/${ticketKey}/transitions`);
  const transition = result.transitions.find(
    (candidate) => candidate.name.toLowerCase() === column.toLowerCase(),
  );
  if (!transition) throw new Error(`No Jira transition to ${column}`);
  await jiraRequest(
    env,
    `/rest/api/3/issue/${ticketKey}/transitions`,
    {
      method: "POST",
      body: JSON.stringify({ transition: { id: transition.id } }),
    },
  );
}

async function deleteTicket(
  env: HarnessCanaryEnv,
  ticketKey: string,
): Promise<void> {
  await jiraRequest(env, `/rest/api/3/issue/${ticketKey}`, {
    method: "DELETE",
  });
}

async function callCron(env: HarnessCanaryEnv): Promise<void> {
  const response = await fetch(
    `${env.HARNESS_CANARY_BASE_URL.replace(/\/+$/, "")}/cron/poll`,
    {
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
        "x-vercel-protection-bypass":
          env.VERCEL_AUTOMATION_BYPASS_SECRET,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Preview cron failed: ${response.status}`);
  }
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
