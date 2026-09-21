import type { VcsProviderKind } from "@shared/contracts";
import { env } from "../../infra/vcs-config.js";
import { JiraAdapter } from "../../adapters/issue-tracker/jira.js";
import { createConnectedPostgresRunRegistry } from "../../db/repositories/active-runs.js";
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
  sameHandle: (left, right) => left === right,
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

/**
 * Whether this deployment can build an issue tracker at all.
 *
 * Asked by the palette, which offers a block on the issue tracker capability
 * only where core can serve it. It lives here because this is the module that
 * builds the tracker: a caller that decided for itself would name the provider,
 * and the same question answered in two places is how a palette comes to offer
 * a block whose call then fails.
 *
 * True on every deployment that boots today, because the variables it reads are
 * required by the environment schema. It is written as a question anyway, so
 * the day the tracker becomes an integration (S12) there is one place to change.
 */
export function coreServesIssueTracker(): boolean {
  return Boolean(env.JIRA_BASE_URL && env.JIRA_API_TOKEN && env.JIRA_PROJECT_KEY);
}

export function createAdapters(
  vcsTarget?: VcsAdapterTarget,
  /**
   * What the run recorded about its integrations when it started. Given, the
   * messaging adapter refuses to deliver through a provider that moved under
   * the run; omitted, it follows the deployment as it is now, which is what a
   * notification wants.
   */
  integrationPins?: readonly IntegrationConnectionPin[],
): Adapters {
  const runRegistry = createConnectedPostgresRunRegistry();
  let vcs: VCSAdapter | undefined;
  // Which provider carries a message is the deployment's answer, read at each
  // call rather than here: disabling an integration is the kill switch an admin
  // reaches for, and an adapter built once would keep posting for as long as
  // this process lived.
  const messaging = messagingSender(integrationPins);
  const adapters = {
    issueTracker: new JiraAdapter({
      baseUrl: env.JIRA_BASE_URL,
      apiToken: env.JIRA_API_TOKEN,
      projectKey: env.JIRA_PROJECT_KEY,
    }),
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
