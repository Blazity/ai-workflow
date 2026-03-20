import { env } from "../../env.js";
import { JiraAdapter } from "../adapters/issue-tracker/jira.js";
import { GitHubAdapter } from "../adapters/vcs/github.js";
import type { IssueTrackerAdapter } from "../adapters/issue-tracker/types.js";
import type { VCSAdapter } from "../adapters/vcs/types.js";

export interface StepAdapters {
  issueTracker: IssueTrackerAdapter;
  vcs: VCSAdapter;
}

export function createStepAdapters(): StepAdapters {
  return {
    issueTracker: new JiraAdapter({
      baseUrl: env.JIRA_BASE_URL,
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
      projectKey: env.JIRA_PROJECT_KEY,
    }),
    vcs: new GitHubAdapter({
      token: env.GITHUB_TOKEN,
      owner: env.GITHUB_OWNER,
      repo: env.GITHUB_REPO,
      baseBranch: env.GITHUB_BASE_BRANCH,
    }),
  };
}
