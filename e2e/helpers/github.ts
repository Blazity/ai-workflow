import { Octokit } from "@octokit/rest";
import { e2eEnv } from "../env.js";

const octokit = new Octokit({
  auth: e2eEnv.E2E_GITHUB_TOKEN,
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
});
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

export async function createBranch(
  branchName: string,
  baseBranch = "main",
): Promise<string> {
  const { data: ref } = await octokit.git.getRef({
    ...ownerRepo,
    ref: `heads/${baseBranch}`,
  });
  await octokit.git.createRef({
    ...ownerRepo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });
  return ref.object.sha;
}

export async function createOrUpdateFile(
  branch: string,
  filePath: string,
  content: string,
  message: string,
): Promise<string> {
  let fileSha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({
      ...ownerRepo,
      path: filePath,
      ref: branch,
    });
    if (!Array.isArray(data) && data.type === "file") {
      fileSha = data.sha;
    }
  } catch {
    // File doesn't exist yet
  }

  const { data } = await octokit.repos.createOrUpdateFileContents({
    ...ownerRepo,
    path: filePath,
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
    ...(fileSha ? { sha: fileSha } : {}),
  });
  return data.commit.sha!;
}

export async function openPR(
  branch: string,
  title: string,
  body = "",
): Promise<{ number: number; url: string }> {
  const { data } = await octokit.pulls.create({
    ...ownerRepo,
    head: branch,
    base: "main",
    title,
    body,
  });
  return { number: data.number, url: data.html_url };
}

export async function getPRFiles(
  prNumber: number,
): Promise<Array<{ filename: string; status: string }>> {
  const { data } = await octokit.pulls.listFiles({
    ...ownerRepo,
    pull_number: prNumber,
  });
  return data.map((f) => ({ filename: f.filename, status: f.status! }));
}

export async function isPRMergeable(prNumber: number): Promise<boolean | null> {
  const { data } = await octokit.pulls.get({
    ...ownerRepo,
    pull_number: prNumber,
  });
  return data.mergeable;
}

/** Read a file's text content from a branch. Returns null if not found. */
export async function getFileContent(
  branch: string,
  filePath: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({
      ...ownerRepo,
      path: filePath,
      ref: branch,
    });
    if (!Array.isArray(data) && data.type === "file") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

export async function deleteFile(
  branch: string,
  filePath: string,
  message: string,
): Promise<void> {
  try {
    const { data } = await octokit.repos.getContent({
      ...ownerRepo,
      path: filePath,
      ref: branch,
    });
    if (!Array.isArray(data) && data.type === "file") {
      await octokit.repos.deleteFile({
        ...ownerRepo,
        path: filePath,
        message,
        sha: data.sha,
        branch,
      });
    }
  } catch {
    // File doesn't exist, nothing to delete
  }
}
