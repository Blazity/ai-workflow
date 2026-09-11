import type { VcsProviderKind } from "@shared/contracts";
import { env } from "../../infra/vcs-config.js";
import { JiraAdapter } from "../../adapters/issue-tracker/jira.js";
import { ChatSDKAdapter } from "../../adapters/messaging/chatsdk.js";
import { NoopMessagingAdapter } from "../../adapters/messaging/noop.js";
import { createConnectedPostgresRunRegistry } from "../../db/repositories/active-runs.js";
import { createVCS } from "../../adapters/vcs/create-vcs.js";
import { createRepositoryVCS } from "./vcs-runtime.js";
import type { IssueTrackerAdapter } from "../../adapters/issue-tracker/types.js";
import type { VCSAdapter } from "../../adapters/vcs/types.js";
import type { MessagingAdapter } from "../../adapters/messaging/types.js";
import type {
  RunRegistryAdapter,
  ThreadStore,
} from "../../adapters/run-registry/types.js";

export interface Adapters {
  issueTracker: IssueTrackerAdapter;
  vcs: VCSAdapter;
  messaging: MessagingAdapter;
  runRegistry: RunRegistryAdapter & ThreadStore;
}

export interface VcsAdapterTarget {
  provider: VcsProviderKind;
  repoPath: string;
  baseBranch: string;
}

export function createAdapters(vcsTarget?: VcsAdapterTarget): Adapters {
  const runRegistry = createConnectedPostgresRunRegistry();
  let vcs: VCSAdapter | undefined;
  const messaging: MessagingAdapter =
    env.CHAT_SDK_SLACK_TOKEN && env.CHAT_SDK_CHANNEL_ID
      ? new ChatSDKAdapter({
          slackToken: env.CHAT_SDK_SLACK_TOKEN,
          channelId: env.CHAT_SDK_CHANNEL_ID,
          botName: env.CHAT_SDK_BOT_NAME,
          jiraBaseUrl: env.JIRA_BASE_URL,
          threadStore: runRegistry,
        })
      : new NoopMessagingAdapter();
  const adapters = {
    issueTracker: new JiraAdapter({
      baseUrl: env.JIRA_BASE_URL,
      apiToken: env.JIRA_API_TOKEN,
      projectKey: env.JIRA_PROJECT_KEY,
    }),
    get vcs() {
      vcs ??= vcsTarget
        ? createRepositoryVCS({
            provider: vcsTarget.provider,
            repoPath: vcsTarget.repoPath,
            baseBranch: vcsTarget.baseBranch,
          })
        : createVCS();
      return vcs;
    },
    messaging,
    runRegistry,
  };
  return adapters;
}
