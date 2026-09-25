import type {
  ManualDispatchInput,
  ManualDispatchPreflightStep,
  ManuallyDispatchableTrigger,
  SettingsSnapshot,
  WorkflowBlockType,
} from "@shared/contracts";
import {
  isManuallyDispatchableTrigger,
  RETIRED_SCHEMA_MESSAGE,
} from "@shared/contracts";
import { IssueTrackerNotFoundError } from "../../adapters/issue-tracker/types.js";
import { isPullRequestUnreadableError } from "@integrations/sdk";
import { isRepositoryWithinPinnedScope } from "../../adapters/vcs/repository-directory.js";
import {
  ManualDispatchUnsupportedError,
  type ManualDispatchPullRequestSnapshot,
} from "../../adapters/vcs/types.js";
import type { Db } from "../../db/types.js";
import { findWorkflowOwnedPullRequest } from "../../db/repositories/runs.js";
import { findConnectedWorkflowOwnedPullRequest } from "../../db/repositories/runs.js";
import {
  isRepositoryDispatchable,
  REPOSITORY_NOT_IN_CATALOG_REASON,
  selectEligibleEvent,
  triggerNodeParams,
  TriggerEvent,
} from "../dispatch/index.js";
import type { RepositoryCatalogSnapshot } from "../repository-catalog/index.js";
import { prSubjectKey } from "../../engine/support/subject-key.js";
import { isManagedGateCheckName } from "../../engine/support/workflow-naming.js";
import { isSameRepository } from "../../engine/support/repository-access.js";
import {
  issueTrackerWiring,
  ticketSubject,
  type ResolvedIssueTracker,
} from "../../engine/support/issue-tracker-runtime.js";
import {
  createManualDispatchPrReader,
  resolveConfiguredPullRequestUrl,
} from "../../engine/support/vcs-runtime.js";
import { loadSettingsSnapshot, loadSettingsSnapshotOn } from "../settings/index.js";
import {
  getWorkflowDefinitionName,
  runnableDefinitionOf,
  type WorkflowDefinitionVersionRow,
} from "../../db/repositories/definitions.js";
import {
  getConnectedWorkflowDefinitionName,
} from "../../db/repositories/definitions/connected.js";
import type { PrTriggerPayload } from "../../engine/index.js";
import { hasDispatchBlockingApprovalForTicket } from "../../db/repositories/approvals.js";
import { hasConnectedDispatchBlockingApprovalForTicket } from "../../db/repositories/approvals.js";
import {
  issueTrackerForDispatch,
  ManualDispatchError,
  settingsUnreadableForDispatch,
} from "./errors.js";
import { IntegrationSettingsUnreadableError } from "../integrations/index.js";
import { readVcsBotLogin } from "../vcs/index.js";
import {
  readConnectedDeployedWorkflowDefinitionVersion,
  readConnectedWorkflowDefinitionVersion,
  readDeployedWorkflowDefinitionVersion,
  readWorkflowDefinitionVersion,
} from "../../engine/stored-definition-reads.js";

/** The allowlist lives in the contracts package, because the dashboard decides
 * whether to offer "Run manually" from the same list and a second copy would drift.
 * This module keeps the narrowing: everything absent from the list still fails
 * closed here, which is the guarantee callers rely on. */
type RunnableTriggerType = ManuallyDispatchableTrigger;

function isDispatchableTriggerType(
  type: WorkflowBlockType,
): type is RunnableTriggerType {
  return isManuallyDispatchableTrigger(type);
}

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
      aiColumn: string;
      steps: ManualDispatchPreflightStep[];
      /** Every block type the deployed graph carries, so the preflight can ask
       *  whether an integration it uses is in a state to run. */
      blockTypes: string[];
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
      aiColumn: string;
      steps: ManualDispatchPreflightStep[];
      /** Every block type the deployed graph carries, so the preflight can ask
       *  whether an integration it uses is in a state to run. */
      blockTypes: string[];
    };

type ManualDispatchPersistence = {
  getDeployed(definitionId: number): ReturnType<typeof readDeployedWorkflowDefinitionVersion>;
  getVersion(definitionId: number, version: number): ReturnType<typeof readWorkflowDefinitionVersion>;
  getDefinition(definitionId: number): Promise<{ name: string } | null>;
  hasBlockingApproval(ticketKey: string): Promise<boolean>;
  findWorkflowOwnedPullRequest(input: Parameters<typeof findWorkflowOwnedPullRequest>[1]): ReturnType<typeof findWorkflowOwnedPullRequest>;
};

function persistenceFor(db: Db): ManualDispatchPersistence {
  return {
    getDeployed: (definitionId) => readDeployedWorkflowDefinitionVersion(db, definitionId),
    getVersion: (definitionId, version) => readWorkflowDefinitionVersion(db, definitionId, version),
    getDefinition: (definitionId) => getWorkflowDefinitionName(db, definitionId),
    hasBlockingApproval: (ticketKey) => hasDispatchBlockingApprovalForTicket(db, ticketKey),
    findWorkflowOwnedPullRequest: (input) => findWorkflowOwnedPullRequest(db, input),
  };
}

const connectedPersistence: ManualDispatchPersistence = {
  getDeployed: readConnectedDeployedWorkflowDefinitionVersion,
  getVersion: readConnectedWorkflowDefinitionVersion,
  getDefinition: getConnectedWorkflowDefinitionName,
  hasBlockingApproval: hasConnectedDispatchBlockingApprovalForTicket,
  findWorkflowOwnedPullRequest: findConnectedWorkflowOwnedPullRequest,
};

/** The block types a deployed graph carries. Empty for a version this build
 *  cannot run, whose own refusal arrives before the preflight reads this. */
function deployedBlockTypes(
  row: Parameters<typeof runnableDefinitionOf>[0],
): string[] {
  return (runnableDefinitionOf(row)?.nodes ?? []).map((node) => node.type);
}

export async function resolveManualDispatch(input: {
  db: Db;
  /** The deployment's tracker, or why there is none: read only by the inputs
   *  that need a ticket (`issueTrackerForDispatch`). */
  issueTrackerResolution: ResolvedIssueTracker;
  definitionId: number;
  triggerNodeId: string;
  dispatchInput: ManualDispatchInput;
  /** The catalog as the entry point read it: one load per HTTP request, per MCP
   *  call or per poll tick, so a preflight and the dispatch it authorized cannot
   *  answer from two different enabled lists. */
  repositoryCatalog: RepositoryCatalogSnapshot;
  /** Resolve an already-accepted request against its immutable pinned graph. */
  definitionVersion?: number;
}): Promise<ResolvedManualDispatch> {
  const settings = await loadSettingsSnapshotOn(input.db);
  return resolveManualDispatchWithPersistence(
    { ...input, settings },
    persistenceFor(input.db),
  );
}

export async function resolveConnectedManualDispatch(input: Omit<Parameters<typeof resolveManualDispatch>[0], "db">): Promise<ResolvedManualDispatch> {
  const settings = await loadSettingsSnapshot();
  return resolveManualDispatchWithPersistence(
    { ...input, settings },
    connectedPersistence,
  );
}

async function resolveManualDispatchWithPersistence(
  input: Omit<Parameters<typeof resolveManualDispatch>[0], "db"> & {
    settings: SettingsSnapshot;
  },
  persistence: ManualDispatchPersistence,
): Promise<ResolvedManualDispatch> {
  const deployed = await loadDeployedTrigger(
    persistence,
    input.definitionId,
    input.triggerNodeId,
    input.definitionVersion,
  );
  if (deployed.triggerType === "trigger_ticket_ai") {
    if (input.dispatchInput.kind !== "ticket") {
      throw new ManualDispatchError(422, "invalid_input", "This trigger needs a ticket key.");
    }
    return resolveTicketDispatch(
      { ...input, dispatchInput: input.dispatchInput, persistence },
      { ...deployed, triggerType: deployed.triggerType },
    );
  }
  if (input.dispatchInput.kind !== "pull_request") {
    throw new ManualDispatchError(422, "invalid_input", "This trigger requires a pull or merge request URL.");
  }
  return resolvePullRequestDispatch(
    { ...input, dispatchInput: input.dispatchInput, persistence },
    { ...deployed, triggerType: deployed.triggerType },
  );
}

async function loadDeployedTrigger(
  persistence: ManualDispatchPersistence,
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
      ? await persistence.getDeployed(definitionId)
      : await persistence.getVersion(definitionId, definitionVersion);
  if (!deployed) {
    throw new ManualDispatchError(422, "not_eligible", "This workflow has no deployed version.");
  }
  const deployedGraph = runnableDefinitionOf(deployed);
  if (!deployedGraph) {
    throw new ManualDispatchError(422, "not_eligible", RETIRED_SCHEMA_MESSAGE);
  }
  const node = deployedGraph.nodes.find((candidate) => candidate.id === triggerNodeId);
  if (!node || !isDispatchableTriggerType(node.type)) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "This trigger is not present in the deployed workflow.",
    );
  }
  const definition = await persistence.getDefinition(definitionId);
  if (!definition) {
    throw new ManualDispatchError(404, "invalid_input", "Workflow definition not found.");
  }
  return {
    definition: deployed,
    definitionName: definition.name,
    triggerType: node.type as RunnableTriggerType,
  };
}

async function resolveTicketDispatch(
  input: {
    persistence: ManualDispatchPersistence;
    issueTrackerResolution: ResolvedIssueTracker;
    definitionId: number;
    triggerNodeId: string;
    dispatchInput: Extract<ManualDispatchInput, { kind: "ticket" }>;
    settings: SettingsSnapshot;
  },
  deployed: {
    definition: WorkflowDefinitionVersionRow;
    definitionName: string;
    triggerType: "trigger_ticket_ai";
  },
): Promise<Extract<ResolvedManualDispatch, { inputKind: "ticket" }>> {
  const ticketKey = normalizeTicketKey(input.dispatchInput.ticketKey);
  // Outside the try: no tracker is a refusal about the deployment, not the
  // tracker failing to answer, and the catch below would say the latter.
  const issueTracker = issueTrackerForDispatch(input.issueTrackerResolution);
  let ticket;
  try {
    ticket = await issueTracker.fetchTicket(ticketKey);
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
      "The issue tracker could not be reached.",
    );
  }
  const expectedProject = (await issueTrackerWiring()).projectKey.trim().toUpperCase();
  if (projectKey(ticket.identifier) !== expectedProject) {
    throw new ManualDispatchError(
      422,
      "invalid_input",
      `Ticket must belong to project ${expectedProject}.`,
    );
  }
  if (await input.persistence.hasBlockingApproval(ticketKey)) {
    throw new ManualDispatchError(
      409,
      "approval_pending",
      "This ticket has a pending or approved workflow plan.",
    );
  }
  const alreadyInAi =
    ticket.trackerStatus.trim().toLowerCase() ===
    input.settings.COLUMN_AI.trim().toLowerCase();
  return {
    definitionId: input.definitionId,
    definitionName: deployed.definitionName,
    definitionVersion: deployed.definition.version,
    triggerNodeId: input.triggerNodeId,
    triggerType: "trigger_ticket_ai",
    input: { kind: "ticket", ticketKey },
    inputKind: "ticket",
    inputPayload: { kind: "ticket", ticketKey },
    subjectKey: await ticketSubject(ticketKey),
    ticketKey,
    subjectTitle: ticket.title,
    currentStatus: ticket.trackerStatus,
    aiColumn: input.settings.COLUMN_AI,
    blockTypes: deployedBlockTypes(deployed.definition),
    steps: [
      {
        title: "Reserve ticket",
        description: "Prevent duplicate automatic or manual runs",
      },
      {
        title: alreadyInAi
          ? `Keep in ${input.settings.COLUMN_AI}`
          : `Move ${ticket.trackerStatus} → ${input.settings.COLUMN_AI}`,
        description:
          "Manual ownership suppresses automatic pickup until this run withdraws or moves the ticket",
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
    persistence: ManualDispatchPersistence;
    issueTrackerResolution: ResolvedIssueTracker;
    definitionId: number;
    triggerNodeId: string;
    dispatchInput: Extract<ManualDispatchInput, { kind: "pull_request" }>;
    repositoryCatalog: RepositoryCatalogSnapshot;
    settings: SettingsSnapshot;
  },
  deployed: {
    definition: WorkflowDefinitionVersionRow;
    definitionName: string;
    triggerType: Exclude<RunnableTriggerType, "trigger_ticket_ai">;
  },
): Promise<Extract<ResolvedManualDispatch, { inputKind: "pull_request" }>> {
  const parsed = await parsePullRequestUrl(input.dispatchInput.url);
  if (!parsed) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "The pull request provider is not configured.",
    );
  }
  const vcs = createManualDispatchPrReader({
    provider: parsed.provider,
    repoPath: parsed.repoPath,
  });
  let snapshot: ManualDispatchPullRequestSnapshot;
  try {
    snapshot = await vcs.getManualDispatchPullRequest(parsed.prNumber);
  } catch (error) {
    // A wrong number, or a pull request this connection may not see, is the
    // person's to fix, not an outage to wait out.
    if (isPullRequestUnreadableError(error)) {
      throw new ManualDispatchError(
        422,
        "not_eligible",
        "This pull request does not exist, or this deployment's connection cannot read it.",
      );
    }
    if (error instanceof ManualDispatchUnsupportedError) {
      throw new ManualDispatchError(422, "not_eligible", error.message);
    }
    // Ours, not the provider's: the read that failed was this deployment's own
    // settings, taken again when the provider's adapter was built. A 502 here
    // sent the person to GitHub for a database that did not answer.
    if (error instanceof IntegrationSettingsUnreadableError) {
      throw settingsUnreadableForDispatch("the pull request could not be read");
    }
    throw new ManualDispatchError(
      502,
      "provider_unavailable",
      "The pull request provider could not be reached.",
    );
  }
  // Every question from here on is asked of the repository as the provider
  // spells it, which is how the records a run is checked against spell it.
  const target = await providerSpelledPullRequest(parsed, snapshot.prUrl);
  const params = triggerNodeParams(
    runnableDefinitionOf(deployed.definition),
    deployed.triggerType,
  );
  const providers = Array.isArray(params.providers) ? params.providers : [];
  if (providers.length > 0 && !providers.includes(target.provider)) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "This deployed trigger does not allow that provider.",
    );
  }
  const scope = params.scope === "any" ? "any" : "workflow_owned";
  const pinnedScope = runnableDefinitionOf(deployed.definition)?.repositoryScope;
  if (
    scope === "any" &&
    !isRepositoryDispatchable(input.repositoryCatalog, {
      provider: target.provider,
      path: target.repoPath,
    })
  ) {
    // The definition's own pin is deliberately not consulted: a pin selects
    // inside the catalog and no longer grants past it.
    throw new ManualDispatchError(
      422,
      "not_eligible",
      REPOSITORY_NOT_IN_CATALOG_REASON,
    );
  }
  // Mirrors the automatic trigger gate in dispatch-trigger.ts, including its
  // workflow_owned exemption: that scope proves ownership below instead, so a pin
  // edit must not strand an open workflow pull request.
  if (
    scope === "any" &&
    pinnedScope &&
    !isRepositoryWithinPinnedScope(pinnedScope, {
      provider: target.provider,
      repoPath: target.repoPath,
    })
  ) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "This repository is outside the repositories pinned to this workflow.",
    );
  }
  const pr = snapshotToPayload(target.provider, target.repoPath, snapshot);
  const eligible = selectManualTriggerEvent(
    deployed.triggerType,
    pr,
    {
      ...snapshot,
      // Our own gate's checks, in either naming generation, never start a run.
      failedChecks: snapshot.failedChecks.filter(
        (check) => !isManagedGateCheckName(check.name),
      ),
    },
    params,
    deployed.triggerType === "trigger_pr_review" ? await knownBotLogin(pr.provider) : undefined,
  );
  if (!eligible) {
    throw new ManualDispatchError(
      422,
      "not_eligible",
      "The pull request's current provider state does not match this trigger.",
    );
  }

  // Both scopes reserve the pull request itself. A ticket subject collapsed every
  // pull request of a multi-repo change onto one key, and now that webhook
  // dispatch keys on the pull request, a ticket subject here would also stop a
  // manual run from deduplicating against the automatic run of the same PR.
  const subjectKey = prSubjectKey(pr.provider, pr.repoPath, pr.prNumber);
  let ticketKey: string | null = null;
  if (scope !== "any") {
    const owned = await input.persistence.findWorkflowOwnedPullRequest({
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
    // Refused before the lookup: no tracker is not "could not be verified",
    // and retrying cannot make one appear.
    const issueTracker = issueTrackerForDispatch(input.issueTrackerResolution);
    const ticket = await issueTracker.fetchTicket(owned.ticketKey).catch(() => null);
    if (!ticket) {
      throw new ManualDispatchError(
        502,
        "provider_unavailable",
        "The linked ticket could not be verified.",
      );
    }
    ticketKey = ticket.identifier.trim().toUpperCase();
    if (await input.persistence.hasBlockingApproval(ticketKey)) {
      throw new ManualDispatchError(
        409,
        "approval_pending",
        "The linked ticket has a pending or approved workflow plan.",
      );
    }
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
    subjectTitle: snapshot.title || `${target.repoPath}#${target.prNumber}`,
    subjectUrl: snapshot.prUrl,
    aiColumn: input.settings.COLUMN_AI,
    blockTypes: deployedBlockTypes(deployed.definition),
    steps: [
      {
        title: "Reserve pull request",
        description: "Prevent duplicate automatic or manual runs",
      },
      {
        title: "Verify current provider state",
        description: ticketKey
          ? `Linked ticket ${ticketKey} remains unchanged`
          : "No status change",
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
  botLogin?: string,
): TriggerEvent | null {
  if (triggerType === "trigger_pr_created") {
    if (snapshot.state !== "open") return null;
    return baseEvent(triggerType, pr, "manual");
  }
  if (triggerType === "trigger_pr_ready") {
    if (snapshot.state !== "open" || snapshot.isDraft) return null;
    return baseEvent(triggerType, pr, "manual");
  }
  if (triggerType === "trigger_pr_updated") {
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
      const eligible = selectEligibleEvent(event, params, botLogin);
      if (eligible) return eligible;
    }
    return null;
  }

  const byProducer = new Map<string, NonNullable<PrTriggerPayload["failedChecks"]>>();
  for (const check of snapshot.failedChecks) {
    if (!check.producer) continue;
    byProducer.set(check.producer, [...(byProducer.get(check.producer) ?? []), check]);
  }
  for (const [producer, failedChecks] of byProducer) {
    const event = baseEvent(triggerType, { ...pr, failedChecks }, producer);
    const first = snapshot.failedChecks.find((check) => check.producer === producer);
    const eligible = selectEligibleEvent(
      {
        ...event,
        delivery: {
          ...event.delivery,
          ...(first?.source ? { source: first.source } : {}),
          // The integration's own answer, exactly as its webhook gives it.
          ...(first?.trustedByDefault !== undefined
            ? { trustedByDefault: first.trustedByDefault }
            : {}),
        },
      },
      params,
    );
    if (eligible) return eligible;
  }
  return null;
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

/**
 * The pull request as its provider names it.
 *
 * A pasted URL carries whatever case the person typed: `github.com/blazity/x`
 * for the repository GitHub calls `Blazity/x`. The provider reads either
 * spelling and answers with its own in the pull request's URL, and the records
 * a run is later checked against (the run that published the pull request, its
 * workflow-owned branch, the workspace manifest) all carry that spelling. A run
 * started from the typed one asked "did we publish this?" in the wrong case, was
 * told no, and its fix agent refused to push.
 *
 * Only a respelling is adopted. A URL that names another repository (a rename
 * the provider redirected to) is a different question for the catalog and the
 * pin, and one no connected provider parses says nothing, so both leave the
 * pasted path as it was.
 */
async function providerSpelledPullRequest(
  pasted: { provider: string; repoPath: string; prNumber: number },
  providerUrl: string,
): Promise<{ provider: string; repoPath: string; prNumber: number }> {
  let url: URL;
  try {
    url = new URL(providerUrl);
  } catch {
    return pasted;
  }
  let answered: Awaited<ReturnType<typeof resolveConfiguredPullRequestUrl>>;
  try {
    answered = await resolveConfiguredPullRequestUrl(url);
  } catch (error) {
    if (error instanceof IntegrationSettingsUnreadableError) {
      throw settingsUnreadableForDispatch("the pull request's repository could not be matched to a provider");
    }
    throw error;
  }
  return answered &&
    answered.provider === pasted.provider &&
    answered.prNumber === pasted.prNumber &&
    isSameRepository(answered, pasted)
    ? answered
    : pasted;
}

function snapshotToPayload(
  provider: string,
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
    ...(snapshot.failedChecks.length > 0
      ? { failedChecks: snapshot.failedChecks }
      : {}),
  };
}

export async function parsePullRequestUrl(urlText: string): Promise<{
  provider: string;
  repoPath: string;
  prNumber: number;
} | null> {
  let url: URL;
  try {
    url = new URL(urlText.trim());
  } catch {
    throw new ManualDispatchError(422, "invalid_input", "Enter a valid pull or merge request URL.");
  }
  try {
    return await resolveConfiguredPullRequestUrl(url);
  } catch (error) {
    // Not "the pull request provider is not configured": nobody could look.
    if (error instanceof IntegrationSettingsUnreadableError) {
      throw settingsUnreadableForDispatch("the pull request URL could not be matched to a provider");
    }
    throw error;
  }
}

function normalizeTicketKey(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(normalized)) {
    throw new ManualDispatchError(422, "invalid_input", "Enter a valid ticket key.");
  }
  return normalized;
}

function projectKey(identifier: string): string | null {
  const dash = identifier.indexOf("-");
  return dash > 0 ? identifier.slice(0, dash).trim().toUpperCase() : null;
}

/**
 * The automation account, for a review this person asked to run. Read the way
 * automatic dispatch reads it: an account this deployment could not read is
 * refused out loud, never taken for "none", because a commented review allowed
 * without it is how the workflow answers its own comment.
 */
async function knownBotLogin(provider: string): Promise<string | undefined> {
  const reading = await readVcsBotLogin(provider);
  if (reading.readable) return reading.login;
  // The database's own words are not for the person dispatching; the reader
  // that failed is what they need, and the same 503 every settings read gives.
  throw settingsUnreadableForDispatch(`the automation account for ${provider} could not be read`);
}
