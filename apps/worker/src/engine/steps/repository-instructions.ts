import {
  isRepositoryAccessible,
  repositoryCatalogKey,
  type RunRepositoryAccess,
  type WorkflowBlockType,
} from "@shared/contracts";
import {
  isRepositoryRulesVariable,
  REPOSITORY_RULES_SOURCE_PATH,
  REPOSITORY_RULES_VARIABLE_NAMES,
  substitutePromptVariables,
  usedVariables,
  type PromptVariableValues,
} from "@shared/prompts";
import { sliceUtf8Head, utf8Bytes } from "../../memory/content.js";
import {
  isValidWorkspaceLocalPath,
  workspaceManifestSchema,
  type WorkspaceManifest,
} from "../../sandbox/repo-workspace.js";
import type { EffectivePromptRepositorySource } from "../helpers/effective-prompt.js";

const INSTRUCTION_PATHS = ["AGENTS.md", "CLAUDE.md"] as const;
const MAX_REPOSITORY_INSTRUCTION_BYTES = 256 * 1024;
const AI_MEMORY_DIR = ".ai/memory";
/** No accepted name can contain a slash or "..", so no listed entry can walk
 * out of the memory directory it was listed from. */
const AI_MEMORY_NAME_PATTERN = /^[A-Za-z0-9._-]+\.md$/;
const MAX_AI_MEMORY_FILES = 10;
const MAX_AI_MEMORY_BYTES = 32 * 1024;
/** One budget for every repository's .ai/memory content in one invocation. The
 * per-file cap above bounds a single document; without this the ceiling is that
 * cap times the file cap times the manifest's repository cap. Twice the stored
 * memory budget in repo-memory-steps.ts because this corpus is hand written and
 * there is one of it per repository, where that path injects two documents per
 * repository plus the org ones. */
const MAX_AI_MEMORY_TOTAL_BYTES = 64 * 1024;
const MAX_AI_MEMORY_LISTING_CHARS = 64 * 1024;
const MAX_AI_MEMORY_LISTING_LINES = 500;
/** One directory listing, so a few seconds is generous, and every second here
 * is on the critical path before the agent starts, once per repository. */
const AI_MEMORY_LISTING_TIMEOUT_MS = 5_000;
/**
 * Per repository, on the rules the catalog holds, measured on the text AFTER
 * the run's variables are rendered into it. Measuring before would be a cap on
 * the stored draft rather than on what the prompt actually pays for, and a
 * single {{ticket_description}}-sized token can be the larger half of a short
 * rules document. Modest next to the 256 KiB instruction-file cap because rules
 * are typed into a box by a person, and deliberately a truncation rather than a
 * failure: rules must never be able to fail a run.
 */
const MAX_REPOSITORY_RULES_BYTES = 32 * 1024;
/**
 * Across every repository's rules in one compiled prompt, the same shape as
 * MAX_AI_MEMORY_TOTAL_BYTES above and for the same reason: without it the
 * ceiling is the per-repository cap times the manifest's repository cap. Twice
 * the .ai/memory budget, because rules are hand written by an operator who
 * meant them, where memory is distilled and expendable; four times the
 * per-repository cap, so the common manifest of one or two repositories can
 * never hit it and only a workspace of five or more mature rules documents
 * does. Past it, later repositories lose their section whole rather than being
 * cut: half a rules document still reads as a complete one.
 */
const MAX_REPOSITORY_RULES_TOTAL_BYTES = 128 * 1024;

/**
 * Reads the trusted workspace paths in repository order. Missing instruction
 * files are expected; an unreadable or oversized present file fails the
 * invocation instead of silently compiling a partial effective prompt.
 *
 * Hand-maintained notes under .ai/memory are read on the same channel but with
 * the opposite failure rule: absence is the normal case, so anything wrong with
 * them skips content and lets the invocation continue.
 *
 * The catalog's own rules ride here too, for `catalogRuleKeys` only. They are a
 * database read rather than a sandbox read, and they are loaded inside THIS
 * step rather than a new one on purpose: a new "use step" call inserted into
 * the invocation path adds a journal entry that a run already suspended in this
 * workflow has no record of, and this step already runs exactly where the
 * rules belong (behind `includeRepositoryInstructions`, once per compiled
 * prompt, with the trusted manifest in hand).
 */
export async function loadRepositoryInstructionSources(
  sandboxId: string,
  manifest: WorkspaceManifest,
  /** The run's frozen ENABLE_REPO_MEMORY. Optional so a journal written before
   *  this parameter existed still replays; absent reads as off, which is the
   *  registry default and the behaviour before .ai/memory existed. */
  enableRepoMemory?: boolean,
  /** `provider:owner/name` for every repository whose catalog rules this
   *  invocation may inject: the run's frozen access list, already intersected
   *  with the checkout by the caller. Optional for the same replay reason as
   *  the parameter above; absent injects no rules at all, which is what this
   *  step did before the catalog's rules reached a prompt. */
  catalogRuleKeys?: readonly string[],
  /** The run's identity variables, for rendering into the rules. Optional for
   *  the same replay reason; absent renders nothing, leaving every token
   *  standing. Rendering happens HERE rather than at the call site so the
   *  journal stores the text that actually reached the model, and so the cap
   *  below and its log can sit where pino is allowed to run. */
  ruleVariables?: PromptVariableValues,
): Promise<EffectivePromptRepositorySource[]> {
  "use step";
  const trustedManifest = validateRepositoryInstructionManifest(manifest);
  const rulesByKey = await loadRepositoryCatalogRules(catalogRuleKeys ?? []);
  const ruleBudget = {
    remaining: MAX_REPOSITORY_RULES_TOTAL_BYTES,
    /** repository key to bytes injected, for the one log line below. */
    trimmed: new Map<string, number>(),
    dropped: [] as string[],
    unresolved: new Set<string>(),
  };
  const [{ Sandbox }, { getSandboxCredentials }] = await Promise.all([
    import("@vercel/sandbox"),
    import("../../sandbox/credentials.js"),
  ]);
  const sandbox = await Sandbox.get({
    sandboxId,
    ...getSandboxCredentials(),
  });
  const sources: EffectivePromptRepositorySource[] = [];
  let memoryBytes = 0;
  /** Once the budget is spent nothing further is injected, rather than letting
   * whichever later document happens to be small jump the queue. */
  let memoryExhausted = false;
  let droppedMemoryDocuments = 0;
  const droppedMemoryRepositories: string[] = [];
  /** Counting a drop is separate from latching, because only one of the two
   * reasons for dropping is a statement about the budget being spent. */
  const countDroppedMemoryDocument = (repoPath: string): void => {
    droppedMemoryDocuments += 1;
    if (!droppedMemoryRepositories.includes(repoPath)) {
      droppedMemoryRepositories.push(repoPath);
    }
  };

  for (const repository of trustedManifest.repositories) {
    for (const path of INSTRUCTION_PATHS) {
      const absolutePath = `${repository.localPath}/${path}`;
      const stream = await sandbox.readFile({ path: absolutePath });
      if (stream === null) continue;
      const bytes = await readRepositoryInstructionStream(stream);
      if (bytes === null) {
        throw new Error(
          `${repository.repoPath}/${path} exceeds the repository-instruction size limit`,
        );
      }
      sources.push({
        repository: repository.repoPath,
        path,
        content: bytes.toString("utf8"),
      });
    }

    // After the committed files, before .ai/memory: rules are written by an
    // operator on the Repositories page, so they outrank the notes a model
    // distilled, and the compiler emits sections in the order it receives them.
    // Labelled with repoPath like every other source of this repository, so one
    // repository never appears under two names in one compiled prompt.
    const repositoryKey = repositoryCatalogKey({
      provider: repository.provider,
      path: repository.repoPath,
    });
    const rules = rulesByKey.get(repositoryKey);
    if (rules) {
      const content = takeRepositoryRules({
        key: repositoryKey,
        // `repo_path` names THIS repository, not the run's headline one. A
        // rules document is per repository, so a token that resolved to some
        // other repository's path inside it would be worse than not resolving.
        rendered: substitutePromptVariables(rules.rules, {
          ...repositoryRuleVariables(ruleVariables),
          repo_path: repository.repoPath,
        }),
        budget: ruleBudget,
      });
      if (content !== null) {
        sources.push({
          repository: repository.repoPath,
          path: REPOSITORY_RULES_SOURCE_PATH,
          content,
          version: rules.version,
        });
      }
    }

    // Kill switch: with repository memory off this step does exactly what it
    // did before .ai/memory existed, no listing and no reads beyond the two
    // instruction files.
    if (!enableRepoMemory) continue;

    const memoryPrefix = `${repository.localPath}/${AI_MEMORY_DIR}/`;
    let stdout: string;
    try {
      // One deadline over the spawn and the log fetch together: both are
      // network calls, and a hang would fail the block through a caller that
      // turns this step's throw into an execution error.
      const listed = await withMemoryListingDeadline(async (signal) => {
        // "-type f" excludes symlink entries, which are type l, so a memory
        // file can never alias a path outside the repository. find also refuses
        // to descend a symlinked start directory unless invoked with -L.
        const listing = await sandbox.runCommand(
          "find",
          [
            `${repository.localPath}/${AI_MEMORY_DIR}`,
            "-maxdepth",
            "1",
            "-type",
            "f",
            "-name",
            "*.md",
          ],
          { signal },
        );
        // A non-zero exit means the directory is absent, which is the common
        // case. It also covers find missing from the image.
        if (listing.exitCode !== 0) return null;
        return listing.stdout({ signal });
      });
      if (listed === null) continue;
      stdout = listed;
    } catch (error) {
      await warnWithoutFailing("repository_memory_listing_failed", {
        repository: repository.repoPath,
        err: (error as Error)?.message ?? String(error),
      });
      continue;
    }

    // The listing comes from a cloned repository, so bound the parse before the
    // split and the sort, then bound the count before any read.
    const overflowed = stdout.length > MAX_AI_MEMORY_LISTING_CHARS;
    const lines = stdout.slice(0, MAX_AI_MEMORY_LISTING_CHARS).split("\n");
    // A truncated tail is not a whole entry, so never parse it as one.
    if (overflowed) lines.pop();
    if (overflowed || lines.length > MAX_AI_MEMORY_LISTING_LINES) {
      await warnWithoutFailing("repository_memory_listing_truncated", {
        repository: repository.repoPath,
        chars: stdout.length,
        lines: lines.length,
      });
    }
    // find prints absolute paths. Requiring the exact directory prefix and then
    // re-checking the remainder against a pattern that cannot hold a slash
    // rejects nested paths and traversal.
    const accepted = lines
      .slice(0, MAX_AI_MEMORY_LISTING_LINES)
      .filter((line) => line.startsWith(memoryPrefix))
      .map((line) => line.slice(memoryPrefix.length))
      .filter((name) => AI_MEMORY_NAME_PATTERN.test(name));
    // A newline inside a file name splits one entry across two lines, and the
    // leading half can repeat a real sibling. Deduplicate so no file is read
    // twice or burns two of the slots below.
    const names = Array.from(new Set(accepted)).sort();
    if (names.length > MAX_AI_MEMORY_FILES) {
      await warnWithoutFailing("repository_memory_files_truncated", {
        repository: repository.repoPath,
        skipped: names.length - MAX_AI_MEMORY_FILES,
      });
    }
    for (const name of names.slice(0, MAX_AI_MEMORY_FILES)) {
      // Latched: counted without being read, because the content could only be
      // discarded, and counted rather than skipped so the warning below can
      // name every repository that lost documents.
      if (memoryExhausted) {
        countDroppedMemoryDocument(repository.repoPath);
        continue;
      }
      try {
        const stream = await sandbox.readFile({ path: `${memoryPrefix}${name}` });
        if (stream === null) continue;
        const bytes = await readRepositoryInstructionStream(
          stream,
          MAX_AI_MEMORY_BYTES,
        );
        if (bytes === null) {
          await warnWithoutFailing("repository_memory_file_oversized", {
            repository: repository.repoPath,
            name,
          });
          continue;
        }
        const content = bytes.toString("utf8");
        // Measured on the decoded document, which is what the prompt pays for,
        // and measured before it is injected: a byte that is not valid UTF-8
        // decodes to a three byte replacement character, so the read cap above
        // does not bound the injected string on its own.
        const contentBytes = Buffer.byteLength(content, "utf8");
        // A document larger than the whole budget could not fit under any
        // ordering, so skipping it is order independent and must not latch.
        // One 32 KiB file of invalid UTF-8 decodes to 96 KiB of replacement
        // characters, and latching on it would let any repository silence every
        // other repository's memory with one committed file.
        if (contentBytes > MAX_AI_MEMORY_TOTAL_BYTES) {
          countDroppedMemoryDocument(repository.repoPath);
          continue;
        }
        // Whole documents only: half a memory document still reads to the model
        // as a complete one, so one that does not fit is dropped, not cut. This
        // one could have fitted in an empty budget, so it is what spends it.
        if (memoryBytes + contentBytes > MAX_AI_MEMORY_TOTAL_BYTES) {
          memoryExhausted = true;
          countDroppedMemoryDocument(repository.repoPath);
          continue;
        }
        memoryBytes += contentBytes;
        sources.push({
          repository: repository.repoPath,
          path: `${AI_MEMORY_DIR}/${name}`,
          content,
        });
      } catch (error) {
        // Only HTTP 404 maps to a null stream, so every other transport or
        // mid-stream failure arrives here and must not fail the invocation.
        await warnWithoutFailing("repository_memory_file_unreadable", {
          repository: repository.repoPath,
          name,
          err: (error as Error)?.message ?? String(error),
        });
      }
    }
  }
  if (droppedMemoryDocuments > 0) {
    await warnWithoutFailing("repository_memory_injection_budget_exceeded", {
      dropped: droppedMemoryDocuments,
      repositories: droppedMemoryRepositories,
      maxBytes: MAX_AI_MEMORY_TOTAL_BYTES,
    });
  }
  // One line per compiled prompt for each kind of rules problem, rather than
  // one per repository: an operator reading these is asking "did this run get
  // the rules I wrote", and that question has one answer per prompt.
  if (ruleBudget.unresolved.size > 0) {
    await warnWithoutFailing("repository_rules_unresolved_variable", {
      variables: [...ruleBudget.unresolved].sort(),
    });
  }
  if (ruleBudget.trimmed.size > 0 || ruleBudget.dropped.length > 0) {
    await warnWithoutFailing("repository_rules_truncated", {
      ...(ruleBudget.trimmed.size > 0
        ? { trimmed: Object.fromEntries([...ruleBudget.trimmed].sort()) }
        : {}),
      ...(ruleBudget.dropped.length > 0
        ? { dropped: [...ruleBudget.dropped].sort() }
        : {}),
      maxBytes: MAX_REPOSITORY_RULES_BYTES,
      maxTotalBytes: MAX_REPOSITORY_RULES_TOTAL_BYTES,
    });
  }
  return sources;
}
loadRepositoryInstructionSources.maxRetries = 0;

interface RepositoryCatalogRules {
  version: number;
  rules: string;
}

/** What one compiled prompt has already spent on rules, and what went wrong. */
interface RepositoryRulesBudget {
  remaining: number;
  trimmed: Map<string, number>;
  dropped: string[];
  unresolved: Set<string>;
}

/**
 * The catalog rules for the keys this invocation may inject, keyed by
 * `provider:owner/name`, exactly as stored.
 *
 * Best effort in every direction. A run must never fail because of rules: they
 * are an addition to a prompt that was correct without them, and the catalog
 * they come from is edited by operators between runs. So an unreachable
 * database and a malformed row cost the rules and nothing else, exactly like
 * .ai/memory above and unlike AGENTS.md, which is committed alongside the code
 * the agent is about to change.
 *
 * Nothing is rendered, measured or trimmed here: those all depend on the run's
 * values and on what earlier repositories in the manifest have already spent,
 * so they happen per repository in the walk above.
 */
async function loadRepositoryCatalogRules(
  keys: readonly string[],
): Promise<Map<string, RepositoryCatalogRules>> {
  const found = new Map<string, RepositoryCatalogRules>();
  if (keys.length === 0) return found;
  // The allowed set is re-checked against what came back, rather than trusted
  // from the query that asked for it. This is the boundary that keeps one
  // repository's instructions out of another repository's run, and a boundary
  // that holds only because the reader filters correctly is a boundary one
  // refactor away from not holding at all.
  const allowed = new Set(keys);
  try {
    const { listConnectedRepositoryRules } = await import(
      "../../db/repositories/repository-catalog.js"
    );
    for (const row of await listConnectedRepositoryRules(keys)) {
      if (!allowed.has(row.key)) continue;
      const rules = row.rules.trim();
      if (rules.length === 0) continue;
      found.set(row.key, { version: row.version, rules });
    }
  } catch (error) {
    await warnWithoutFailing("repository_rules_unreadable", {
      err: (error as Error)?.message ?? String(error),
    });
    return new Map();
  }
  return found;
}

/**
 * The subset of the run's variables a rules document may render.
 *
 * Everything outside `REPOSITORY_RULES_VARIABLE_NAMES` is left out of the map
 * entirely rather than blanked, because `substitutePromptVariables` leaves a
 * name it was not given standing in the text. So a ticket description written
 * by a reporter stays the literal string `{{ticket_description}}` inside a
 * section the model reads as operator-authored rules, instead of becoming one.
 */
function repositoryRuleVariables(
  variables: PromptVariableValues | undefined,
): PromptVariableValues {
  const allowed: PromptVariableValues = {};
  if (!variables) return allowed;
  for (const name of REPOSITORY_RULES_VARIABLE_NAMES) {
    const value = variables[name];
    if (value !== undefined) allowed[name] = value;
  }
  return allowed;
}

/**
 * One repository's rendered rules, inside the per-repository cap and the
 * prompt-wide budget, or null when the budget is spent.
 *
 * Order matters and it is the order here: render, then measure. The cap is on
 * what the prompt pays for, and a stored document under the cap can render to
 * one over it.
 *
 * Trimmed rather than dropped at the per-repository cap, because an operator
 * puts the rules that matter at the top; dropped rather than trimmed at the
 * prompt-wide budget, because a repository that arrives with nothing left is
 * not being cut short, it is being skipped, and a stub of a section reads as
 * "this repository has almost no rules".
 */
function takeRepositoryRules(input: {
  key: string;
  rendered: string;
  budget: RepositoryRulesBudget;
}): string | null {
  for (const variable of usedVariables(input.rendered)) {
    // Both an unknown name and a real prompt variable this section may not
    // render land here: from inside a rules document they are the same fact,
    // that the token the operator typed is still standing in the text.
    if (!isRepositoryRulesVariable(variable.name)) {
      input.budget.unresolved.add(variable.name);
    }
  }
  if (input.budget.remaining <= 0) {
    input.budget.dropped.push(input.key);
    return null;
  }
  const capped = sliceUtf8Head(
    input.rendered,
    Math.min(MAX_REPOSITORY_RULES_BYTES, input.budget.remaining),
  );
  if (capped.length === 0) {
    input.budget.dropped.push(input.key);
    return null;
  }
  const bytes = utf8Bytes(capped);
  input.budget.remaining -= bytes;
  if (capped.length < input.rendered.length) {
    input.budget.trimmed.set(input.key, bytes);
  }
  return capped;
}

/** @vercel/sandbox 1.8.1 takes an AbortSignal and no timeout, and a signal only
 * bounds the work where the SDK observes it. This step has maxRetries = 0 and a
 * caller that turns a throw into a failed block, so the abort is also raced
 * against the operation: a spawn that never settles must not hang a run. A
 * timeout costs this repository its memory and nothing more, like a non-zero
 * exit, except that the catch below reports it. */
async function withMemoryListingDeadline<T>(
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    AI_MEMORY_LISTING_TIMEOUT_MS,
  );
  try {
    return await Promise.race([
      execute(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              new Error(
                `.ai/memory listing exceeded ${AI_MEMORY_LISTING_TIMEOUT_MS}ms`,
              ),
            ),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Every .ai/memory and catalog-rules problem is logged and skipped rather than
 * thrown. Reporting a failure must not itself fail: several call sites sit
 * inside catch blocks, where a throw would propagate out of the step and fail
 * the invocation this wrapper exists to keep alive. The pino import stays
 * dynamic because this module is bundled into the workflow. */
async function warnWithoutFailing(
  event: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(details, event);
  } catch {
    // Nothing left to report with.
  }
}

export async function readRepositoryInstructionStream(
  stream: NodeJS.ReadableStream,
  maxBytes = MAX_REPOSITORY_INSTRUCTION_BYTES,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

type RepositoryInstructionLoader = (
  sandboxId: string,
  manifest: WorkspaceManifest,
  enableRepoMemory?: boolean,
  catalogRuleKeys?: readonly string[],
  ruleVariables?: PromptVariableValues,
) => Promise<EffectivePromptRepositorySource[]>;

/**
 * Whether this invocation reads repository instructions at all.
 *
 * The harness profile's `includeRepositoryInstructions` is the whole gate, and
 * it gates the catalog's rules for the same reason it gates a committed
 * AGENTS.md: a profile that says "do not put repository instructions in this
 * prompt" is stating a fact about the prompt, not about where the text is
 * stored. A workspace manifest is the second half, because without a checkout
 * there is no repository set to read instructions for.
 *
 * A predicate rather than an inline `&&` at the call site so the decision has
 * somewhere to be tested: the call site itself lives inside a workflow body
 * that a unit test cannot reach.
 */
export function shouldLoadRepositoryInstructionSources(input: {
  includeRepositoryInstructions: boolean;
  manifest: WorkspaceManifest | null | undefined;
}): boolean {
  return input.includeRepositoryInstructions && Boolean(input.manifest);
}

/**
 * Planning executes in an isolated agent sandbox with no checkout. Its prompt
 * still reads trusted instructions from the authoritative shared code
 * workspace. Other agent phases read from their execution workspace.
 */
export async function loadInvocationRepositoryInstructionSources(
  input: {
    nodeType: WorkflowBlockType;
    executionSandboxId: string | null;
    sharedCodeSandboxId: string | null;
    manifest: WorkspaceManifest;
    /** The run's frozen ENABLE_REPO_MEMORY, threaded to the step below. */
    enableRepoMemory: boolean;
    /** The run's frozen repository access, threaded to the step below. */
    repositoryAccess: RunRepositoryAccess;
    /** The run's prompt variables. The step keeps only the identity subset a
     *  rules document may render; see `repositoryRuleVariables`. */
    ruleVariables: PromptVariableValues;
  },
  load: RepositoryInstructionLoader = loadRepositoryInstructionSources,
): Promise<EffectivePromptRepositorySource[]> {
  const sourceSandboxId =
    input.nodeType === "planning_agent"
      ? input.sharedCodeSandboxId
      : input.executionSandboxId;
  if (!sourceSandboxId) return [];
  return load(
    sourceSandboxId,
    input.manifest,
    input.enableRepoMemory,
    injectableRepositoryRuleKeys(input.manifest, input.repositoryAccess),
    input.ruleVariables,
  );
}

/**
 * Which repositories' rules this invocation may inject: the run's frozen access
 * list, intersected with the repositories it actually checked out.
 *
 * Both halves matter. The checkout alone would inject rules for a repository the
 * catalog has since switched off, and the access list alone would inject rules
 * for a repository this run never opened, whose build commands and conventions
 * are noise in its prompt. `isRepositoryAccessible` is the intersection's first
 * half rather than a second reading of `enabledKeys`, so the bridge (nobody has
 * activated the catalog) behaves here exactly as it does everywhere else: it
 * refuses nobody, and every checked-out repository contributes.
 */
export function injectableRepositoryRuleKeys(
  manifest: WorkspaceManifest,
  access: RunRepositoryAccess,
): string[] {
  const keys = manifest.repositories
    .filter((repository) =>
      isRepositoryAccessible(access, {
        provider: repository.provider,
        path: repository.repoPath,
      }),
    )
    .map((repository) =>
      repositoryCatalogKey({
        provider: repository.provider,
        path: repository.repoPath,
      }),
    );
  return [...new Set(keys)];
}

function validateRepositoryInstructionManifest(
  input: WorkspaceManifest,
): WorkspaceManifest {
  const manifest = workspaceManifestSchema.parse(input);
  const seenPaths = new Set<string>();
  for (const repository of manifest.repositories) {
    if (!isValidWorkspaceLocalPath(repository)) {
      throw new Error(
        `Repository instruction path is invalid for ${repository.repoPath}`,
      );
    }
    if (seenPaths.has(repository.localPath)) {
      throw new Error(
        `Repository instruction path is duplicated for ${repository.repoPath}`,
      );
    }
    seenPaths.add(repository.localPath);
  }
  return manifest;
}

/** Only the two instruction files are reported. An absent .ai/memory directory
 * is normal, so listing it here would pin a permanent false negative into every
 * compiled prompt's unresolved-source list. */
export function unresolvedRepositoryInstructionSources(
  repositories?: readonly string[],
): string[] {
  const labels = repositories && repositories.length > 0
    ? repositories
    : ["prepared workspace"];
  return labels.flatMap((repository) =>
    INSTRUCTION_PATHS.map((path) => `${repository}/${path}`)
  );
}
