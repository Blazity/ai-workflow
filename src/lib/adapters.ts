import { env } from "../../env.js";
import { JiraAdapter } from "../adapters/issue-tracker/jira.js";
import { ChatSDKAdapter } from "../adapters/messaging/chatsdk.js";
import { UpstashRunRegistry } from "../adapters/run-registry/upstash.js";
import { createVCS } from "./create-vcs.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { VCSAdapter } from "../adapters/vcs/types.js";
import type { MessagingAdapter } from "../adapters/messaging/types.js";
import type {
  RunRegistryAdapter,
  ThreadStore,
} from "../adapters/run-registry/types.js";

export interface Adapters {
  issueTracker: IssueTrackerAdapter;
  vcs: VCSAdapter;
  messaging: MessagingAdapter;
  runRegistry: RunRegistryAdapter & ThreadStore;
}

export function createAdapters(): Adapters {
  const runRegistry = new UpstashRunRegistry({
    url: env.AI_WORKFLOW_KV_REST_API_URL,
    token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
  });
  return {
    issueTracker: new JiraAdapter({
      baseUrl: env.JIRA_BASE_URL,
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
      projectKey: env.JIRA_PROJECT_KEY,
    }),
    vcs: createVCS(),
    messaging: new ChatSDKAdapter({
      slackToken: env.CHAT_SDK_SLACK_TOKEN,
      channelId: env.CHAT_SDK_CHANNEL_ID,
      botName: env.CHAT_SDK_BOT_NAME,
      jiraBaseUrl: env.JIRA_BASE_URL,
      threadStore: runRegistry,
    }),
    runRegistry,
  };
}
