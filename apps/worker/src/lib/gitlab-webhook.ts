import { timingSafeEqual } from "node:crypto";
import type { PostPrGateWorkflowInput } from "../workflows/post-pr-gate.js";

interface GitLabUser {
  username?: string;
  name?: string;
}

export interface GitLabProject {
  id?: number | string;
  path_with_namespace?: string;
}

interface GitLabMergeRequestAttributes {
  iid?: number;
  action?: string;
  source_branch?: string;
  target_branch?: string;
  title?: string;
  description?: string | null;
  url?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  last_commit?: {
    id?: string;
  };
}

interface GitLabMergeRequestPayload {
  object_kind?: string;
  user?: GitLabUser;
  project?: GitLabProject;
  object_attributes?: GitLabMergeRequestAttributes;
}

export interface NormalizedGitLabMergeRequestEvent {
  action: string;
  workflowInput: PostPrGateWorkflowInput;
}

export function verifyGitLabWebhookToken(
  received: string | undefined,
  expected: string,
): void {
  if (!received) {
    throw new Error("Missing X-Gitlab-Token header");
  }

  const receivedToken = Buffer.from(received);
  const expectedToken = Buffer.from(expected);
  if (
    receivedToken.length !== expectedToken.length ||
    !timingSafeEqual(receivedToken, expectedToken)
  ) {
    throw new Error("Invalid GitLab webhook token");
  }
}

export function normalizeGitLabMergeRequestEvent(
  payload: GitLabMergeRequestPayload,
): NormalizedGitLabMergeRequestEvent {
  if (payload?.object_kind !== "merge_request") {
    throw new Error("Not a GitLab merge request payload");
  }

  const attrs = payload.object_attributes;
  if (!attrs) {
    throw new Error("Malformed GitLab merge request payload: missing object_attributes");
  }

  const project = payload.project;
  if (!project) {
    throw new Error("Malformed GitLab merge request payload: missing project");
  }

  const prNumber = attrs.iid;
  const headSha = attrs.last_commit?.id;
  const headRef = attrs.source_branch;
  const baseRef = attrs.target_branch;
  const title = attrs.title;
  const url = attrs.url;
  const ownerRepo = project.path_with_namespace ?? stringId(project.id);

  if (typeof prNumber !== "number") {
    throw new Error("Malformed GitLab merge request payload: missing iid");
  }
  if (!attrs.action) {
    throw new Error("Malformed GitLab merge request payload: missing action");
  }
  if (!headSha) {
    throw new Error("Malformed GitLab merge request payload: missing last_commit.id");
  }
  if (!headRef) {
    throw new Error("Malformed GitLab merge request payload: missing source_branch");
  }
  if (!baseRef) {
    throw new Error("Malformed GitLab merge request payload: missing target_branch");
  }
  if (!title) {
    throw new Error("Malformed GitLab merge request payload: missing title");
  }
  if (!url) {
    throw new Error("Malformed GitLab merge request payload: missing url");
  }
  if (!ownerRepo) {
    throw new Error("Malformed GitLab merge request payload: missing project identifier");
  }

  return {
    action: mapGitLabAction(attrs.action),
    workflowInput: {
      prNumber,
      headSha,
      headRef,
      baseRef,
      title,
      body: attrs.description ?? "",
      author: payload.user?.username ?? payload.user?.name ?? "unknown",
      isDraft: isDraftMergeRequest(attrs),
      url,
      ownerRepo,
      provider: "gitlab",
    },
  };
}

export function projectMatchesConfiguredId(
  project: GitLabProject | undefined,
  configured: string,
): boolean {
  if (!project) return false;
  return stringId(project.id) === configured || project.path_with_namespace === configured;
}

function mapGitLabAction(action: string): string {
  if (action === "open") return "opened";
  if (action === "reopen") return "reopened";
  return action;
}

function isDraftMergeRequest(attrs: GitLabMergeRequestAttributes): boolean {
  return (
    attrs.draft === true ||
    attrs.work_in_progress === true ||
    /^(draft|wip):/i.test(attrs.title ?? "")
  );
}

function stringId(id: number | string | undefined): string | undefined {
  return id === undefined ? undefined : String(id);
}
