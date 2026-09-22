import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { repoMemoryComparisonKey } from "../../memory/repo-memory.js";
import { repoSubjectKey } from "../support/subject-key.js";

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.get>>;

/**
 * A cloned repository is untrusted input, so the manifest read is bounded rather
 * than streamed whole. Sized well above a realistic package.json (this repo's
 * largest is about 3 KiB) because a cap that bites disables seeding for a
 * legitimate repository, and an oversized file is read as unusable rather than
 * parsed from its head.
 */
const MAX_PACKAGE_JSON_BYTES = 16 * 1024;

/** The only scripts a fact may be derived from, and the only names a stale fact
 * may be retracted for. Order is the order facts are emitted in. */
const SCRIPT_KEYS = ["build", "test", "lint", "typecheck", "check", "format"] as const;
type ScriptKey = (typeof SCRIPT_KEYS)[number];

const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;
type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

/** First match wins, so a repository carrying two lockfiles resolves the same
 * way on every run instead of on directory order. */
const LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManagerName }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lockb", manager: "bun" },
];

const SCRIPT_FACT_LEAD: Record<ScriptKey, string> = {
  build: "Run the build with",
  test: "Run tests with",
  lint: "Run lint with",
  typecheck: "Run typecheck with",
  check: "Run check with",
  format: "Run format with",
};

/**
 * Every script fact this step can render, keyed the way the memory format itself
 * decides two items are the same item, and mapped to the script each one names.
 *
 * Retraction matches against these renders rather than against a general command
 * pattern, because only an item this step could have written may be retracted by
 * it. A fact the distill step worded for itself is knowledge no derivation can
 * reproduce, and nothing brings it back: the create path fires only when the
 * whole document is absent, and the distill prompt forbids restating what is
 * already known. The package manager fact has no entry because it names no
 * script, so it can never be proven stale here.
 */
const SEED_SCRIPT_FACT_KEYS: ReadonlyMap<string, ScriptKey> = new Map(
  PACKAGE_MANAGERS.flatMap((manager) =>
    SCRIPT_KEYS.map((key): [string, ScriptKey] => [
      repoMemoryComparisonKey(renderScriptFact(manager, key)),
      key,
    ]),
  ),
);

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export interface SeedRepoMemoryInput {
  sandboxId: string;
  runId: string;
  /**
   * Passed in from the trusted manifest the sandbox manager authored, never read
   * back out of the sandbox. Retraction decides on the branch fields below, and
   * on the discovery-promotion path a research agent has already run in that
   * sandbox, so its copy of the manifest is a file agent code could have
   * rewritten. The caller holds the original in memory, so the destructive
   * decision does not have to trust the workspace at all.
   */
  repositories: Array<{
    provider: string;
    repoPath: string;
    localPath: string;
    /** The ref the manifest says this workspace checked out. */
    branchName: string;
    /**
     * The ref a fact may be retracted from, as the manifest recorded it. That is
     * the repository's default branch everywhere except a pr_trigger run, where
     * the provisioning input carries the pull request's base ref instead, so a
     * pull request onto `develop` records `develop` here. Harmless only because a
     * pr_trigger checkout always carries an owned branch as well, which keeps the
     * pruner off it whatever this field says.
     */
    defaultBranch: string;
    /**
     * The workflow-owned branch this repository carries, or null when it carries
     * none. Recorded apart from `branchName` because a producer may clone the
     * owned branch and still record the default branch in `branchName`: the
     * discovery attach does exactly that. Nothing reachable today sends an
     * owned-branch repository through that attach, so this field guards against
     * drift rather than standing between a live pull request head and a deletion.
     */
    workflowOwnedBranch: string | null;
  }>;
}

export interface SeedRepoMemoryResult {
  /** Facts documents created, at most one per repository. */
  seeded: number;
  /** Facts documents rewritten with fewer items. */
  pruned: number;
  /**
   * Why this deployment's memory provider could not answer, or absent when it
   * did. Added in S13 and optional, so a result stored before it existed still
   * replays; absent means memory answered, never that nothing was tried.
   */
  unavailable?: string;
}

/** What the derivation needs out of a package.json, and nothing else: no value
 * read from the file is carried further than this. */
interface PackageManifest {
  /** Only the keys in SCRIPT_KEYS that the file declares. */
  scripts: Set<ScriptKey>;
  /** The manager named by the packageManager field, when it names a known one. */
  declaredManager: PackageManagerName | null;
  workspaces: boolean;
}

/**
 * Deterministic, LLM-free seed so a repository carries useful facts before its
 * first successful run, plus a retraction pass for facts naming a package script
 * that no longer exists. Best effort in the same sense as every other memory
 * step: the workspace is already provisioned when this runs, so nothing here may
 * throw, and a failure only costs this run's head start.
 */
export async function seedRepoMemoryStep(
  input: SeedRepoMemoryInput,
): Promise<SeedRepoMemoryResult> {
  "use step";
  // Hoisted so a failure part way through a multi-repository manifest still
  // reports what the earlier repositories already got.
  let seeded = 0;
  let pruned = 0;
  /** The first refusal any memory call answered, reported on the result. */
  let unavailable: string | undefined;
  const finish = (): SeedRepoMemoryResult => ({
    seeded,
    pruned,
    ...(unavailable === undefined ? {} : { unavailable }),
  });
  try {
    if (input.repositories.length === 0) return finish();
    const { logger } = await import("../../infra/logger.js");
    const log = logger.child({
      sandboxId: input.sandboxId,
      runId: input.runId,
      step: "seedRepoMemory",
    });
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
    const { activeMemory } = await import("../support/memory-runtime.js");
    const memory = await activeMemory();
    if (memory.refusal) {
      // Before the sandbox is touched. Deriving facts runs commands in a
      // checkout, and doing that for a provider that cannot take them spends a
      // run's time on nothing.
      unavailable = memory.refusal.detail;
      log.warn(
        { code: memory.refusal.code, detail: memory.refusal.detail },
        "memory_provider_unavailable",
      );
      return finish();
    }
    const sandbox = await Sandbox.get({
      sandboxId: input.sandboxId,
      ...getSandboxCredentials(),
    });

    for (const repository of input.repositories) {
      // Provider-qualified through repoSubjectKey only: nothing read out of the
      // repository ever addresses a document.
      const subjectKey = repoSubjectKey(repository.provider, repository.repoPath);
      const label = `${repository.provider}:${repository.repoPath}`;
      // Per repository, not per step. Every repository here is independent (no
      // shared model call, no shared document), so a checkout whose read rejects
      // must cost only its own seed and not every repository listed after it.
      try {
        const read = await readCappedFile(
          sandbox,
          `${repository.localPath}/package.json`,
          MAX_PACKAGE_JSON_BYTES,
        );
        // No script list means nothing can be derived and, just as importantly,
        // nothing can be proven absent, so the pruner is skipped too. Absent and
        // unreadable part ways only in how loudly they say so: a repository with
        // no package.json is an ordinary Go, Python, Rust or docs repository and
        // is permanently in that state, so warning about it once per run for the
        // life of the repository buries the reading that is a real anomaly.
        if (read.status === "absent") {
          log.info({ repo: label }, "repo_memory_seed_manifest_absent");
          continue;
        }
        const manifest = read.status === "text" ? parsePackageManifest(read.text) : null;
        if (!manifest) {
          // Present and unreadable: past the read cap, not JSON, not an object,
          // or carrying a malformed scripts field. That is the anomaly.
          log.warn({ repo: label }, "repo_memory_seed_manifest_unusable");
          continue;
        }

        const subject = { key: subjectKey, label: repository.repoPath };
        const stored = await memory.recall({ subject, scope: { kind: "facts" } });
        if (!stored.ok) {
          unavailable = stored.detail;
          log.warn(
            { repo: label, code: stored.code, detail: stored.detail },
            "memory_provider_unavailable",
          );
          continue;
        }
        if (!stored.held) {
          const texts = await deriveFacts(sandbox, repository.localPath, manifest);
          if (texts.length === 0) continue;
          // `onlyIfEmpty` is create-only, and that is the whole rule: a
          // document that appears between the read and the write belongs to
          // whoever wrote it, because an LLM-distilled document is strictly
          // better than this derivation. `derived` marks these so a provider
          // under cap pressure gives up model prose first: nothing else can
          // restate a derived fact, since this path fires only when the whole
          // document is absent and the distill prompt forbids restating what is
          // already known.
          const created = await memory.observe({
            subject,
            scope: { kind: "facts" },
            runId: input.runId,
            // Repo scoped, so no ticket owns this document.
            ticketKey: null,
            observation: {
              kind: "items",
              learned: texts,
              refuted: [],
              derived: true,
              onlyIfEmpty: true,
            },
          });
          if (!created.ok) {
            unavailable = created.detail;
            log.warn(
              { repo: label, code: created.code, detail: created.detail },
              "repo_memory_seed_refused",
            );
            continue;
          }
          if (created.stored) seeded += 1;
          continue;
        }

        // Seeding happens from any ref, because a document that does not exist
        // yet cannot lose anything. Retraction writes against memory every future
        // run reads, so it may only run from the ref that defines the repository.
        // A pull request head checkout renaming a script would otherwise delete a
        // fact about the default branch before the pull request merged, and a
        // pull request closed unmerged would leave it deleted for good.
        if (!isDefaultBranchCheckout(repository)) {
          // Two independent causes reach this line, and a pr_trigger skip, a
          // ticket re-pickup skip and a plan_approved-with-ownership skip are not
          // the same finding, so the refs are logged rather than left to be
          // guessed from the event name.
          log.info(
            {
              repo: label,
              branchName: repository.branchName,
              defaultBranch: repository.defaultBranch,
              ownedBranch: repository.workflowOwnedBranch,
            },
            "repo_memory_prune_skipped_off_default_branch",
          );
          continue;
        }

        // Retraction as an observation: every entry this step could have
        // written that names a script the manifest no longer declares is
        // reported as refuted, and the provider forgets what matches. That is
        // the same rule `survivingItems` applied, from the other side: only an
        // entry this step could have written may be retracted by it, so a fact
        // the distill worded for itself, and an entry no parser here can read,
        // are both kept.
        const refuted = staleScriptFacts(stored.entries, manifest.scripts);
        if (refuted.length === 0) continue;
        const write = await memory.observe({
          subject,
          scope: { kind: "facts" },
          runId: input.runId,
          ticketKey: null,
          observation: { kind: "items", learned: [], refuted, derived: true },
        });
        if (!write.ok) {
          unavailable = write.detail;
          log.warn(
            { repo: label, code: write.code, detail: write.detail },
            "repo_memory_prune_refused",
          );
          continue;
        }
        if (write.stored) pruned += 1;
      } catch (err) {
        log.warn(
          { repo: label, err: errorMessage(err) },
          "repo_memory_seed_repository_failed",
        );
      }
    }

    if (seeded > 0 || pruned > 0) log.info({ seeded, pruned }, "repo_memory_seeded");
    return finish();
  } catch (err) {
    // The reporting path is itself wrapped: a failed logger import here would
    // otherwise escape a step whose whole contract is that it cannot throw.
    try {
      const { logger } = await import("../../infra/logger.js");
      logger.warn(
        {
          sandboxId: input.sandboxId,
          runId: input.runId,
          step: "seedRepoMemory",
          err: errorMessage(err),
        },
        "repo_memory_seed_failed",
      );
    } catch {
      // Nothing left to report with.
    }
    return finish();
  }
}
seedRepoMemoryStep.maxRetries = 0;

/**
 * Package manager first, then one fact per known script, then the workspace
 * marker. A script fact without a manager is a guess about how to invoke it, so
 * an undetectable manager suppresses both.
 */
async function deriveFacts(
  sandbox: SandboxInstance,
  localPath: string,
  manifest: PackageManifest,
): Promise<string[]> {
  // The declared field wins: a lockfile can outlive the manager that wrote it,
  // and packageManager is the repository saying which one it means.
  let manager = manifest.declaredManager;
  if (manager === null) {
    for (const lockfile of LOCKFILES) {
      if (await fileExists(sandbox, `${localPath}/${lockfile.file}`)) {
        manager = lockfile.manager;
        break;
      }
    }
  }

  const texts: string[] = [];
  if (manager !== null) {
    texts.push(`Package manager is ${manager}.`);
    for (const key of SCRIPT_KEYS) {
      if (manifest.scripts.has(key)) texts.push(renderScriptFact(manager, key));
    }
  }
  if (manifest.workspaces || (await fileExists(sandbox, `${localPath}/pnpm-workspace.yaml`))) {
    texts.push("This repository is a workspace monorepo.");
  }
  return texts;
}

/**
 * The single place a script fact is spelled. Derivation renders through it and
 * the retraction set above is built from it, so the two cannot drift into a
 * state where this step writes a fact it would no longer recognise as its own.
 */
function renderScriptFact(manager: PackageManagerName, key: ScriptKey): string {
  return `${SCRIPT_FACT_LEAD[key]}: ${manager} ${key}`;
}

/** Never trust the shape: this is a file from a cloned repository, so anything
 * that is not a JSON object degrades to no facts rather than to a crash. */
function parsePackageManifest(raw: string): PackageManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const scripts = new Set<ScriptKey>();
  const rawScripts = record.scripts;
  // A missing scripts key legitimately means the repository declares none, and
  // retracting against that is correct. A present but malformed one ("build", 5,
  // []) is a manifest this parser could not read, and an unreadable manifest
  // proves no absence, so it keeps everything rather than emptying the set.
  if (rawScripts !== undefined) {
    if (rawScripts === null || typeof rawScripts !== "object" || Array.isArray(rawScripts)) {
      return null;
    }
    for (const key of SCRIPT_KEYS) {
      // Only the six known keys are ever looked up, so no name out of the file
      // reaches a fact, and only a string value counts as a declared script.
      if (typeof (rawScripts as Record<string, unknown>)[key] === "string") scripts.add(key);
    }
  }
  return {
    scripts,
    declaredManager: declaredPackageManager(record.packageManager),
    workspaces: Array.isArray(record.workspaces) && record.workspaces.length > 0,
  };
}

/** "pnpm@9.0.0" and a bare "pnpm" name the same manager. A value naming anything
 * else is treated as absent, so detection falls back to the lockfile rather than
 * putting an unknown word into a command. */
function declaredPackageManager(raw: unknown): PackageManagerName | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().split("@")[0]?.trim().toLowerCase();
  return PACKAGE_MANAGERS.find((manager) => manager === name) ?? null;
}

/**
 * The whole retraction rule, and it fails towards keeping: deleting a true fact
 * costs durable knowledge for every future run, keeping a stale one costs a line
 * of prompt. An entry is retracted only when it is one of this step's own script
 * facts and the manifest no longer declares that script.
 *
 * It returns the entries to retract rather than the ones to keep, because the
 * provider is what forgets now and a retraction is what a run observes. The
 * rule is unchanged: anything this step did not write is not this step's to
 * judge, so a fact the distill step worded itself, and an entry no parser here
 * can read at all, are both left alone.
 */
function staleScriptFacts(
  entries: readonly { text: string }[],
  scripts: ReadonlySet<ScriptKey>,
): string[] {
  const stale: string[] = [];
  for (const entry of entries) {
    const named = SEED_SCRIPT_FACT_KEYS.get(repoMemoryComparisonKey(entry.text));
    if (named !== undefined && !scripts.has(named)) stale.push(entry.text);
  }
  return stale;
}

/**
 * Whether this repository's working tree is the ref that defines it, and the
 * whole gate on the destructive half of this step.
 *
 * `branchName` is what decides today: every producer of a manifest entry encodes
 * an owned branch into it, pr_trigger and the write promotion included, so a pull
 * request head checkout already differs from the default branch by that field
 * alone. The owned branch is tested as well so this gate does not quietly depend
 * on every future producer remembering to do that, and because one producer
 * already comes close: the discovery attach records `branchName: defaultBranch`
 * for every repository it attaches while cloning `workflowOwnedBranch` instead.
 * No reachable configuration sends an owned-branch repository through that
 * attach, because a repository carrying one is selected before discovery can
 * propose mandatory repositories, so the second test guards a shape that does not
 * occur rather than one that does. Reading an owned branch as "not the default
 * branch" is correct either way: it is a branch this workflow pushed to.
 */
function isDefaultBranchCheckout(repository: {
  branchName: string;
  defaultBranch: string;
  workflowOwnedBranch: string | null;
}): boolean {
  return (
    repository.workflowOwnedBranch === null &&
    repository.branchName === repository.defaultBranch
  );
}

/**
 * Presence only. Lockfiles run to megabytes and nothing here reads their
 * contents, so the stream is dropped rather than consumed.
 */
async function fileExists(sandbox: SandboxInstance, path: string): Promise<boolean> {
  const stream = await sandbox.readFile({ path });
  if (stream === null) return false;
  (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  return true;
}

/**
 * A file that is simply not there and one that is there and cannot be read are
 * different findings, and only the second is worth an anomaly signal, so they
 * are reported apart rather than folded into one null.
 */
type CappedRead = { status: "absent" } | { status: "oversized" } | { status: "text"; text: string };

/**
 * Bounded read of an untrusted file. Unlike the memory document reader this one
 * discards an oversized file instead of keeping its head: half a JSON object is
 * not a package.json, and parsing it would be worse than reading nothing.
 * Buffer is never named, because this module is reachable from workflow scope.
 */
async function readCappedFile(
  sandbox: SandboxInstance,
  path: string,
  maxBytes: number,
): Promise<CappedRead> {
  const stream = await sandbox.readFile({ path });
  if (stream === null) return { status: "absent" };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    // Buffer is a Uint8Array subclass, so the byte branch covers both shapes.
    const bytes = typeof chunk === "string" ? utf8Encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    size += bytes.byteLength;
    if (size > maxBytes) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      return { status: "oversized" };
    }
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "text", text: utf8Decoder.decode(joined) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
