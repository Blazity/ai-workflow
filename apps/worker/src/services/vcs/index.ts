/** Provider webhook normalization owned by the VCS service cluster. */
export {
  normalizeGitLabMergeRequestEvent,
  projectMatchesConfiguredId,
  verifyGitLabWebhookToken,
} from "./gitlab-webhook.js";
export type {
  GitLabProject,
} from "./gitlab-webhook.js";
export { getVcsBotLogin } from "./vcs-bot-login.js";
