import type { WorkflowRepositoryScope } from "@shared/contracts";
import {
  filterPinnedRepositories,
  pinnedScopeExcludesProvider,
  type RepositoryListingFailure,
  type RepositoryMetadata,
  type SelectedRepository,
  type WorkflowOwnedBranch,
} from "../../adapters/vcs/repository-directory.js";
import type {
  PreSandboxConfigStep,
  PreSandboxRepositoryCatalogDegradation,
  PreSandboxRepositoryScopeNarrowing,
  PreSandboxStepContext,
  PreSandboxStepHandler,
  PreSandboxStepResult,
} from "../types.js";
import {
  buildRepositoryCatalog,
  buildRepositoryCatalogEntries,
  type RepositoryCatalogEntry,
} from "../../repository-discovery/catalog.js";
import { filterRepositoriesForScope } from "../../lib/repo-allowlist.js";
// Type only, so importing this file never pulls the routing module in with it.
//
// This file is NOT in the workflow isolate: the bundles were built and checked, and
// repoSelectionStep lands in the steps bundle, never in the workflows one. It is
// reached through a dynamic import inside a step body and runs in Node, which is why
// the isolate's no-Node-builtins rule does not apply here and why the pre-existing
// module-scope pino edge through lib/repo-allowlist.js has never failed. The values
// below are still imported lazily, for the reason that does apply: importing this
// module must not drag the VCS adapters, the database client and the store in behind
// it on a path that only needs the pure selection function.
import type { RepoRoutingEntry } from "../../memory/repo-routing.js";

export interface WorkflowOwnedBranchSelectionInput {
  provider: RepositoryMetadata["provider"];
  repoPath: string;
  branch: WorkflowOwnedBranch;
}

export const repoSelectionStep: PreSandboxStepHandler = async ({ context, step }) => {
  const { listRepositoriesAcrossProviders } = await import("../../adapters/vcs/repository-directory.js");
  const { getDb } = await import("../../db/client.js");
  const { listWorkflowOwnedBranchesForTicket } = await import("../../db/queries/workflow-owned-branches.js");
  const { env, getConfiguredVcsProviders } = await import("../../../env.js");
  const ticketIdentifier = context.ticket.identifier;
  const workflowOwnedBranches = ticketIdentifier
    ? (await listWorkflowOwnedBranchesForTicket(getDb(), ticketIdentifier)).map((record) => ({
        provider: record.provider,
        repoPath: record.repoPath,
        branch: {
          branchName: record.branchName,
          ...(record.pr ? { pr: record.pr } : {}),
        },
      }))
    : [];
  const repositoryScope = context.repositoryScope;
  const listing = await listRepositoriesAcrossProviders(
    listedVcsProviders(
      getConfiguredVcsProviders(),
      repositoryScope,
      workflowOwnedBranches,
    ),
  );
  const repositories = filterRepositoriesForScope(
    listing.repositories,
    repositoryScope,
  );
  const incompleteCatalogProviders = listing.failures
    .filter(
      (failure) =>
        !failedProviderCannotAffectSelection(
          failure.provider,
          repositoryScope,
          workflowOwnedBranches,
        ),
    )
    .map((failure) => failure.provider);

  const directAnswer = latestClarificationAnswer(context.ticket.comments);
  const selected = selectRepositoriesFromMetadata({
    ticketText: ticketText(context.ticket),
    repositories,
    workflowOwnedBranches,
    ...(repositoryScope ? { repositoryScope } : {}),
    ...(incompleteCatalogProviders.length > 0 ? { incompleteCatalogProviders } : {}),
    ...(directAnswer ? { directAnswer } : {}),
  });
  const narrowing = scopeNarrowing(repositories, repositoryScope);
  const degradation = catalogDegradation(
    listing.failures,
    selected.status === "catalog_incomplete",
  );
  /** The "continue with a selection" result, in one place because two paths now
   *  reach it: the deterministic selection below, and a remembered routing answer
   *  standing in for the question the discovery fallback would have asked. */
  const selectionResult = (chosen: SelectedRepository[]): PreSandboxStepResult => ({
    status: "continue",
    selectedRepositories: chosen,
    promptAdditions: [
      {
        target: ["research", "implementation", "review"],
        title: "Selected Repositories",
        content: chosen
          .map((repo) => `- ${repo.provider}:${repo.repoPath}: ${repo.selectedRationale}`)
          .join("\n"),
      },
    ],
    ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
    ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
  });

  if (selected.status === "catalog_incomplete") {
    const incomplete = incompleteCatalogMessage(
      step,
      listing.failures,
      selected.providers,
    );
    return {
      status: "halt",
      outcome: "failed",
      message: incomplete.message,
      ...(incomplete.cause ? { cause: incomplete.cause } : {}),
      ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
      ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
    };
  }

  if (selected.status === "clarification_needed") {
    return {
      status: "halt",
      outcome: "needs_clarification",
      message: selected.questions[0],
      questions: selected.questions,
      ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
      ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
    };
  }

  if (selected.status === "discovery_needed") {
    // The ONLY place remembered routing is consulted, and the safety property
    // holds by construction rather than by ordering: selectRepositoriesFromMetadata
    // cannot see a remembered entry at all, so there is no signal precedence to
    // get wrong. Reaching this branch already proves every deterministic signal
    // declined, because a workflow-owned branch for this ticket, the definition
    // pin, a repository path written in the ticket, an incomplete catalog and the
    // only-accessible-repository shortcut each return before it, and
    // mandatoryRepositories is provably empty here for the same reason. What a
    // remembered answer replaces is therefore exactly the question this branch
    // leads to, never a decision something else already made.
    const remembered = routingMemoryEnabled(env)
      ? await rememberedRoutingSelection(context.ticket.labels ?? [], selected.catalog)
      : null;
    if (remembered) return selectionResult([remembered]);
    return {
      status: "continue",
      repositoryDiscovery: {
        catalog: selected.catalog,
        mandatoryRepositories: selected.mandatoryRepositories,
      },
      ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
      ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
    };
  }

  if (routingMemoryEnabled(env)) {
    await rememberRoutingAnswer({
      labels: context.ticket.labels ?? [],
      ...(context.clarification ? { clarification: context.clarification } : {}),
      ticketIdentifier: context.ticket.identifier,
      branchName: context.run.branchName,
      repositories: selected.repositories,
    });
  }

  return selectionResult(selected.repositories);
};

/**
 * Both switches, on the read and on the write alike. ENABLE_REPO_MEMORY is the
 * feature-wide kill switch; ENABLE_REPO_ROUTING_MEMORY exists because a routing
 * document is org scoped and therefore carries across repository boundaries, which
 * on a forge where one top-level namespace holds several tenants is a tenancy
 * decision an operator has to make on its own. Gating on ENABLE_REPO_MEMORY alone
 * would have handed an org-scoped document to an operator who deliberately left
 * the org switches off.
 */
function routingMemoryEnabled(env: {
  ENABLE_REPO_MEMORY: boolean;
  ENABLE_REPO_ROUTING_MEMORY: boolean;
}): boolean {
  return env.ENABLE_REPO_MEMORY && env.ENABLE_REPO_ROUTING_MEMORY;
}

/**
 * Per organisation document. Far more answers than a real organisation
 * accumulates: at MAX_ROUTING_LABEL_CHARS plus two corroborating ticket keys a
 * rendered line is around 250 ASCII bytes, so 50 entries come to roughly 12.5 KiB
 * and the entry count is what binds a mature document. The byte cap below is the
 * backstop for labels that are not ASCII, where the merge evicts whole entries
 * rather than truncating one.
 */
const MAX_ROUTING_ENTRIES = 50;
/** Per organisation document, sized above what MAX_ROUTING_ENTRIES can render so
 *  the entry count is the binding cap. Nothing injects a routing document into a
 *  prompt, so this bounds storage rather than tokens, which is why it is larger
 *  than the facts and lessons write cap. */
const MAX_ROUTING_DOC_BYTES = 24 * 1024;
/** Per run. One ticket cannot flood an organisation's document however many
 *  labels it happens to carry. */
const MAX_ROUTING_ENTRIES_PER_RUN = 5;
/** Compare-and-swap rounds. neon-http has no transactions, so the version
 *  predicate is what makes the read-merge-write safe; a document under contention
 *  from more writers than this keeps its winner and loses only this run's update. */
const MAX_ROUTING_WRITE_ATTEMPTS = 3;
/** Organisation documents read on the discovery fallback, bounding the round trips
 *  a run adds before the model or the human is asked. A catalog spanning more
 *  owners than this loses the tail, which costs a question and never a wrong
 *  repository. */
const MAX_ROUTING_OWNERS_READ = 5;
/**
 * The rationale the ticket-text scan stamps, duplicated here rather than shared
 * with selectRepositoriesFromMetadata so that function keeps a zero-line diff.
 * The coupling is covered end to end: the write tests drive the real selection
 * path, so renaming the rationale there stops the write and fails them.
 */
const TICKET_TEXT_RATIONALE = "ticket mentions repository path";

/**
 * The repository a ticket's labels remember, or null for "ask". Best effort in the
 * strongest sense: this runs where the alternative is a question, so a failure
 * costs a question and never the run.
 */
async function rememberedRoutingSelection(
  labels: string[],
  catalog: RepositoryCatalogEntry[],
): Promise<SelectedRepository | null> {
  try {
    // A ticket with no labels has nothing to look up, so it never reaches the
    // database at all.
    if (labels.length === 0) return null;
    const { orgSubjectKey, repoOwner } = await import("../../lib/subject-key.js");
    const { getDb } = await import("../../db/client.js");
    const { getMemoryDocument } = await import("../../memory/store.js");
    const {
      REPO_ROUTING_DOC_PATH,
      isRepoRoutingEntryEligible,
      parseRepoRoutingDocument,
      repoRoutingMatches,
    } = await import("../../memory/repo-routing.js");

    // The catalog is exactly what a human or the discovery model would have been
    // allowed to choose from: already pin-filtered, already archive-filtered, and
    // carrying the usability the workspace needs. Validating against it is what
    // makes a remembered repository that has since left the catalog, lost its
    // default branch or been excluded by the pin ignored rather than selected.
    const usable = new Map<string, RepositoryCatalogEntry>();
    for (const entry of catalog) {
      if (entry.usable) usable.set(repositoryKey(entry), entry);
    }

    // Owners come from the WHOLE catalog, unusable entries included, so an owner
    // whose repositories have all gone unusable is still read. Its document may
    // hold testimony that disagrees with a live answer, and a veto that depends on
    // the disagreeing repository still being clonable would be a veto that
    // disappears exactly when the repository it names is renamed away.
    const owners: Array<{ provider: RepositoryMetadata["provider"]; owner: string }> = [];
    const seenOwners = new Set<string>();
    for (const entry of catalog) {
      const owner = repoOwner(entry.repoPath);
      if (owner === null) continue;
      const key = `${entry.provider}:${owner}`;
      if (seenOwners.has(key)) continue;
      seenOwners.add(key);
      owners.push({ provider: entry.provider, owner });
      if (owners.length === MAX_ROUTING_OWNERS_READ) break;
    }

    const db = getDb();
    const entries: RepoRoutingEntry[] = [];
    for (const { provider, owner } of owners) {
      const stored = await getMemoryDocument(
        db,
        orgSubjectKey(provider, owner),
        REPO_ROUTING_DOC_PATH,
      );
      if (!stored) continue;
      for (const entry of parseRepoRoutingDocument(stored.content)) {
        // An entry may only ever name a repository under the owner whose document
        // holds it. Without this a document under a shared top-level namespace
        // could route a sibling tenant's ticket, which is the cross-tenant path
        // repoOwner exists to close.
        if (entry.provider !== provider || repoOwner(entry.repoPath) !== owner) continue;
        entries.push(entry);
      }
    }

    const matches = repoRoutingMatches(entries, labels);

    // Disagreement is tested over EVERY matched entry, ahead of both liveness and
    // corroboration, because liveness is a property of the repository and not of the
    // testimony. When one label says acme/checkout and another says acme/api, the
    // first has asserted "not acme/api"; finding its target renamed or archived
    // makes that testimony unactionable, it does not make it agree. Discarding it and
    // resolving to the survivor is exactly the inference the harm asymmetry forbids,
    // and it is the shape a wrong repository would take here.
    const distinct = new Set(matches.map((entry) => repositoryKey(entry)));
    if (distinct.size !== 1) {
      if (distinct.size > 1) {
        // Labels as well as repositories: a dissent on one label vetoes an
        // otherwise corroborated route, and the only way an operator can clear it
        // is to know which label carried the dissent.
        await logRouting("info", "repo_routing_ambiguous", {
          repositories: [...distinct],
          labels: matches.map((entry) => entry.label),
        });
      }
      return null;
    }
    const key = [...distinct][0]!;

    // One human answer is an observation, not evidence. Labels at a real client are
    // often generic ("bug", "P2", "sprint-42"), and a single answer binds one of
    // those as readily as a meaningful one, which would then route any later ticket
    // that merely shares the label. Two DISTINCT tickets have to have resolved the
    // same label the same way, which is the rule org fact promotion already applies
    // to facts, moved to testimony. Uncorroborated entries are still written, so the
    // second confirmation can arrive, and still counted as disagreement above, so a
    // lone dissent is never silently discarded.
    if (!matches.some(isRepoRoutingEntryEligible)) {
      await logRouting("info", "repo_routing_uncorroborated", { repository: key });
      return null;
    }

    // Liveness last, and on the single survivor only. Ignoring a stale answer means
    // asking, never falling through to a different label's answer.
    const chosen = usable.get(key);
    if (!chosen) {
      await logRouting("info", "repo_routing_stale", { repository: key });
      return null;
    }
    await logRouting("info", "repo_routing_resolved", {
      repository: `${chosen.provider}:${chosen.repoPath}`,
      labels: matches.map((entry) => entry.label),
    });
    return {
      provider: chosen.provider,
      repoPath: chosen.repoPath,
      defaultBranch: chosen.defaultBranch,
      // The matched label is deliberately NOT interpolated here: this rationale is
      // compiled into an agent prompt, and a tracker label is text a ticket author
      // controls. The label goes to the log above, which is where an operator
      // asking "why this repository" looks.
      selectedRationale: "remembered from a human answer for a matching ticket label",
    };
  } catch (err) {
    await logRouting("warn", "repo_routing_read_failed", { err: errorText(err) });
    return null;
  }
}

/**
 * Records "a ticket carrying label L in this organisation was resolved to
 * repository R by a human". The write point, because a human's which-repo answer
 * always resolves through this step: the discovery prompt is assembled from the
 * untouched ticket, so the synthetic clarification comment prepare-workspace
 * appends is read here and nowhere else.
 *
 * Best effort, and it may not fail the run: the selection has already succeeded by
 * the time this is called, so everything here is wrapped and swallowed.
 */
async function rememberRoutingAnswer(input: {
  labels: string[];
  clarification?: PreSandboxStepContext["clarification"];
  ticketIdentifier?: string;
  branchName: string;
  repositories: SelectedRepository[];
}): Promise<void> {
  try {
    if (input.labels.length === 0) return;
    // Structural, and the reason nothing here matches on a comment author. The field
    // is set only when the block that raised the clarification is the one that owns
    // repository selection, so a value here means the reply is an answer to "which
    // repository?" rather than a reply to some other question that happens to quote
    // a path. A display name on a tracker comment is user controlled and could
    // authenticate nothing.
    if (input.clarification?.resolves !== "repository_selection") return;
    // Corroboration counts DISTINCT tickets, so a run whose ticket cannot be
    // identified is not stored at all: an unidentifiable ticket would either read as
    // the same ticket every time, which can never corroborate, or as a new one every
    // time, which would corroborate itself.
    const ticketIdentifier = input.ticketIdentifier?.trim();
    if (!ticketIdentifier) return;
    // Both remaining conditions still matter on top of that gate. The rationale is
    // what proves the repository entered the selection through the ticket-text scan
    // rather than through a pin, an owned branch or the only-accessible-repository
    // shortcut, none of which a human chose; the mention is what proves the human's
    // own reply named this repository rather than some earlier sentence in the ticket.
    const answerText = input.clarification.answer.toLowerCase();
    const named = input.repositories.filter(
      (repo) =>
        repo.selectedRationale === TICKET_TEXT_RATIONALE &&
        mentionsRepositoryPath(answerText, repo.repoPath),
    );
    // Exactly one, or nothing. With two repositories named, every label on the
    // ticket would map to both, and a label that maps to two repositories is not a
    // routing answer: it is the ambiguity the read path refuses to guess at, so it
    // is never stored in the first place.
    if (named.length !== 1) return;
    const chosen = named[0]!;

    const { orgSubjectKey, repoOwner } = await import("../../lib/subject-key.js");
    const owner = repoOwner(chosen.repoPath);
    // A path with no owning namespace names no organisation to remember it under.
    if (owner === null) return;
    const { getDb } = await import("../../db/client.js");
    const { getMemoryDocument, upsertMemoryDocument } = await import("../../memory/store.js");
    const { prepareMemoryContent } = await import("../../memory/content.js");
    const {
      REPO_ROUTING_DOC_PATH,
      mergeRepoRoutingEntries,
      normalizeRoutingLabel,
      normalizeRoutingTickets,
      parseRepoRoutingDocument,
      renderRepoRoutingDocument,
      repoRoutingLabelKey,
    } = await import("../../memory/repo-routing.js");

    // An identifier the stored shape cannot hold would round-trip to no ticket at
    // all, leaving an entry nothing could ever corroborate, so it is refused here
    // rather than written as permanently uncorroborated.
    const tickets = normalizeRoutingTickets([ticketIdentifier]);
    if (tickets.length === 0) return;

    const candidates: RepoRoutingEntry[] = [];
    const seenLabels = new Set<string>();
    for (const label of input.labels) {
      const normalized = normalizeRoutingLabel(label);
      const key = repoRoutingLabelKey(normalized);
      if (key.length === 0 || seenLabels.has(key)) continue;
      seenLabels.add(key);
      candidates.push({
        label: normalized,
        provider: chosen.provider,
        repoPath: chosen.repoPath,
        tickets,
      });
      if (candidates.length === MAX_ROUTING_ENTRIES_PER_RUN) break;
    }
    if (candidates.length === 0) return;

    const db = getDb();
    // Neither the label nor the repository path may address a document: the
    // subject key comes from orgSubjectKey and the doc path is a constant.
    const subjectKey = orgSubjectKey(chosen.provider, owner);
    const stored = await getMemoryDocument(db, subjectKey, REPO_ROUTING_DOC_PATH);
    let existing = stored ? parseRepoRoutingDocument(stored.content) : [];
    // `stored?.version ?? 0` is the required idiom: the key may never be present
    // with an undefined value, and 0 is what means "create it".
    let expectedVersion = stored?.version ?? 0;
    for (let attempt = 1; attempt <= MAX_ROUTING_WRITE_ATTEMPTS; attempt += 1) {
      const merged = mergeRepoRoutingEntries({
        existing,
        candidates,
        maxEntries: MAX_ROUTING_ENTRIES,
        maxBytes: MAX_ROUTING_DOC_BYTES,
        owner,
      });
      // Already stored, so a repeated run does not bump the version for nothing.
      if (sameRoutingEntries(merged.entries, existing)) return;
      const prepared = prepareMemoryContent(
        renderRepoRoutingDocument({ owner, entries: merged.entries }),
        MAX_ROUTING_DOC_BYTES,
        false,
      );
      // Fail closed. Text that could not be scrubbed never reaches the store, and
      // a truncated routing document is worse than a missing one: the cut can land
      // mid-line and leave an entry naming a repository nobody chose.
      //
      // The merge already sized the pre-redaction render to this cap, so reaching
      // the truncation branch means redaction GREW the text, which happens when a
      // label quotes a configured secret and the replacement marker is longer than
      // what it replaced. Such a document is dropped whole and the warning below is
      // the only trace, which is the right trade but worth knowing when a routing
      // document mysteriously stops updating.
      if (!prepared || prepared.truncated) {
        await logRouting("warn", "repo_routing_write_skipped", { subjectKey });
        return;
      }
      const result = await upsertMemoryDocument(db, {
        subjectKey,
        docPath: REPO_ROUTING_DOC_PATH,
        // Organisation scoped, so no ticket owns this document.
        ticketKey: null,
        content: prepared.content,
        // Pre-sandbox has no run id in its step context: PreSandboxStepContext
        // carries only the branch name, and threading one would mean editing
        // pre-sandbox/types.ts, pre-sandbox/runner.ts and prepare-workspace.ts. The
        // prefix marks the value as deliberately not a run id, which the dashboard
        // displays this column as, while keeping the branch for diagnostics.
        sourceRunId: `presandbox:${input.branchName}`,
        expectedVersion,
      });
      if (result.applied) {
        await logRouting("info", "repo_routing_remembered", {
          subjectKey,
          repository: `${chosen.provider}:${chosen.repoPath}`,
          labels: candidates.map((entry) => entry.label),
          dropped: merged.dropped,
        });
        return;
      }
      if (attempt === MAX_ROUTING_WRITE_ATTEMPTS) {
        await logRouting("warn", "repo_routing_write_contended", {
          subjectKey,
          attempts: MAX_ROUTING_WRITE_ATTEMPTS,
        });
        return;
      }
      // Re-read, re-merge and re-render per attempt: a lost swap means another run
      // replaced the document, and re-issuing the same bytes would discard exactly
      // the entries this loop exists to preserve.
      const fresh = await getMemoryDocument(db, subjectKey, REPO_ROUTING_DOC_PATH);
      existing = fresh ? parseRepoRoutingDocument(fresh.content) : [];
      expectedVersion = fresh?.version ?? 0;
    }
  } catch (err) {
    await logRouting("warn", "repo_routing_write_failed", { err: errorText(err) });
  }
}

/** Corroboration counts as a difference, not just the label and the target: a run
 *  that only confirms a stored entry leaves the same pair behind a longer ticket
 *  list, and skipping that write would leave the entry uncorroborated forever. */
function sameRoutingEntries(
  left: readonly RepoRoutingEntry[],
  right: readonly RepoRoutingEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.label === right[index]?.label &&
        entry.provider === right[index]?.provider &&
        entry.repoPath === right[index]?.repoPath &&
        entry.tickets.join(",") === right[index]?.tickets.join(","),
    )
  );
}

/** Every diagnostic on the routing path is wrapped: a failed logger import must
 *  not escape a best-effort path and take the run with it. */
async function logRouting(
  level: "info" | "warn",
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    const { logger } = await import("../../lib/logger.js");
    logger[level]({ step: "repo-selection", ...fields }, event);
  } catch {
    // Nothing left to report with.
  }
}

/** A driver error can echo the statement, and with it the document, so bound it
 *  before it reaches a log sink. */
function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Whether a provider that failed to answer could not have changed this run's
 * choice anyway. The definition pin already excludes everything it could have
 * offered, so the surviving listing is exactly what selection would have seen had
 * the provider answered, and the run proceeds on its normal path. A provider
 * carrying a workflow-owned branch for this ticket never qualifies: listedVcsProviders
 * queries it precisely so an in-flight pull request is not stranded, and treating
 * its silence as harmless would strand that pull request without saying so.
 */
function failedProviderCannotAffectSelection(
  provider: RepositoryMetadata["provider"],
  repositoryScope: WorkflowRepositoryScope | undefined,
  workflowOwnedBranches: WorkflowOwnedBranchSelectionInput[],
): boolean {
  if (workflowOwnedBranches.some((branch) => branch.provider === provider)) {
    return false;
  }
  return pinnedScopeExcludesProvider(repositoryScope, provider);
}

/** Operator-facing telemetry for a provider that never answered, recorded whether
 *  or not the run survived it. */
function catalogDegradation(
  failures: RepositoryListingFailure[],
  failedClosed: boolean,
): PreSandboxRepositoryCatalogDegradation | null {
  if (failures.length === 0) return null;
  return {
    providers: failures.map((failure) => failure.provider),
    outcome: failedClosed ? "failed_closed" : "continued_degraded",
  };
}

/** Names the step the way the runner's own failureMessage does, so a run that
 *  stopped itself here stays greppable by step name exactly like a run whose
 *  listing threw. */
function incompleteCatalogMessage(
  step: PreSandboxConfigStep,
  failures: RepositoryListingFailure[],
  providers: RepositoryMetadata["provider"][],
): { message: string; cause: string } {
  const reasons = failures
    .filter((failure) => providers.includes(failure.provider))
    .map((failure) => `${failure.provider}: ${failure.message}`)
    .join("; ");
  return {
    message:
      `${step.name ?? step.uses} failed: repository listing for ${providers.join(", ")} is unavailable (${reasons}), so the repository catalog was incomplete. ` +
      "No deterministic repository signal resolved the selection, and choosing from a partial catalog could pick the wrong repository. " +
      "Retry once the provider recovers, or name the repository path in the ticket.",
    // The provider verdicts alone. They sit in the middle of the message above,
    // between the step name and the advice, which is where a head-plus-tail clamp
    // elides them; returned separately so the surfaces bound the advice instead.
    cause: reasons,
  };
}

/**
 * Providers whose listings this run needs. A pin narrows the set so an excluded
 * provider is never even queried, but a provider carrying an in-flight
 * workflow-owned branch for this ticket always stays in: losing its listing
 * would strand that branch's open pull request the moment an operator edits the
 * pin.
 */
function listedVcsProviders<T extends { kind: RepositoryMetadata["provider"] }>(
  providers: T[],
  repositoryScope: WorkflowRepositoryScope | undefined,
  workflowOwnedBranches: WorkflowOwnedBranchSelectionInput[],
): T[] {
  const pinned = repositoryScope?.providers ?? [];
  if (pinned.length === 0) return providers;
  const owned = new Set(workflowOwnedBranches.map((branch) => branch.provider));
  return providers.filter(
    (provider) => pinned.includes(provider.kind) || owned.has(provider.kind),
  );
}

function scopeNarrowing(
  repositories: RepositoryMetadata[],
  repositoryScope: WorkflowRepositoryScope | undefined,
): PreSandboxRepositoryScopeNarrowing | null {
  if (!repositoryScope) return null;
  if (
    (repositoryScope.repositories?.length ?? 0) === 0 &&
    (repositoryScope.providers?.length ?? 0) === 0
  ) {
    return null;
  }
  return {
    catalogSize: repositories.length,
    scopedCatalogSize: filterPinnedRepositories(repositories, repositoryScope).length,
  };
}

export function selectRepositoriesFromMetadata(input: {
  ticketText: string;
  repositories: RepositoryMetadata[];
  workflowOwnedBranches: WorkflowOwnedBranchSelectionInput[];
  repositoryScope?: WorkflowRepositoryScope;
  /** Providers whose listing failed after retries and whose repositories could
   *  still have changed this choice. Absent when every provider answered, which
   *  keeps a healthy run on exactly its normal path. */
  incompleteCatalogProviders?: RepositoryMetadata["provider"][];
  /** The human's direct reply to a prior which-repo clarification question, if
   *  this is a retry. Matched leniently (short name, full path, or a small
   *  typo tolerance) against every scoped repository, separately from the
   *  strict full-path scan over free-form ticket text below. */
  directAnswer?: string | null;
}):
  | { status: "selected"; repositories: SelectedRepository[] }
  | {
      status: "discovery_needed";
      catalog: RepositoryCatalogEntry[];
      mandatoryRepositories: SelectedRepository[];
    }
  | { status: "clarification_needed"; questions: string[] }
  | {
      status: "catalog_incomplete";
      providers: RepositoryMetadata["provider"][];
    } {
  const incompleteCatalogProviders = input.incompleteCatalogProviders ?? [];
  const catalog = buildRepositoryCatalogEntries(input.repositories);
  const usableKeys = new Set(
    catalog.filter((repo) => repo.usable).map((repo) => repositoryKey(repo)),
  );
  const usableRepositories = input.repositories.filter((repo) =>
    usableKeys.has(repositoryKey(repo)),
  );
  const repositoriesByKey = new Map(
    usableRepositories.map((repo) => [repositoryKey(repo), repo]),
  );
  const selected = new Map<string, SelectedRepository>();

  // Signal 0 is the definition pin below, but a repository carrying a
  // workflow-owned branch for this ticket enters first and is never subject to
  // the pin: dropping it would strand that branch's open pull request the moment
  // an operator edits the pin.
  for (const owned of input.workflowOwnedBranches) {
    const repo = repositoriesByKey.get(repositoryKey(owned));
    if (!repo) continue;
    selected.set(repositoryKey(repo), {
      provider: repo.provider,
      repoPath: repo.repoPath,
      defaultBranch: repo.defaultBranch,
      selectedRationale: "workflow-owned branch for this ticket",
      workflowOwnedBranch: owned.branch,
    });
  }

  // Pure intersection over what the server already offered, so the pin can only
  // ever remove candidates. Without a pin this is the input list untouched.
  const scopedRepositories = filterPinnedRepositories(
    usableRepositories,
    input.repositoryScope,
  );
  const pinnedRepositories = input.repositoryScope?.repositories ?? [];
  if (pinnedRepositories.length > 0) {
    const scopedByKey = new Map(
      scopedRepositories.map((repo) => [repositoryKey(repo), repo]),
    );
    const unavailable = pinnedRepositories
      .filter((pinned) => !scopedByKey.has(repositoryKey(pinned)))
      .map((pinned) => `${pinned.provider}:${pinned.repoPath}`);
    // A pin the server cannot satisfy is surfaced by name. Falling through to
    // model discovery would silently replace the operator's explicit choice, and
    // an empty selection would silently resolve the ticket to nothing.
    if (unavailable.length > 0) {
      // A pinned repository that is missing only because its provider never
      // answered is not an access problem the operator can fix in the pin.
      if (incompleteCatalogProviders.length > 0) {
        return incompleteCatalog(incompleteCatalogProviders);
      }
      return {
        status: "clarification_needed",
        questions: [
          `Repositories pinned to this workflow are unavailable: ${unavailable.join(", ")}. Restore access to them or update the workflow's pinned repositories.`,
        ],
      };
    }
    for (const repo of scopedByKey.values()) {
      const key = repositoryKey(repo);
      if (!selected.has(key)) {
        selected.set(key, selectedRepository(repo, "pinned to this workflow"));
      }
    }
    // The initial-match limit below exists for ambiguity between competing
    // signals. An explicit operator pin is not ambiguous, so it does not apply.
    return { status: "selected", repositories: [...selected.values()] };
  }

  const ticketText = input.ticketText.toLowerCase();
  const exactMatches = scopedRepositories.filter((repo) =>
    mentionsRepositoryPath(ticketText, repo.repoPath),
  );
  for (const repo of exactMatches) {
    const key = repositoryKey(repo);
    if (!selected.has(key)) {
      selected.set(key, selectedRepository(repo, "ticket mentions repository path"));
    }
  }

  // A direct reply to a prior which-repo clarification is a much higher-
  // confidence signal than organic ticket text, so it's matched leniently: a
  // human naturally replies with a short name, not necessarily the full
  // owner/repo path the exact-mention scan above requires. Only added when it
  // resolves to exactly one repository — an ambiguous or unmatched reply is
  // left for the fallbacks below (discovery, or asking again).
  if (input.directAnswer) {
    const normalizedAnswer = normalizeRepoAnswer(input.directAnswer);
    const answerExactMatches = scopedRepositories.filter(
      (repo) =>
        normalizeRepoAnswer(repo.repoPath) === normalizedAnswer ||
        normalizeRepoAnswer(repoShortName(repo)) === normalizedAnswer,
    );
    const answerMatches =
      answerExactMatches.length > 0
        ? answerExactMatches
        : fuzzyRepoMatches(normalizedAnswer, scopedRepositories);
    if (answerMatches.length === 1) {
      const repo = answerMatches[0]!;
      const key = repositoryKey(repo);
      if (!selected.has(key)) {
        selected.set(key, selectedRepository(repo, "human clarification answer"));
      }
    }
  }

  if (selected.size > 0) {
    if (selected.size > 3) {
      if (incompleteCatalogProviders.length > 0) {
        return incompleteCatalog(incompleteCatalogProviders);
      }
      return {
        status: "clarification_needed",
        questions: [
          "More than 3 repositories match this ticket. Which repositories are essential for the initial research?",
        ],
      };
    }
    return { status: "selected", repositories: [...selected.values()] };
  }

  // Degradation stops here on purpose. Every path above resolves the selection
  // from a signal that does not depend on seeing the whole catalog: a
  // workflow-owned branch for this ticket, a repository path written in the ticket,
  // a direct clarification answer naming a repository we did see, or a pin the
  // surviving listing fully satisfied. The paths below do depend on
  // it. "Only accessible repository" is a claim about the entire catalog that a
  // partial listing cannot support, and discovery hands the catalog to the model,
  // which would then choose from a set silently missing a whole provider. A
  // clarification is no safer: it presents the same partial catalog to a human as
  // if it were the full picture. Failing the run names the provider that went
  // down; the wrong repository is found much later, by a human, after the branch
  // and pull request already exist.
  if (incompleteCatalogProviders.length > 0) {
    return incompleteCatalog(incompleteCatalogProviders);
  }

  if (scopedRepositories.length === 1) {
    return {
      status: "selected",
      repositories: [
        selectedRepository(scopedRepositories[0]!, "only accessible repository"),
      ],
    };
  }

  // Discovery hands the catalog to the model, so enforce the bounded limit here.
  // Deterministic selection above never fails on catalog size.
  return {
    status: "discovery_needed",
    catalog: buildRepositoryCatalog(
      filterPinnedRepositories(input.repositories, input.repositoryScope),
    ),
    mandatoryRepositories: [...selected.values()],
  };
}

function incompleteCatalog(
  providers: RepositoryMetadata["provider"][],
): { status: "catalog_incomplete"; providers: RepositoryMetadata["provider"][] } {
  return { status: "catalog_incomplete", providers };
}

function repositoryKey(repo: Pick<RepositoryMetadata, "provider" | "repoPath">): string {
  return `${repo.provider}:${repo.repoPath.toLowerCase()}`;
}

function selectedRepository(
  repo: RepositoryMetadata,
  selectedRationale: string,
): SelectedRepository {
  return {
    provider: repo.provider,
    repoPath: repo.repoPath,
    defaultBranch: repo.defaultBranch,
    selectedRationale,
  };
}

function mentionsRepositoryPath(ticketText: string, repoPath: string): boolean {
  const escaped = repoPath.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = "[^a-z0-9/_-]";
  return new RegExp(`(^|${boundary})${escaped}($|${boundary})`).test(ticketText);
}

/** The most recent direct answer to a which-repo clarification, or null when
 *  this isn't a retry. `execution?.clarificationAnswer` is appended as a
 *  synthetic trailing comment (see prepare-workspace.ts); scanning from the
 *  end finds the current round's answer regardless of how many prior rounds
 *  (if any) also appended one. */
function latestClarificationAnswer(
  comments: Array<{ author: string; body: string }> | undefined,
): string | null {
  if (!comments) return null;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i]!.author === "Human clarification") return comments[i]!.body;
  }
  return null;
}

function repoShortName(repo: Pick<RepositoryMetadata, "name" | "repoPath">): string {
  return repo.name || repo.repoPath.split("/").pop() || repo.repoPath;
}

function normalizeRepoAnswer(value: string): string {
  return value.trim().toLowerCase().replace(/[.,;:!?]+$/, "");
}

/** No real repository short name or path is longer than this; a reply beyond
 *  it is prose, not a typo'd answer, so skip the O(n*m) edit-distance scan
 *  instead of running it against an unbounded human-supplied string. */
const MAX_TYPO_TOLERANT_ANSWER_LENGTH = 100;

/** Edit-distance budget for a typo'd clarification reply, or null when the
 *  candidate is too short to fuzzy-match safely. At length <=4 the space of
 *  one-edit neighbors ("web" ~ "wet", "wed", " web") is large relative to the
 *  number of plausible short names, so a coincidental near-miss reply could
 *  silently resolve to the wrong repository — the exact failure mode keyword
 *  scoring caused in production (see the "asks for clarification" tests
 *  above). Below that floor we require an exact match instead of guessing.
 *  Longer names get one slip up to 7 characters, two beyond that, so
 *  "arthur-engine" can absorb a dropped or transposed letter. */
function typoTolerance(value: string): number | null {
  if (value.length <= 4) return null;
  return value.length <= 7 ? 1 : 2;
}

/** Repositories within typo distance of a clarification answer with no exact
 *  match. Skipped for implausibly long replies (prose, not a typo'd name) so
 *  a human pasting an essay doesn't run an O(n*m) edit-distance scan per
 *  repo. */
function fuzzyRepoMatches(
  normalizedAnswer: string,
  repositories: RepositoryMetadata[],
): RepositoryMetadata[] {
  if (normalizedAnswer.length === 0 || normalizedAnswer.length > MAX_TYPO_TOLERANT_ANSWER_LENGTH) {
    return [];
  }
  return repositories.filter((repo) =>
    [normalizeRepoAnswer(repo.repoPath), normalizeRepoAnswer(repoShortName(repo))].some((candidate) => {
      const tolerance = typoTolerance(candidate);
      return tolerance !== null && editDistance(normalizedAnswer, candidate) <= tolerance;
    }),
  );
}

/** Damerau-Levenshtein (optimal string alignment): counts an adjacent
 *  transposition ("aip" -> "api") as a single edit, like a plain
 *  substitution or insertion/deletion — the most common typo shapes for a
 *  short reply. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i]![j] = Math.min(dp[i]![j]!, dp[i - 2]![j - 2]! + 1);
      }
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

function ticketText(ticket: {
  identifier?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  comments?: Array<{ author: string; body: string; createdAt?: string }>;
  labels?: string[];
}): string {
  return [
    ticket.identifier,
    ticket.title,
    ticket.description,
    ticket.acceptanceCriteria,
    ...(ticket.comments ?? []).map((comment) => comment.body),
    ...(ticket.labels ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}
