import { env } from "../../env.js";
import { JiraAdapter } from "../adapters/issue-tracker/jira.js";
import { ChatSDKAdapter } from "../adapters/messaging/chatsdk.js";
import { NoopMessagingAdapter } from "../adapters/messaging/noop.js";
import { UpstashRunRegistry } from "../adapters/run-registry/upstash.js";
import { createVCS } from "./create-vcs.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { VCSAdapter } from "../adapters/vcs/types.js";
import type { MessagingAdapter } from "../adapters/messaging/types.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";

export interface StepAdapters {
  issueTracker: IssueTrackerAdapter;
  vcs: VCSAdapter;
  messaging: MessagingAdapter;
  runRegistry: RunRegistryAdapter;
}

export function createStepAdapters(): StepAdapters {
  const runRegistry = new UpstashRunRegistry({
    url: env.AI_WORKFLOW_KV_REST_API_URL,
    token: env.AI_WORKFLOW_KV_REST_API_TOKEN,
  });
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
  return {
    issueTracker: new JiraAdapter({
      baseUrl: env.JIRA_BASE_URL,
      apiToken: env.JIRA_API_TOKEN,
      projectKey: env.JIRA_PROJECT_KEY,
    }),
    vcs: createVCS(),
    messaging,
    runRegistry,
  };
}
