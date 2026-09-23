import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Reads, from git, where each changelog entry came from: the commit that added
 * the file, the pull request that brought that commit to main, and what both
 * changed. Git answers everything except a pull request author's GitHub
 * login, which only the GitHub API knows; that one lookup goes through `gh`.
 */

const execFileAsync = promisify(execFile);

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<string>;

export const runCommand: CommandRunner = async (command, args, cwd) => {
  const { stdout } = await execFileAsync(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
};

export const UNRELEASED_DIR = "changelog/unreleased";

export interface EntryOrigin {
  fileName: string;
  /** The commit that added the entry file. */
  commitSha?: string;
  commitSubject?: string;
  commitPaths: string[];
  /** The pull request that brought that commit to main, when one did. */
  pullRequest?: number;
  pullRequestPaths: string[];
}

const MERGE_SUBJECT = /^Merge pull request #(\d+)\b/u;
const SQUASH_SUBJECT = /\(#(\d+)\)\s*$/u;

function lines(output: string): string[] {
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function pullRequestOfSubject(subject: string): number | undefined {
  const match = MERGE_SUBJECT.exec(subject) ?? SQUASH_SUBJECT.exec(subject);
  return match ? Number(match[1]) : undefined;
}

/**
 * Traces every named entry file as it stood at `ref` (the main commit being
 * collated). An entry git cannot trace keeps empty evidence rather than
 * failing the release: it lands in Other with no pull request link.
 */
export async function traceEntries(options: {
  root: string;
  ref: string;
  fileNames: readonly string[];
  run?: CommandRunner;
}): Promise<EntryOrigin[]> {
  const run = options.run ?? runCommand;
  const git = (...args: string[]) => run("git", args, options.root);
  const firstParent = new Set(lines(await git("rev-list", "--first-parent", options.ref)));

  const origins: EntryOrigin[] = [];
  for (const fileName of options.fileNames) {
    const origin: EntryOrigin = { commitPaths: [], fileName, pullRequestPaths: [] };
    origins.push(origin);

    const added = lines(
      await git("log", options.ref, "--diff-filter=A", "--format=%H", "-1", "--", `${UNRELEASED_DIR}/${fileName}`),
    )[0];
    if (!added) continue;
    origin.commitSha = added;
    const [subject = "", ...paths] = (await git("show", "--no-renames", "--name-only", "--format=%s", added))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    origin.commitSubject = subject;
    origin.commitPaths = paths;

    // The commit that landed on main: the add commit itself when it sits on
    // main's first-parent line, otherwise the oldest first-parent commit that
    // descends from it, which is the pull request's merge commit.
    let landed: string | undefined = firstParent.has(added) ? added : undefined;
    if (!landed) {
      landed = lines(await git("rev-list", "--ancestry-path", `${added}..${options.ref}`))
        .findLast((sha) => firstParent.has(sha));
    }
    if (!landed) continue;

    const [landedSubject = "", ...parents] = lines(await git("show", "-s", "--format=%s%n%P", landed))
      .flatMap((line, index) => (index === 0 ? [line] : line.split(" ")));
    origin.pullRequest = pullRequestOfSubject(landedSubject);
    if (origin.pullRequest === undefined) continue;
    origin.pullRequestPaths =
      parents.length > 1
        ? lines(await git("diff", "--no-renames", "--name-only", parents[0], landed))
        : lines(await git("show", "--no-renames", "--name-only", "--format=", landed));
  }
  return origins;
}

/** Every version-shaped tag in the repository. */
export async function listTags(root: string, run: CommandRunner = runCommand): Promise<string[]> {
  return lines(await run("git", ["tag", "--list", "v*"], root));
}

/**
 * GitHub logins of pull request authors, one API call per pull request.
 * A lookup that fails leaves the author out; the caller logs the reason.
 */
export async function pullRequestAuthors(options: {
  root: string;
  repository: string;
  numbers: Iterable<number>;
  run?: CommandRunner;
  log?: (message: string) => void;
}): Promise<Map<number, string>> {
  const run = options.run ?? runCommand;
  const authors = new Map<number, string>();
  for (const number of new Set(options.numbers)) {
    try {
      const login = (
        await run("gh", ["api", `repos/${options.repository}/pulls/${number}`, "--jq", ".user.login"], options.root)
      ).trim();
      if (login) authors.set(number, login);
    } catch (error) {
      options.log?.(`changelog: could not read the author of #${number}: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  return authors;
}
