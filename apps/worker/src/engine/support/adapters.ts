import type { VcsProviderKind } from "@shared/contracts";
import { createConnectedPostgresRunRegistry } from "../../db/repositories/active-runs.js";
import {
  resolveActiveIssueTracker,
  type ResolvedIssueTracker,
} from "./issue-tracker-runtime.js";
import { createRepositoryVCS } from "./vcs-runtime.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { VCSAdapter } from "../../adapters/vcs/types.js";
import type { MessagingSender } from "../../adapters/messaging/types.js";
import type { IntegrationConnectionPin } from "@shared/contracts";
import { messagingSender } from "./messaging.js";
import type {
  RunRegistryAdapter,
  ThreadStore,
} from "../../adapters/run-registry/types.js";

export interface Adapters {
  issueTracker: IssueTrackerAdapter;
  vcs: VCSAdapter;
  messaging: MessagingSender;
  runRegistry: RunRegistryAdapter & ThreadStore;
}

export interface VcsAdapterTarget {
  provider: VcsProviderKind;
  repoPath: string;
  baseBranch: string;
}

/**
 * Every VCS method, refusing with the same sentence.
 *
 * An object rather than a getter that throws. Reading `adapters.vcs` happens in
 * destructuring, in a debugger and in any code that enumerates what it was
 * handed, and a property that explodes on read turns those into a failure far
 * from the call that was actually wrong. The refusal belongs at the method,
 * which is the moment a caller without a repository really asks for something
 * it cannot have.
 */
const VCS_NEEDS_A_REPOSITORY =
  "adapters.vcs needs a repository: call createAdapters({ provider, repoPath, baseBranch }) with the pull request or repository this work is about.";

function refuseWithoutRepository(): never {
  throw new Error(VCS_NEEDS_A_REPOSITORY);
}

const vcsWithoutRepository: VCSAdapter = {
  createBranchIfMissing: refuseWithoutRepository,
  resetOwnedBranch: refuseWithoutRepository,
  createPR: refuseWithoutRepository,
  push: refuseWithoutRepository,
  getPRComments: refuseWithoutRepository,
  postPRComment: refuseWithoutRepository,
  getCheckRunResults: refuseWithoutRepository,
  getPRConflictStatus: refuseWithoutRepository,
  getPRHeadSha: refuseWithoutRepository,
  findPR: refuseWithoutRepository,
  getBranchSha: refuseWithoutRepository,
  getBranchShaIfExists: refuseWithoutRepository,
  getPRHead: refuseWithoutRepository,
  // Present and refusing rather than absent: a caller that checks for this
  // optional method would otherwise quietly take its "provider cannot do it"
  // path and never learn that it forgot to name a repository.
  listReviewThreads: refuseWithoutRepository,
  settleReviewThread: refuseWithoutRepository,
  postRunFailureNote: refuseWithoutRepository,
};

export { coreServesIssueTracker } from "./issue-tracker-runtime.js";

/**
 * ASYNCHRONOUS since S12, and the reason is worth keeping.
 *
 * The issue tracker used to be constructed here from environment variables, so
 * this could be synchronous. It is an integration's connection now, and
 * reading a connection is a database read. The alternative was a proxy that
 * resolved on first use, which would have kept every caller unchanged at the
 * cost of making the eighteen "can this tracker do X" checks in core answer
 * yes for a tracker that cannot: see `issue-tracker-runtime.ts`.
 *
 * The refusal is raised on `adapters.issueTracker`, not here, and that matters
 * on a deployment with no tracker connected, which is a legitimate state now.
 * Most callers of this function want the run registry, the VCS adapter or the
 * messaging sender and never touch the tracker; throwing here would take the
 * run list, the capacity snapshot and every notification down with the
 * tracker. This is NOT the proxy the paragraph above rejects: there is no
 * object to inspect, so `typeof adapters.issueTracker.updateLabels` never
 * answers for a tracker that cannot do it. Reaching for the tracker at all is
 * what fails, with the sentence a person reads.
 */
export async function createAdapters(
  vcsTarget?: VcsAdapterTarget,
  /**
   * What the run recorded about its integrations when it started. Given, the
   * messaging adapter refuses to deliver through a provider that moved under
   * the run; omitted, it follows the deployment as it is now, which is what a
   * notification wants.
   */
  integrationPins?: readonly IntegrationConnectionPin[],
): Promise<Adapters> {
  const runRegistry = createConnectedPostgresRunRegistry();
  let vcs: VCSAdapter | undefined;
  // Which provider carries a message is the deployment's answer, read at each
  // call rather than here: disabling an integration is the kill switch an admin
  // reaches for, and an adapter built once would keep posting for as long as
  // this process lived.
  const messaging = messagingSender(integrationPins);
  // The resolution answers a refusal for the states it knows about (nothing
  // connected, two connected, settings unreadable). An UNEXPECTED throw is a
  // different thing, and before this it left `createAdapters` entirely: the
  // poller calls this before its first phase, so a module that failed to load
  // inside the resolution killed the whole tick rather than the ticket half.
  // It lands on the same getter as every other refusal now, carrying what
  // threw, so a caller that never touches the tracker is unaffected and one
  // that does is told.
  const tracker = await resolveActiveIssueTracker(integrationPins).catch(
    (error): ResolvedIssueTracker => ({
      ok: false,
      unreadable: true,
      reason: `This deployment's issue tracker could not be resolved (${
        error instanceof Error ? error.message : String(error)
      }).`,
    }),
  );
  const adapters = {
    get issueTracker(): IssueTrackerAdapter {
      if (!tracker.ok) throw new Error(tracker.reason);
      return tracker.adapter;
    },
    get vcs() {
      // No target, no adapter. Every production reader of this getter builds
      // its adapters from a pull request or a repository it is already holding
      // (the post-PR gate workflow, the gate dispatchers, the autofix
      // exhaustion notice), so the legacy single-repository fallback that used
      // to sit here answered nobody: its repository came from the deployment's
      // variables and its base branch from a default in a tier that cannot read
      // the settings registry. Refusing says which caller is wrong, where
      // guessing a branch would have put a comment on the wrong one.
      if (!vcsTarget) return vcsWithoutRepository;
      const target = vcsTarget;
      vcs ??= createRepositoryVCS({
        provider: target.provider,
        repoPath: target.repoPath,
        baseBranch: target.baseBranch,
        integrationPins,
      });
      return vcs;
    },
    messaging,
    runRegistry,
  };
  return adapters;
}
