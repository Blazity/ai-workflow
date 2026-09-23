import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A throwaway git repository shaped like ai-workflow's main: feature branches
 * merged with "Merge pull request #N" commits, entries under
 * changelog/unreleased/, a CHANGELOG.md. The tests run real git against it.
 */
export interface TestRepository {
  root: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string) => Promise<void>;
  commit: (subject: string, files: Record<string, string>) => Promise<string>;
  /** Branches off main, commits each step, merges back as pull request `number`. Returns the merge sha. */
  mergePullRequest: (number: number, steps: Array<{ subject: string; files: Record<string, string> }>) => Promise<string>;
  cleanup: () => Promise<void>;
}

export const CHANGELOG_INTRO = "# Changelog\n\nWhat changed for people using AI Workflow, newest first.\n";

export async function createTestRepository(): Promise<TestRepository> {
  const root = await mkdtemp(join(tmpdir(), "changelog-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");

  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const commit = async (subject: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) await write(path, content);
    git("add", "--all");
    git("commit", "--quiet", "--allow-empty", "-m", subject);
    return git("rev-parse", "HEAD");
  };

  await commit("chore(repo): start", {
    "CHANGELOG.md": CHANGELOG_INTRO,
    "changelog/README.md": "# Changelog entries\n\n## Tone rule\n\nDescribe what a user can do now.\n\n## Why\n\nBecause.\n",
    "changelog/unreleased/.gitkeep": "",
  });

  let branchCount = 0;
  const mergePullRequest: TestRepository["mergePullRequest"] = async (number, steps) => {
    branchCount += 1;
    const branch = `feat/branch-${branchCount}`;
    git("switch", "--quiet", "-c", branch);
    for (const step of steps) await commit(step.subject, step.files);
    git("switch", "--quiet", "main");
    git("merge", "--quiet", "--no-ff", branch, "-m", `Merge pull request #${number} from Blazity/${branch}`);
    return git("rev-parse", "HEAD");
  };

  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    commit,
    git,
    mergePullRequest,
    root,
    write,
  };
}
