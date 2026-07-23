import type {
  ManualDispatchInput,
  ManualDispatchPreflightStep,
} from "@shared/contracts";
import { isTriggerBlockType } from "@shared/contracts";
import { eq } from "drizzle-orm";
import { env, getConfiguredVcsProviders, getVcsBotLogin } from "../../env.js";
import {
  IssueTrackerNotFoundError,
  type IssueTrackerAdapter,
} from "../adapters/issue-tracker/types.js";
import {
  hasManualDispatchPrCapability,
  type ManualDispatchPullRequestSnapshot,
} from "../adapters/vcs/types.js";
import type { Db } from "../db/client.js";
import { workflowDefinitions } from "../db/schema.js";
import { findWorkflowOwnedPullRequest } from "../db/queries/workflow-owned-branches.js";
import {
  isConfiguredTriggerRepository,
  selectEligibleEvent,
  triggerNodeParams,
} from "../lib/dispatch-trigger.js";
import { isRepoAllowed } from "../lib/repo-allowlist.js";
import { prSubjectKey, ticketSubjectKey } from "../lib/subject-key.js";
import type { TriggerEvent } from "../lib/trigger-events.js";
import { isGateCheckName } from "../lib/trigger-events.js";
import { createRepositoryVCS } from "../lib/vcs-runtime.js";
import { loadPostPrGateConfig } from "../post-pr-gate/config.js";
import {
  getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinitionVersion,
  type WorkflowDefinitionVersionRow,
} from "../workflow-definition/store.js";
import type { PrTriggerPayload } from "../workflows/agent-input.js";
import { hasDispatchBlockingApprovalForTicket } from "../approvals/store.js";
import { ManualDispatchError } from "./errors.js";

type PrTriggerType =
  | "trigger_pr_created"
  | "trigger_pr_checks_failed"
  | "trigger_pr_review"
  | "trigger_pr_merged";
type RunnableTriggerType = "trigger_ticket_ai" | PrTriggerType;

export type ResolvedManualDispatch =
  | {
      definitionId: number;
      definitionName: string;
      definitionVersion: number;
      triggerNodeId: string;
      triggerType: "trigger_ticket_ai";
      input: Extract<ManualDispatchInput, { kind: "ticket" }>;
      inputKind: "ticket";
      inputPayload: { kind: "ticket"; ticketKey: string };
      subjectKey: string;
      ticketKey: string;
      subjectTitle: string;
      subjectUrl?: string;
      currentStatus: string;
      steps: ManualDispatchPreflightStep[];
    }
  | {
      definitionId: number;
      definitionName: string;
      definitionVersion: number;
      triggerNodeId: string;
      triggerType: Exclude<RunnableTriggerType, "trigger_ticket_ai">;
      input: Extract<ManualDispatchInput, { kind: "pull_request" }>;
      inputKind: "pull_request";
      inputPayload: {
        kind: "pull_request";
        scope: "workflow_owned" | "any";
        pr: PrTriggerPayload;
      };
      subjectKey: string;
      ticketKey: string | null;
      subjectTitle: string;
      subjectUrl: string;
      steps: ManualDispatchPreflightStep[];
    };

export async function resolveManualDispatch(input: {
  db: Db;
  issueTracker: IssueTrackerAdapter;
  definitionId: number;
  triggerNodeId: string;
  dispatchInput: ManualDispatchInput;
  /** Resolve an already-accepted request against its immutable pinned graph. */
  definitionVersion?: number;
}): Promise<ResolvedManualDispatch> {
  const deployed = await loadDeployedTrigger(
    input.db,
    input.definitionId,
    input.triggerNodeId,
    input.definitionVersion,
  );
  if (deployed.triggerType === "trigger_ticket_ai") {
    if (input.dispatchInput.kind !== "ticket") {
      throw new ManualDispatchError(422, "invalid_input", "This trigger requires a Jira ticket key.");
    }
    return resolveTicketDispatch(
      { ...input, dispatchInput: input.dispatchInput },
      { ...deployed, triggerType: deployed.triggerType },
    );
  }
  if (input.dispatchInput.kind !== "pull_request") {
    throw new ManualDispatchError(422, "invalid_input", "This trigger requires a pull or merge request URL.");
  }
  return resolvePullRequestDispatch(
    { ...input, dispatchInput: input.dispatchInput },
    { ...deployed, triggerType: deployed.triggerType },
  );
}

async function loadDeployedTrigger(
  db: Db,
  definitionId: number,
  triggerNodeId: string,
  definitionVersion?: number,
): Promise<{
  definition: WorkflowDefinitionVersionRow;
  definitionName: string;
  triggerType: RunnableTriggerType;
}> {
  const deployed =
    definitionVersion === undefined
      ? await getDeployedWorkflowDefinitionVersion(db, definitionId)
      : await getWorkflowDefinitionVersion(db, definitionId, definitionVersion);
  if (!deployed) {
    throw new ManualDispatchError(422, "not_eligible", "This workflow has no deployed version.");
  }
  const node = deployed.definition.nodes.find((candidate) => candidate.id === triggerNodeId);
  if (
    !node ||
    !isTriggerBlockType(node.type) ||
    node.type === "trigger_plan_approved"
  ) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "This trigger is not present in the deployed workflow.",
    );
  }
  const rows = await db
    .select({ name: workflowDefinitions.name })
    .from(workflowDefinitions)
    .where(eq(workflowDefinitions.id, definitionId))
    .limit(1);
  if (!rows[0]) {
    throw new ManualDispatchError(404, "invalid_input", "Workflow definition not found.");
  }
  return {
    definition: deployed,
    definitionName: rows[0].name,
    triggerType: node.type as RunnableTriggerType,
  };
}

async function resolveTicketDispatch(
  input: {
    db: Db;
    issueTracker: IssueTrackerAdapter;
    definitionId: number;
    triggerNodeId: string;
    dispatchInput: Extract<ManualDispatchInput, { kind: "ticket" }>;
  },
  deployed: {
    definition: WorkflowDefinitionVersionRow;
    definitionName: string;
    triggerType: "trigger_ticket_ai";
  },
): Promise<Extract<ResolvedManualDispatch, { inputKind: "ticket" }>> {
  const ticketKey = normalizeTicketKey(input.dispatchInput.ticketKey);
  let ticket;
  try {
    ticket = await input.issueTracker.fetchTicket(ticketKey);
  } catch (error) {
    if (error instanceof IssueTrackerNotFoundError) {
      throw new ManualDispatchError(
        422,
        "invalid_input",
        `Ticket ${ticketKey} was not found.`,
      );
    }
    throw new ManualDispatchError(
      502,
      "provider_unavailable",
      "Jira could not be reached.",
    );
  }
  const expectedProject = env.JIRA_PROJECT_KEY.trim().toUpperCase();
  if (projectKey(ticket.identifier) !== expectedProject) {
    throw new ManualDispatchError(
      422,
      "invalid_input",
      `Ticket must belong to Jira project ${expectedProject}.`,
    );
  }
  if (await hasDispatchBlockingApprovalForTicket(input.db, ticketKey)) {
    throw new ManualDispatchError(
      409,
      "approval_pending",
      "This ticket has a pending or approved workflow plan.",
    );
  }
  const alreadyInAi =
    ticket.trackerStatus.trim().toLowerCase() === env.COLUMN_AI.trim().toLowerCase();
  return {
    definitionId: input.definitionId,
    definitionName: deployed.definitionName,
    definitionVersion: deployed.definition.version,
    triggerNodeId: input.triggerNodeId,
    triggerType: "trigger_ticket_ai",
    input: { kind: "ticket", ticketKey },
    inputKind: "ticket",
    inputPayload: { kind: "ticket", ticketKey },
    subjectKey: ticketSubjectKey("jira", ticketKey),
    ticketKey,
    subjectTitle: ticket.title,
    currentStatus: ticket.trackerStatus,
    steps: [
      {
        title: "Reserve ticket",
        description: "Prevent duplicate automatic or manual runs",
      },
      {
        title: alreadyInAi ? `Keep in ${env.COLUMN_AI}` : `Move ${ticket.trackerStatus} → ${env.COLUMN_AI}`,
        description: alreadyInAi
          ? "Ticket is already ready for execution"
          : "Jira changes before execution",
      },
      {
        title: `Start deployed v${deployed.definition.version}`,
        description: "Draft changes are excluded",
      },
    ],
  };
}

async function resolvePullRequestDispatch(
  input: {
    db: Db;
    issueTracker: IssueTrackerAdapter;
    definitionId: number;
    triggerNodeId: string;
    dispatchInput: Extract<ManualDispatchInput, { kind: "pull_request" }>;
  },
  deployed: {
    definition: WorkflowDefinitionVersionRow;
    definitionName: string;
    triggerType: Exclude<RunnableTriggerType, "trigger_ticket_ai">;
  },
): Promise<Extract<ResolvedManualDispatch, { inputKind: "pull_request" }>> {
  const parsed = parsePullRequestUrl(input.dispatchInput.url);
  const providerConfig = getConfiguredVcsProviders().find(
    (provider) => provider.kind === parsed.provider,
  );
  if (!providerConfig) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      `${parsed.provider === "github" ? "GitHub" : "GitLab"} is not configured.`,
    );
  }
  const vcs = createRepositoryVCS({
    provider: parsed.provider,
    repoPath: parsed.repoPath,
    baseBranch: providerConfig.legacyBaseBranch,
  });
  if (!hasManualDispatchPrCapability(vcs)) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "The configured provider cannot resolve manual dispatch input.",
    );
  }
  let snapshot: ManualDispatchPullRequestSnapshot;
  try {
    snapshot = await vcs.getManualDispatchPullRequest(parsed.prNumber);
  } catch {
    throw new ManualDispatchError(
      502,
      "provider_unavailable",
      "The pull request provider could not be reached.",
    );
  }
  const params = triggerNodeParams(
    deployed.definition.definition,
    deployed.triggerType,
  );
  const providers = Array.isArray(params.providers) ? params.providers : [];
  if (providers.length > 0 && !providers.includes(parsed.provider)) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "This deployed trigger does not allow that provider.",
    );
  }
  const scope = params.scope === "any" ? "any" : "workflow_owned";
  if (scope === "any" && !isRepoAllowed(parsed.repoPath)) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "This repository is outside the configured allowlist.",
    );
  }
  const pr = snapshotToPayload(parsed.provider, parsed.repoPath, snapshot);
  if (!(await isConfiguredTriggerRepository(pr))) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "This repository is not accessible to the configured provider.",
    );
  }
  const gateCheckNames = loadPostPrGateConfig().postPrGate.steps.map(
    (step) => `blazebot / ${step.name ?? step.uses}`,
  );
  const eligible = selectManualTriggerEvent(
    deployed.triggerType,
    pr,
    {
      ...snapshot,
      failedChecks: snapshot.failedChecks.filter(
        (check) => !isGateCheckName(check.name, gateCheckNames),
      ),
    },
    params,
  );
  if (!eligible) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "The pull request's current provider state does not match this trigger.",
    );
  }

  let subjectKey: string;
  let ticketKey: string | null = null;
  if (scope === "any") {
    subjectKey = prSubjectKey(pr.provider, pr.repoPath, pr.prNumber);
  } else {
    const owned = await findWorkflowOwnedPullRequest(input.db, {
      provider: pr.provider,
      repoPath: pr.repoPath,
      prNumber: pr.prNumber,
      branchName: pr.headRef,
      publishedHeadSha: pr.headSha,
      baseBranch: pr.baseRef,
    });
    if (!owned) {
      throw new ManualDispatchError(
        422,
        "not_eligible",
        "This trigger only accepts pull requests created by AI Workflow.",
      );
    }
    const ticket = await input.issueTracker.fetchTicket(owned.ticketKey).catch(() => null);
    if (!ticket) {
      throw new ManualDispatchError(
        502,
        "provider_unavailable",
        "The linked Jira ticket could not be verified.",
      );
    }
    ticketKey = ticket.identifier.trim().toUpperCase();
    if (await hasDispatchBlockingApprovalForTicket(input.db, ticketKey)) {
      throw new ManualDispatchError(
        409,
        "approval_pending",
        "The linked Jira ticket has a pending or approved workflow plan.",
      );
    }
    subjectKey = ticketSubjectKey("jira", ticketKey);
  }

  return {
    definitionId: input.definitionId,
    definitionName: deployed.definitionName,
    definitionVersion: deployed.definition.version,
    triggerNodeId: input.triggerNodeId,
    triggerType: deployed.triggerType,
    input: { kind: "pull_request", url: snapshot.prUrl },
    inputKind: "pull_request",
    inputPayload: { kind: "pull_request", scope, pr: eligible.pr },
    subjectKey,
    ticketKey,
    subjectTitle: snapshot.title || `${parsed.repoPath}#${parsed.prNumber}`,
    subjectUrl: snapshot.prUrl,
    steps: [
      {
        title: "Reserve pull request",
        description: "Prevent duplicate automatic or manual runs",
      },
      {
        title: "Verify current provider state",
        description: ticketKey
          ? `Linked ticket ${ticketKey} remains unchanged`
          : "No Jira status change",
      },
      {
        title: `Start deployed v${deployed.definition.version}`,
        description: "Draft changes are excluded",
      },
    ],
  };
}

export function selectManualTriggerEvent(
  triggerType: Exclude<RunnableTriggerType, "trigger_ticket_ai">,
  pr: PrTriggerPayload,
  snapshot: ManualDispatchPullRequestSnapshot,
  params: Record<string, unknown>,
): TriggerEvent | null {
  if (triggerType === "trigger_pr_created") {
    if (snapshot.state !== "open") return null;
    return baseEvent(triggerType, pr, "manual");
  }
  if (triggerType === "trigger_pr_merged") {
    if (snapshot.state !== "merged") return null;
    return baseEvent(triggerType, pr, "manual");
  }
  if (snapshot.state !== "open") return null;
  if (triggerType === "trigger_pr_review") {
    for (const review of [...snapshot.reviews].reverse()) {
      const event = {
        ...baseEvent(triggerType, { ...pr, review }, review.author),
        pr: { ...pr, review },
      };
      const eligible = selectEligibleEvent(event, params);
      if (eligible) return eligible;
    }
    return null;
  }

  if (pr.provider === "github") {
    const byProducer = new Map<string, NonNullable<PrTriggerPayload["failedChecks"]>>();
    for (const check of snapshot.failedChecks) {
      const producer = check.appSlug ?? "";
      if (!producer) continue;
      byProducer.set(producer, [...(byProducer.get(producer) ?? []), check]);
    }
    for (const [producer, failedChecks] of byProducer) {
      const eligible = selectEligibleEvent(
        baseEvent(triggerType, { ...pr, failedChecks }, producer),
        params,
      );
      if (eligible) return eligible;
    }
    return null;
  }
  return selectEligibleEvent(
    {
      ...baseEvent(triggerType, { ...pr, failedChecks: snapshot.failedChecks }, "gitlab-ci"),
      delivery: {
        provider: "gitlab",
        producer: "gitlab-ci",
        source: snapshot.pipelineSource ?? "merge_request_event",
        deliveryId: "manual",
      },
    },
    params,
  );
}

function baseEvent(
  triggerType: Exclude<RunnableTriggerType, "trigger_ticket_ai">,
  pr: PrTriggerPayload,
  producer: string,
): TriggerEvent {
  return {
    delivery: {
      provider: pr.provider,
      producer,
      deliveryId: "manual",
    },
    triggerType,
    pr,
  };
}

function snapshotToPayload(
  provider: "github" | "gitlab",
  repoPath: string,
  snapshot: ManualDispatchPullRequestSnapshot,
): PrTriggerPayload {
  return {
    provider,
    repoPath,
    prNumber: snapshot.prNumber,
    prUrl: snapshot.prUrl,
    headRef: snapshot.headRef,
    headSha: snapshot.headSha,
    baseRef: snapshot.baseRef,
    title: snapshot.title,
    author: snapshot.author,
    isDraft: snapshot.isDraft,
    ...(snapshot.mergeSha ? { mergeSha: snapshot.mergeSha } : {}),
    ...(snapshot.mergedAt ? { mergedAt: snapshot.mergedAt } : {}),
    ...(snapshot.pipelineId !== undefined ? { pipelineId: snapshot.pipelineId } : {}),
    ...(snapshot.failedChecks.length > 0
      ? { failedChecks: snapshot.failedChecks }
      : {}),
  };
}

export function parsePullRequestUrl(urlText: string): {
  provider: "github" | "gitlab";
  repoPath: string;
  prNumber: number;
} {
  let url: URL;
  try {
    url = new URL(urlText.trim());
  } catch {
    throw new ManualDispatchError(422, "invalid_input", "Enter a valid pull or merge request URL.");
  }
  const provider = getConfiguredVcsProviders().find(
    (candidate) => new URL(candidate.host).host.toLowerCase() === url.host.toLowerCase(),
  );
  if (!provider) {
    throw new ManualDispatchError(
      422,
      "invalid_input",
      "The URL does not match a configured GitHub or GitLab host.",
    );
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (provider.kind === "github") {
    if (segments.length !== 4 || segments[2] !== "pull") {
      throw new ManualDispatchError(422, "invalid_input", "Enter a GitHub pull request URL.");
    }
    return {
      provider: "github",
      repoPath: `${segments[0]}/${segments[1]}`,
      prNumber: positiveInteger(segments[3]),
    };
  }
  const marker = segments.findIndex(
    (segment, index) => segment === "-" && segments[index + 1] === "merge_requests",
  );
  if (marker < 1 || marker + 2 >= segments.length) {
    throw new ManualDispatchError(422, "invalid_input", "Enter a GitLab merge request URL.");
  }
  return {
    provider: "gitlab",
    repoPath: segments.slice(0, marker).join("/"),
    prNumber: positiveInteger(segments[marker + 2]),
  };
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ManualDispatchError(422, "invalid_input", "Pull request number is invalid.");
  }
  return parsed;
}

function normalizeTicketKey(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(normalized)) {
    throw new ManualDispatchError(422, "invalid_input", "Enter a valid Jira ticket key.");
  }
  return normalized;
}

function projectKey(identifier: string): string | null {
  const dash = identifier.indexOf("-");
  return dash > 0 ? identifier.slice(0, dash).trim().toUpperCase() : null;
}
