import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import {
  fixAndRetryWorkspacePush,
  pushWorkspaceFromSandbox,
  type WorkspacePushResult,
} from "../sandbox/poll-agent.js";
import {
  createOrUseWorkflowOwnedPullRequestsForRepos,
  type WorkflowPrLink,
} from "./repository-prs.js";

export type WorkspacePublicationResult =
  | {
      status: "published";
      pushResult: WorkspacePushResult;
      prs: WorkflowPrLink[];
    }
  | {
      status: "failed";
      reason: string;
      pushResult: WorkspacePushResult;
      prs: WorkflowPrLink[];
    };

export async function publishWorkspaceChanges(input: {
  sandboxId: string;
  ticketKey: string;
  branchName: string;
  repositories: SelectedRepository[];
  title: string;
  agentKind: "claude" | "codex";
  model: string;
  beforeCreatePullRequests?: () => Promise<void>;
}): Promise<WorkspacePublicationResult> {
  let pushResult = await pushWorkspaceFromSandbox(input.sandboxId);
  if (hasPushFailures(pushResult)) {
    pushResult = await fixAndRetryWorkspacePush(
      input.sandboxId,
      pushResult,
      input.agentKind,
      input.model,
    );
  }

  const pushedRepositories = repositoriesMatchingPushResults(
    input.repositories,
    pushResult,
  );
  const prs = pushedRepositories.length > 0
    ? await createPullRequestsForPushedRepositories(input, pushedRepositories)
    : [];

  if (!pushResult.pushed) {
    return {
      status: "failed",
      reason: pushResult.error ?? "workspace push failed",
      pushResult,
      prs,
    };
  }

  if (prs.length === 0) {
    return {
      status: "failed",
      reason: "push completed, but no changed repository produced a pull request",
      pushResult,
      prs,
    };
  }

  return { status: "published", pushResult, prs };
}

function hasPushFailures(pushResult: WorkspacePushResult): boolean {
  return pushResult.repositories.some((repo) => repo.changed && !repo.pushed);
}

function repositoriesMatchingPushResults(
  repositories: SelectedRepository[],
  pushResult: WorkspacePushResult,
): SelectedRepository[] {
  return repositories.filter((repo) =>
    pushResult.repositories.some((result) =>
      result.provider === repo.provider &&
      result.repoPath === repo.repoPath &&
      result.changed &&
      result.pushed,
    ),
  );
}

async function createPullRequestsForPushedRepositories(
  input: {
    ticketKey: string;
    branchName: string;
    title: string;
    beforeCreatePullRequests?: () => Promise<void>;
  },
  repositories: SelectedRepository[],
): Promise<WorkflowPrLink[]> {
  await input.beforeCreatePullRequests?.();
  return createOrUseWorkflowOwnedPullRequestsForRepos({
    ticketKey: input.ticketKey,
    branchName: input.branchName,
    repositories,
    title: input.title,
  });
}
