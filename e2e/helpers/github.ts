import { Octokit } from "@octokit/rest";
import { e2eEnv } from "../env.js";

const octokit = new Octokit({ auth: e2eEnv.E2E_GITHUB_TOKEN });
const ownerRepo = { owner: e2eEnv.E2E_GITHUB_OWNER, repo: e2eEnv.E2E_GITHUB_REPO };

export async function findPR(
  branchName: string,
): Promise<{ number: number; url: string } | null> {
  const { data } = await octokit.pulls.list({
    ...ownerRepo,
    head: `${e2eEnv.E2E_GITHUB_OWNER}:${branchName}`,
    state: "open",
  });
  if (data.length === 0) return null;
  return { number: data[0].number, url: data[0].html_url };
}

export async function getPRCommits(
  prNumber: number,
): Promise<Array<{ sha: string; message: string }>> {
  const { data } = await octokit.pulls.listCommits({
    ...ownerRepo,
    pull_number: prNumber,
  });
  return data.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
  }));
}

export async function addPRComment(
  prNumber: number,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({
    ...ownerRepo,
    issue_number: prNumber,
    body,
  });
}

export async function closePR(prNumber: number): Promise<void> {
  await octokit.pulls
    .update({
      ...ownerRepo,
      pull_number: prNumber,
      state: "closed",
    })
    .catch(() => {});
}

export async function deleteBranch(branchName: string): Promise<void> {
  await octokit.git
    .deleteRef({
      ...ownerRepo,
      ref: `heads/${branchName}`,
    })
    .catch(() => {});
}
