import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "@shared/contracts";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { Db } from "../db/client.js";
import { member, organization, user } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { upsertWorkflowOwnedBranch } from "../db/queries/workflow-owned-branches.js";
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
import type { TriggerEvent } from "../lib/trigger-events.js";
import type { AgentWorkflowInput } from "../workflows/agent-input.js";
import { prReviewFixDefinition } from "./graph-fixtures.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  startWorkflow: vi.fn(),
  finalizeWorkspacePublication: vi.fn(),
  env: {
    DASHBOARD_ORG_SLUG: "ai-workflow",
    ENABLE_REVIEW_PHASE: true,
    AGENT_KIND: "claude",
    CLAUDE_MODEL: "claude-test-default",
    CODEX_MODEL: "gpt-5-codex",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
    ANTHROPIC_API_KEY: "sk-ant-test",
    CODEX_API_KEY: "sk-codex-test",
    GITHUB_APP_ID: 1,
    GITHUB_APP_PRIVATE_KEY: "private-key",
    GITHUB_INSTALLATION_ID: 2,
    GITLAB_TOKEN: "gitlab-token",
    CHAT_SDK_SLACK_TOKEN: "slack-token",
    CHAT_SDK_CHANNEL_ID: "channel",
  },
}));

vi.mock("../../env.js", () => ({ env: state.env }));
vi.mock("../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: state.sessionUserId },
        session: { id: "session_test" },
      })),
    },
  },
}));
vi.mock("workflow/api", () => ({
  start: (...args: unknown[]) => state.startWorkflow(...args),
}));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
vi.mock("../workflows/workspace-publication.js", () => ({
  finalizeWorkspacePublication: (...args: unknown[]) =>
    state.finalizeWorkspacePublication(...args),
}));

const detailPut = (await import("../routes/api/v1/workflow-definitions/[id].put.js")).default;
const detailValidate = (await import("../routes/api/v1/workflow-definitions/[id]/validate.post.js")).default;
const detailDeploy = (await import("../routes/api/v1/workflow-definitions/[id]/deploy.post.js")).default;
const detailRollback = (await import("../routes/api/v1/workflow-definitions/[id]/rollback.post.js")).default;
const { dispatchTriggerEvent } = await import("../lib/dispatch-trigger.js");
const { loadWorkflowDefinitionFor } = await import("../workflows/definition-step.js");
const { buildRuntimeGraph, executeGraph } = await import("./interpreter.js");
const { listWorkflowDefinitionVersionRows } = await import("./store.js");
const { execute: executeFinalizeWorkspace } = await import("../workflows/blocks/finalize-workspace.js");
const { makeCtx } = await import("../workflows/blocks/test-support.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paramHandler(method: "post" | "put", pattern: string, route: any) {
  const app = createApp();
  const router = createRouter();
  router[method](pattern, route);
  app.use(router);
  return toWebHandler(app);
}

function jsonRequest(method: string, body: unknown, url: string): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function withComment(definition: WorkflowDefinition, body: string): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.type === "post_pr_comment") {
        return { ...node, params: { ...node.params, body } };
      }
      if (node.type === "trigger_pr_checks_failed") {
        return {
          ...node,
          params: {
            ...node.params,
            checkNames: ["ci / build"],
            githubAppSlugs: ["github-actions"],
          },
        };
      }
      return node;
    }),
  };
}

function reviewEvent(deliveryId: string): TriggerEvent {
  return {
    delivery: { provider: "github", producer: "reviewer", deliveryId },
    triggerType: "trigger_pr_review",
    pr: {
      provider: "github",
      repoPath: "acme/app",
      prNumber: 103,
      prUrl: "https://github.com/acme/app/pull/103",
      headRef: "blazebot/aiw-103",
      headSha: "head-103",
      baseRef: "main",
      title: "Revise Workflows",
      author: "ai-workflow",
      isDraft: false,
      review: {
        state: "changes_requested",
        author: "reviewer",
        body: "Please handle the edge case.",
      },
    },
  };
}

describe("revised Workflows lifecycle", () => {
  let db: Db;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await createTestDb();
    state.db = db;
    state.startWorkflow.mockImplementation(async () => ({
      runId: `run-${state.startWorkflow.mock.calls.length}`,
    }));
    state.finalizeWorkspacePublication.mockResolvedValue({
      status: "finalized",
      attemptId: "publication-v1",
      repositories: [
        {
          provider: "github",
          repoPath: "acme/app",
          branchName: "blazebot/aiw-103",
          expectedHead: "head-103",
          pushedHead: "fixed-head-103",
        },
      ],
      prs: [],
    });
    await db.insert(organization).values({
      id: "org_aiw",
      name: "AI Workflow",
      slug: "ai-workflow",
    });
    await db.insert(user).values({
      id: "user_admin",
      name: "Admin",
      email: "admin@example.com",
      emailVerified: true,
    });
    await db.insert(member).values({
      id: "member_admin",
      organizationId: "org_aiw",
      userId: "user_admin",
      role: "admin",
    });
  });

  it("edits, validates, deploys, dispatches and executes the pinned remediation version before rollback", async () => {
    const put = paramHandler("put", "/d/:id", detailPut);
    const validate = paramHandler("post", "/d/:id/validate", detailValidate);
    const deploy = paramHandler("post", "/d/:id/deploy", detailDeploy);
    const rollback = paramHandler("post", "/d/:id/rollback", detailRollback);
    const versionOne = withComment(prReviewFixDefinition(), "Version one remediation complete.");
    const versionTwo = withComment(prReviewFixDefinition(), "Version two remediation complete.");

    const validated = await validate(
      jsonRequest("POST", { definition: versionOne }, "http://worker.test/d/1/validate"),
    );
    expect(validated.status).toBe(200);
    expect(await validated.json()).toMatchObject({ valid: true, issues: [] });

    const savedOne = await put(
      jsonRequest(
        "PUT",
        { definition: versionOne, expectedDraftRevision: 0 },
        "http://worker.test/d/1",
      ),
    );
    expect(savedOne.status).toBe(200);
    expect((await savedOne.json()).meta).toMatchObject({ draftRevision: 1, deployedVersion: null });

    const deployedOne = await deploy(
      jsonRequest(
        "POST",
        { expectedDraftRevision: 1, expectedDeployedVersion: null },
        "http://worker.test/d/1/deploy",
      ),
    );
    expect(deployedOne.status).toBe(200);
    expect((await deployedOne.json()).deployed.version).toBe(1);

    const savedTwo = await put(
      jsonRequest(
        "PUT",
        { definition: versionTwo, expectedDraftRevision: 1 },
        "http://worker.test/d/1",
      ),
    );
    expect(savedTwo.status).toBe(200);
    expect((await savedTwo.json()).meta).toMatchObject({ draftRevision: 2, deployedVersion: 1 });

    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-103",
      provider: "github",
      repoPath: "acme/app",
      branchName: "blazebot/aiw-103",
      publishedHeadSha: "head-103",
      pr: {
        id: 103,
        url: "https://github.com/acme/app/pull/103",
        branch: "blazebot/aiw-103",
      },
    });

    const runRegistry = new PostgresRunRegistry(db);
    const issueTracker: IssueTrackerAdapter = {
      fetchTicket: vi.fn(async () => ({
        id: "103",
        identifier: "AIW-103",
        title: "Verify revised Workflows",
        description: "Exercise the revised lifecycle.",
        acceptanceCriteria: "The immutable version pin survives draft edits and rollback.",
        comments: [],
        labels: [],
        trackerStatus: "In Progress",
        attachments: [],
      })),
      moveTicket: vi.fn(async () => {}),
      postComment: vi.fn(async () => null),
      searchTickets: vi.fn(async () => []),
    };
    const dispatched = await dispatchTriggerEvent(reviewEvent("review-v1"), {
      db,
      runRegistry,
      maxConcurrentAgents: 3,
      issueTracker,
      getCurrentHead: vi.fn(async () => "head-103"),
    });
    expect(dispatched).toEqual({ result: "started", runId: "run-1" });

    const firstRunInput = state.startWorkflow.mock.calls[0]![1] as AgentWorkflowInput[];
    const dispatchedEntry = firstRunInput[0]!;
    expect(dispatchedEntry).toMatchObject({
      subjectKey: "ticket:jira:AIW-103",
      definitionId: 1,
      definitionVersion: 1,
    });
    expect(dispatchedEntry.kind).toBe("pr_trigger");
    if (dispatchedEntry.kind !== "pr_trigger") throw new Error("expected PR trigger dispatch");

    const pinnedPlan = await loadWorkflowDefinitionFor(
      "trigger_pr_review",
      dispatchedEntry.definitionId,
      dispatchedEntry.definitionVersion,
    );
    expect(pinnedPlan).not.toBeNull();
    const calls: string[] = [];
    const engineContext = makeCtx({
      runId: "run-1",
      definitionId: 1,
      definitionVersion: 1,
      definitionNodes: pinnedPlan!.nodes,
      entry: dispatchedEntry,
      ticket: await issueTracker.fetchTicket("AIW-103"),
      branchName: "blazebot/aiw-103",
      sandboxId: "sandbox-103",
      workspaceManifest: {
        version: 1,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/app",
            slug: "acme__app",
            localPath: "/vercel/sandbox",
            defaultBranch: "main",
            branchName: "blazebot/aiw-103",
            selectedRationale: "workflow-owned remediation target",
            expectedRemoteSha: "head-103",
            preAgentSha: "head-103",
          },
        ],
      },
      selectedRepositories: [
        {
          provider: "github",
          repoPath: "acme/app",
          defaultBranch: "main",
          selectedRationale: "workflow-owned remediation target",
        },
      ],
    });
    const execution = await executeGraph({
      graph: buildRuntimeGraph(pinnedPlan!),
      entryTriggerId: "trigger-review",
      triggerOutput: { status: "fired", review: reviewEvent("unused").pr.review! },
      executeBlock: async (block, steps, resolvedInputs) => {
        calls.push(block.id);
        if (block.type === "fetch_pr_context") {
          return { kind: "next", output: { status: "ok", headSha: "head-103" } };
        }
        if (block.type === "fix_agent") {
          return { kind: "next", output: { status: "fixed" } };
        }
        if (block.type === "finalize_workspace") {
          return executeFinalizeWorkspace(block, steps, engineContext, resolvedInputs);
        }
        return {
          kind: "next",
          output: { status: "ok", body: block.params.body },
        };
      },
      hooks: {
        onBlockStart: async () => {},
        onBlockFinish: async () => {},
        clarificationExit: async () => {},
        failureExit: async () => {},
        terminate: async () => {},
      },
    });
    expect(execution.outcome).toBe("completed");
    expect(calls).toEqual(["fetch-context", "fix", "finalize", "comment"]);
    expect(state.finalizeWorkspacePublication).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        blockId: "finalize",
        sandboxId: "sandbox-103",
        ticketKey: "AIW-103",
        sourcePullRequest: {
          provider: "github",
          repoPath: "acme/app",
          prId: 103,
          headSha: "head-103",
        },
      }),
    );
    expect(execution.steps.comment.output).toMatchObject({
      body: "Version one remediation complete.",
    });

    const deployedTwo = await deploy(
      jsonRequest(
        "POST",
        { expectedDraftRevision: 2, expectedDeployedVersion: 1 },
        "http://worker.test/d/1/deploy",
      ),
    );
    expect(deployedTwo.status).toBe(200);
    expect((await deployedTwo.json()).deployed.version).toBe(2);

    const rolledBack = await rollback(
      jsonRequest(
        "POST",
        { version: 1, expectedDeployedVersion: 2 },
        "http://worker.test/d/1/rollback",
      ),
    );
    expect(rolledBack.status).toBe(200);
    expect(await rolledBack.json()).toMatchObject({
      meta: { deployedVersion: 1 },
      deployed: { version: 1 },
      deployment: {
        action: "rollback",
        selectedVersion: 1,
        previousVersion: 2,
        rollbackFromVersion: 2,
      },
    });
    const immutableVersions = await listWorkflowDefinitionVersionRows(db, 1);
    expect(immutableVersions.map((row) => row.version)).toEqual([2, 1]);
    expect(
      immutableVersions.map((row) =>
        row.definition.nodes.find((node) => node.type === "post_pr_comment")?.params.body,
      ),
    ).toEqual(["Version two remediation complete.", "Version one remediation complete."]);

    expect(
      await runRegistry.releaseReservation(
        dispatchedEntry.subjectKey,
        dispatchedEntry.ownerToken,
      ),
    ).toBe(true);
    expect(
      await dispatchTriggerEvent(reviewEvent("review-after-rollback"), {
        db,
        runRegistry,
        maxConcurrentAgents: 3,
        issueTracker,
        getCurrentHead: vi.fn(async () => "head-103"),
      }),
    ).toEqual({ result: "started", runId: "run-2" });
    expect(state.startWorkflow.mock.calls[1]![1][0]).toMatchObject({
      definitionId: 1,
      definitionVersion: 1,
    });
  });
});
