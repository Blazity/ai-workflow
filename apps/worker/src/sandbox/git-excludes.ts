interface ExcludesCommandResult {
  exitCode: number;
  stdout(): Promise<string>;
  stderr?(): Promise<string>;
}

/** Generic over the command result so each caller keeps its own result type and
 * can hand it to its own requireCommand helper. */
export interface RepositoryExcludesSandbox<
  R extends ExcludesCommandResult = ExcludesCommandResult,
> {
  runCommand(command: string, args: string[]): Promise<R>;
  writeFiles(files: Array<{ path: string; content: Buffer }>): Promise<unknown>;
}

/**
 * Stable by contract, not by accident: a clarification snapshot preserves each
 * checkout's .git/config, so a restored sandbox still points core.excludesFile at
 * this exact path, and the path must keep matching none of the credential scrub
 * globs in clarification-snapshot-steps.ts (agent-env*.sh, *arthur*credential*,
 * *tracer*credential*, .aiw-clarification-credential-patterns-*).
 */
export const REPOSITORY_EXCLUDES_PATH = "/tmp/aiw-primary-git-excludes";

/**
 * Runtime excludes shared by every checkout of a workspace. All three patterns
 * are anchored to a worktree root, so the sandbox-owned manifest and the nested
 * secondary checkouts stay invisible in the root checkout while being harmless
 * in a repository under repos/. `/blazebot/memory/` is the agent's session
 * memory document: the platform stores it outside the repository and restores it
 * between runs, so no checkout may ever offer it for commit.
 */
export const REPOSITORY_EXCLUDES = "/aiw-repos.json\n/repos/\n/blazebot/memory/\n";

/** Written once per sandbox; the content is identical for every checkout. */
export async function writeRepositoryExcludesFile(
  sandbox: RepositoryExcludesSandbox,
): Promise<void> {
  await sandbox.writeFiles([
    { path: REPOSITORY_EXCLUDES_PATH, content: Buffer.from(REPOSITORY_EXCLUDES) },
  ]);
}

export function configureRepositoryExcludes<R extends ExcludesCommandResult>(
  sandbox: RepositoryExcludesSandbox<R>,
  localPath: string,
): Promise<R> {
  return sandbox.runCommand("git", [
    "-C",
    localPath,
    "config",
    "--local",
    "core.excludesFile",
    REPOSITORY_EXCLUDES_PATH,
  ]);
}

/**
 * Defense in depth, not a guarantee. Excludes only hide the document from
 * `git status`; `git add -f` still stages it, and this hook rejects a commit that
 * stages a memory path HEAD does not already track. A path HEAD does track is a
 * legacy committed document, and those must keep committing exactly as before,
 * otherwise the commit guard would demand a commit that the hook refuses and the
 * run would loop.
 *
 * Known ways around the hook: `git commit --no-verify`, a repository-owned
 * `core.hooksPath` (husky and lefthook set it during install, which makes
 * .git/hooks unreadable to git), a hook the same install overwrites, and plain
 * deletion of the file. The authoritative guard is therefore the publication
 * gate in trusted-workspace-publisher.ts, which the agent cannot reach.
 *
 * Shell notes: `set -f` stops a staged path with glob metacharacters from being
 * expanded, iteration keeps IFS at newline, and a status flag replaces an exit
 * from a `while read` pipeline whose subshell exit code would be discarded. The
 * ls-tree probe is silenced because an unborn HEAD writes to stderr; empty output
 * still means "not tracked", so the check stays fail closed.
 */
export const MEMORY_PRE_COMMIT_HOOK = `#!/bin/sh
set -f
staged=$(git diff --cached --name-only -- 'blazebot/memory/')
[ -z "$staged" ] && exit 0
status=0
saved_ifs=$IFS
IFS='
'
for file in $staged; do
  if [ -z "$(git ls-tree --name-only HEAD -- "$file" 2>/dev/null)" ]; then
    echo "blazebot/memory/ is managed by the platform and must not be committed." >&2
    echo "Unstage it and commit again: git restore --staged '$file'" >&2
    status=1
  fi
done
IFS=$saved_ifs
exit $status
`;

export type MemoryCommitHookOutcome =
  /** Installed and executable; git reads .git/hooks. */
  | { kind: "installed" }
  /** A repository-owned hook was already there and owns that file. */
  | { kind: "existing" }
  /**
   * Installed, but core.hooksPath points git somewhere else, so git will not read
   * it unless the repository resets that setting. Install anyway and let the
   * caller report the shadowing.
   */
  | { kind: "shadowed"; hooksPath: string }
  /**
   * The hook could not be written or made executable. The hook is defense in
   * depth, not the authoritative guard, so the caller logs this and keeps
   * provisioning rather than failing the run.
   */
  | { kind: "failed"; reason: string };

/**
 * Never replaces an existing hook: a fresh checkout has none, and a repository
 * that ships one owns that file. Returns the outcome instead of logging, because
 * this module is reachable from workflow scope and must stay free of Node-only
 * imports. Installing is best effort: a failed write or chmod returns
 * {kind:"failed"} instead of throwing, because the publication gate stays
 * authoritative and memory must never block a run.
 */
export async function installMemoryCommitHook(
  sandbox: RepositoryExcludesSandbox,
  localPath: string,
): Promise<MemoryCommitHookOutcome> {
  const hookPath = `${localPath}/.git/hooks/pre-commit`;
  const existing = await sandbox.runCommand("test", ["-e", hookPath]);
  if (existing.exitCode === 0) return { kind: "existing" };
  try {
    await sandbox.runCommand("mkdir", ["-p", `${localPath}/.git/hooks`]);
    await sandbox.writeFiles([
      { path: hookPath, content: Buffer.from(MEMORY_PRE_COMMIT_HOOK) },
    ]);
    const executable = await sandbox.runCommand("chmod", ["+x", hookPath]);
    if (executable.exitCode !== 0) {
      return { kind: "failed", reason: `chmod +x exited ${executable.exitCode}` };
    }
  } catch (err) {
    return {
      kind: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const hooksPath = await sandbox.runCommand("git", [
    "-C",
    localPath,
    "config",
    "--get",
    "core.hooksPath",
  ]);
  const configured =
    hooksPath.exitCode === 0 ? (await hooksPath.stdout()).trim() : "";
  return configured ? { kind: "shadowed", hooksPath: configured } : { kind: "installed" };
}
