/**
 * Provider integrations: the adapter factory, VCS clients, bot identity and webhook normalization.
 *
 * The interface of this cluster: every module outside it consumes the cluster
 * through this file, and another services cluster may import nothing else here.
 */
export {
  createAdapters,
} from "./adapters.js";
export type {
  Adapters,
} from "./adapters.js";
export {
  buildOctokit,
} from "./github-auth.js";
export type {
  GitHubAppAuth,
} from "./github-auth.js";
export {
  normalizeGitLabMergeRequestEvent,
  projectMatchesConfiguredId,
  verifyGitLabWebhookToken,
} from "./gitlab-webhook.js";
export type {
  GitLabProject,
} from "./gitlab-webhook.js";
export {
  AI_WORKFLOW_COMMENT_MARKER,
  hasAiWorkflowCommentMarker,
  hasReviewLedgerFailureMarker,
  isReopenedLedgerThread,
  isReviewLedgerNote,
  isReviewLedgerWorkItem,
  markReviewLedgerReplyResolved,
  markReviewLedgerReplyStale,
  normalizeVcsLogin,
  readAnyReviewLedgerMarker,
  readReviewLedgerMarker,
  resolveVcsBotLogin,
  reviewLedgerFailureMarker,
  reviewLedgerMarker,
  vcsLoginsMatch,
} from "./vcs-bot-identity.js";
export {
  getVcsBotLogin,
} from "./vcs-bot-login.js";
export {
  createRepositoryVCS,
} from "./vcs-runtime.js";
export type {
  RepositoryVcsRuntime,
} from "./vcs-runtime.js";
