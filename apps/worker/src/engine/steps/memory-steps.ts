import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { MEMORY_NOTEBOOK_MAX_BYTES } from "@integrations/sdk";
import {
  fitMemoryText,
  MEMORY_CUT_MARKER,
  utf8Bytes,
  utf8BoundaryEnd,
} from "../../memory/content.js";
import {
  humanDecisionsSectionOf,
  upsertHumanDecisionsSection,
  withoutHumanDecisionsSection,
} from "../support/human-decisions-memory.js";
import type { ActiveMemory } from "../support/memory-runtime.js";
import {
  WORKSPACE_ROOT_DIR,
  type WorkspaceManifest,
} from "../../sandbox/repo-workspace.js";

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.get>>;

/**
 * The size of one workspace memory document, in both directions: how much of
 * the agent's file this step reads out of a sandbox, and how much of a
 * recalled notebook it writes into one. The SDK states it
 * (`MEMORY_NOTEBOOK_MAX_BYTES`) because a provider's author has to know it.
 *
 * The read happens before any provider is involved: a stream has to be capped
 * as it is consumed, and there is nothing to ask yet. The provider applies its
 * own limit to what it is given, so a provider that holds less simply stores
 * less. The write is capped whatever the provider returned.
 */
const MAX_WORKSPACE_MEMORY_BYTES = MEMORY_NOTEBOOK_MAX_BYTES;

/** Exactly the path the agent still reads and commits, relative to its cwd, so
 * the store and the working copy stay the same document. */
const MEMORY_DIR = "ai-workflow/memory";
/** The directory older runs wrote to. Still read as a fallback and still gated
 * everywhere, so a document an earlier run stored or committed is not orphaned. */
const LEGACY_MEMORY_DIR = "blazebot/memory";
/**
 * The store every notebook call below reaches, named on the log lines that
 * report a refusal: the built-in store, whoever serves facts and lessons
 * (`activeMemory` never hands a notebook to an engine). Not `memory.id`,
 * which names the provider of facts and lessons.
 */
const NOTEBOOK_STORE = "builtin";

export interface WorkspaceMemoryTarget {
  sandboxId: string;
  subjectKey: string;
  ticketKey: string | null;
  /** Ticket identifier for ticket runs, PR subject key for PR triggers: the
   * same value write-human-decisions-memory names the file after. */
  taskId: string;
  /**
   * Manager-authored manifest carried on EngineCtx. Never a manifest read back
   * from the sandbox (see blocks/types.ts).
   *
   * Hydration writes the document at the agent's starting cwd
   * (WORKSPACE_ROOT_DIR). Persist also reads every checkout the manifest names,
   * because the agent's shell moves into a checkout to work and a relative
   * write follows it; the newest copy wins, with the human decisions of the
   * root copy.
   */
  workspaceManifest: WorkspaceManifest;
  runId: string;
}

export interface HydrateWorkspaceMemoryResult {
  source: "db" | "repo" | "none";
  /** True when the repository checked out at the agent's cwd tracks the memory
   * file. Stage 3 cannot hide a tracked file from the PR with git excludes. */
  trackedInRepo: boolean;
  /** True only when the stored document was written into the workspace. */
  written: boolean;
  /**
   * Why this deployment's memory provider could not answer, or absent when it
   * did.
   *
   * ADDED IN S13, and absent on every result stored before it existed, which
   * is what a run replaying across the deploy reads. Absent means "nothing was
   * wrong with memory", which is what every such run in fact saw.
   *
   * It is here because `source: "none"` used to mean two different things that
   * a person reading a run cannot tell apart: this subject has nothing stored,
   * and this deployment's memory could not be reached at all. Now it answers
   * only the first.
   */
  unavailable?: string;
  /**
   * True when the provider answered the recall for this notebook, held or
   * not, so the workspace file started from what was stored (or, for a file
   * the repository tracks, from the committed copy the agent reads instead).
   * False when it did not: the provider refused, the tracked-file probe
   * failed before the recall, or the step failed. Teardown reads it
   * (`PersistWorkspaceMemoryInput.notebookRecalled`) so a file that started
   * empty never replaces a notebook the run never saw.
   *
   * ADDED AFTER S13, and absent on every result recorded before it, which a
   * run replaying across the deploy reads: absent keeps the behaviour those
   * runs started under.
   */
  recalled?: boolean;
}

export interface PersistWorkspaceMemoryInput extends WorkspaceMemoryTarget {
  /**
   * The hydration's `recalled`, carried by the caller. False makes this step
   * ask the provider before it writes, and keep a stored notebook rather than
   * replace it with a file the agent started without it.
   *
   * ADDED AFTER S13, optional for the same reason as `recalled`: an input
   * recorded before it has no such field, and absent writes as this step
   * always did.
   */
  notebookRecalled?: boolean;
}

export interface PersistWorkspaceMemoryResult {
  persisted: boolean;
  /** As above: absent means memory answered, not that nothing went wrong. */
  unavailable?: string;
  /** Why the agent's file was not stored over the provider's notebook, when
   *  it was not. Absent when the write went ahead or nothing was there. */
  withheld?: string;
  /**
   * The sentence saying the agent left no notebook, naming every path that
   * was checked. Present only when none of them held a non-empty file.
   *
   * ADDED AFTER S13, absent on every result recorded before it: before it, an
   * absent notebook returned `{ persisted: false }` and nothing else, which
   * looked exactly like a run that never reached this step.
   */
  absent?: string;
}

/**
 * Writes the stored memory document to the agent's cwd before any block runs, or
 * seeds the store once from the file the workspace already carries. A file the
 * root repository already tracks is never overwritten, so the checkout keeps
 * exactly the behavior it has today. Best effort: memory is an optimization,
 * never a run blocker.
 */
export async function hydrateWorkspaceMemoryStep(
  input: WorkspaceMemoryTarget,
): Promise<HydrateWorkspaceMemoryResult> {
  "use step";
  try {
    // Inside the try so an invalid task id lands in this step's own log. The
    // review workspace degrades to no document instead of throwing; both are
    // safe, and the asymmetry is deliberate: there the copy is optional, here the
    // step owns the failure report.
    const docPath = memoryDocPath(input.taskId);
    const absolutePath = `${WORKSPACE_ROOT_DIR}/${docPath}`;
    const { logger } = await import("../../infra/logger.js");
    const log = logger.child({
      sandboxId: input.sandboxId,
      subjectKey: input.subjectKey,
      docPath,
      step: "hydrateWorkspaceMemory",
    });
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
    const { activeMemory } = await import("../support/memory-runtime.js");
    const memory = await activeMemory();
    const subject = { key: input.subjectKey, label: input.taskId };
    const scope = { kind: "notebook", name: input.taskId } as const;
    const sandbox = await Sandbox.get({
      sandboxId: input.sandboxId,
      ...getSandboxCredentials(),
    });

    // Only a repository checked out at the agent's cwd can track this path. In
    // the discovery-promoted layout every repository lives under repos/<slug>,
    // so the document sits outside all of them and no git state is involved.
    const rootRepository = input.workspaceManifest.repositories.find(
      (repository) => repository.localPath === WORKSPACE_ROOT_DIR,
    );
    let trackedInRepo = false;
    if (rootRepository) {
      const tracked = await sandbox.runCommand("git", [
        "-C",
        WORKSPACE_ROOT_DIR,
        "ls-files",
        "--",
        docPath,
      ]);
      // Fail closed: an unanswered probe cannot rule out a tracked file, and
      // overwriting one would leave a tracked modification behind.
      if (tracked.exitCode !== 0) {
        log.warn(
          { repo: rootRepository.repoPath, exitCode: tracked.exitCode },
          "memory_document_tracked_probe_failed",
        );
        return { source: "none", trackedInRepo: false, written: false, recalled: false };
      }
      if ((await tracked.stdout()).trim().length > 0) {
        trackedInRepo = true;
        log.info({ repo: rootRepository.repoPath }, "memory_document_tracked_in_repo");
      }
    }

    // The notebook as the built-in store keeps it, whoever serves facts and
    // lessons here (`activeMemory` never hands a notebook to an engine). Which
    // addresses it reads (the current one, and the one an older run wrote
    // under) is the store's own business.
    const recalled = await memory.recall({ subject, scope });
    if (!recalled.ok) {
      // Named, not swallowed. This is the difference between "this ticket has
      // nothing stored", which is the ordinary first run, and "this deployment
      // could not reach memory", which somebody has to be able to see.
      log.warn(
        { store: NOTEBOOK_STORE, code: recalled.code, detail: recalled.detail },
        "memory_provider_unavailable",
      );
      return {
        source: "none",
        trackedInRepo,
        written: false,
        unavailable: recalled.detail,
        recalled: false,
      };
    }
    // Whatever the provider returned, the agent's file is at most the notebook
    // limit, and a cut one says so on its last line (`fitMemoryText`, the one
    // rule for cutting memory). The limit is far above the rule's floor, so
    // the empty fallback is never reached; it exists so that nothing past the
    // limit can be written even then.
    const stored = recalled.held
      ? { content: fitMemoryText(recalled.rendering, MAX_WORKSPACE_MEMORY_BYTES)?.text ?? "" }
      : null;
    if (stored) {
      if (trackedInRepo) {
        // Overwriting a tracked file is a tracked modification, which the
        // publication and workspace-gate cleanliness checks reject unless the
        // agent commits it. The committed copy stays the one the agent reads;
        // persist still captures it at the end of the run.
        log.info(
          { repo: rootRepository?.repoPath },
          "memory_hydration_skipped_tracked",
        );
        return { source: "db", trackedInRepo, written: false, recalled: true };
      }
      // writeFiles does not guarantee mkdir -p semantics.
      await sandbox.runCommand("mkdir", ["-p", parentDirectory(absolutePath)]);
      await sandbox.writeFiles([
        { path: absolutePath, content: Buffer.from(stored.content) },
      ]);
      log.info(
        { bytes: utf8Bytes(stored.content) },
        "memory_document_hydrated_from_store",
      );
      return { source: "db", trackedInRepo, written: true, recalled: true };
    }

    // One-time migration of the legacy committed file. This only reads the tree
    // and hands the text to the provider, so the workspace is left untouched
    // either way.
    const legacy = await readLegacyMemoryFile(
      sandbox,
      input.workspaceManifest,
      docPath,
      legacyMemoryDocPath(input.taskId),
      MAX_WORKSPACE_MEMORY_BYTES,
    );
    if (!legacy || legacy.text.trim().length === 0) {
      return { source: "none", trackedInRepo, written: false, recalled: true };
    }
    const seeded = await memory.observe({
      subject,
      scope,
      runId: input.runId,
      ticketKey: input.ticketKey,
      observation: {
        kind: "document",
        text: legacy.text,
        ...(legacy.truncated ? { sourceTruncated: true as const } : {}),
      },
    });
    if (!seeded.ok) {
      // Every refusal is reported. `rejected` is the text being declined
      // (core could not scrub it of this deployment's secrets, or the
      // provider will not take it), which used to be
      // `memory_document_redaction_failed` here and now carries its own
      // sentence.
      log.warn(
        { store: NOTEBOOK_STORE, code: seeded.code, detail: seeded.detail },
        "memory_document_seed_refused",
      );
      return {
        source: "none",
        trackedInRepo,
        written: false,
        unavailable: seeded.detail,
        recalled: true,
      };
    }
    log.info({ truncated: legacy.truncated }, "memory_document_seeded_from_repo");
    return { source: "repo", trackedInRepo, written: false, recalled: true };
  } catch (err) {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      {
        sandboxId: input.sandboxId,
        subjectKey: input.subjectKey,
        taskId: input.taskId,
        step: "hydrateWorkspaceMemory",
        err: errorMessage(err),
      },
      "memory_document_hydrate_failed",
    );
    return { source: "none", trackedInRepo: false, written: false, recalled: false };
  }
}
hydrateWorkspaceMemoryStep.maxRetries = 0;

/**
 * Copies the memory document the agent left in the workspace (at the sandbox
 * root or inside any checkout, the newest copy, carrying the human decisions
 * of the root copy) into the store at the end of the run, including failed and
 * canceled runs. A run that left none says so, with the paths checked. Best
 * effort: this runs inside the teardown path, which must never fail because of
 * memory.
 */
export async function persistWorkspaceMemoryStep(
  input: PersistWorkspaceMemoryInput,
): Promise<PersistWorkspaceMemoryResult> {
  "use step";
  try {
    // Inside the try for the same reason as the hydration step above.
    const docPath = memoryDocPath(input.taskId);
    const { logger } = await import("../../infra/logger.js");
    const log = logger.child({
      sandboxId: input.sandboxId,
      subjectKey: input.subjectKey,
      docPath,
      runId: input.runId,
      step: "persistWorkspaceMemory",
    });
    const { Sandbox } = await import("@vercel/sandbox");
    const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
    const { activeMemory } = await import("../support/memory-runtime.js");
    const sandbox = await Sandbox.get({
      sandboxId: input.sandboxId,
      ...getSandboxCredentials(),
    });

    // Every place the agent may have left it. The agent's prompt names a
    // relative path, and the agent's shell does not stay where it started: in
    // the discovery-promoted layout the only checkout is repos/<slug>, the
    // agent cds into it to work, and the notebook lands there. Reading only the
    // sandbox root lost every such notebook without a word.
    const candidates = notebookCandidatePaths(input.workspaceManifest, input.taskId);
    const file = await readAgentNotebook(
      sandbox,
      candidates,
      `${WORKSPACE_ROOT_DIR}/${docPath}`,
      input.taskId,
    );
    if (!file) {
      const absent = `the agent left no notebook for ${input.taskId}; checked ${candidates.join(", ")}`;
      log.warn({ checkedPaths: candidates }, "memory_document_absent");
      return { persisted: false, absent };
    }
    // Resolved after the read, so a deployment whose memory cannot be reached
    // does not pay a settings read for a workspace that had nothing to capture.
    const memory = await activeMemory();
    const subject = { key: input.subjectKey, label: input.taskId };
    const scope = { kind: "notebook", name: input.taskId } as const;
    if (input.notebookRecalled === false) {
      // The agent started without knowing what was stored, so its file holds
      // this run's notes and none of the history. Writing it would replace
      // that history with them. Ask first, and write only over nothing.
      const withheld = await unseenNotebookHeld(memory, subject, scope);
      if (withheld !== null) {
        log.warn({ store: NOTEBOOK_STORE, detail: withheld }, "memory_document_persist_withheld");
        return { persisted: false, withheld };
      }
    }
    const written = await memory.observe({
      subject,
      scope,
      runId: input.runId,
      ticketKey: input.ticketKey,
      observation: {
        kind: "document",
        text: file.text,
        // The read was capped, so the provider is told this is a prefix rather
        // than left to infer it from a length that fits.
        ...(file.truncated ? { sourceTruncated: true as const } : {}),
      },
    });
    if (!written.ok) {
      // The one place a lost capture used to look exactly like a run with an
      // empty notebook. It reports the provider's own sentence, and the caller
      // logs that sentence against the run id (`memory_capture_unavailable`).
      // It does NOT reach the run row: the observation channel the hydrate and
      // seed refusals use is scoped to a block attempt and every attempt is
      // closed by the time this runs.
      log.warn(
        { store: NOTEBOOK_STORE, code: written.code, detail: written.detail },
        "memory_provider_unavailable",
      );
      return { persisted: false, unavailable: written.detail };
    }
    log.info(
      {
        bytes: utf8Bytes(file.text),
        notebookPath: file.path,
        ...(file.humanDecisionsFrom ? { humanDecisionsFrom: file.humanDecisionsFrom } : {}),
      },
      "memory_document_persisted",
    );
    return { persisted: true };
  } catch (err) {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      {
        sandboxId: input.sandboxId,
        subjectKey: input.subjectKey,
        taskId: input.taskId,
        runId: input.runId,
        step: "persistWorkspaceMemory",
        err: errorMessage(err),
      },
      "memory_document_persist_failed",
    );
    return { persisted: false };
  }
}
persistWorkspaceMemoryStep.maxRetries = 0;

/**
 * Why the agent's file must not be stored over this notebook, or null when
 * nothing is stored and the write may go ahead. A recall that fails again is
 * a reason too: not knowing whether history is there is not permission to
 * replace it.
 */
async function unseenNotebookHeld(
  memory: ActiveMemory,
  subject: { key: string; label: string },
  scope: { kind: "notebook"; name: string },
): Promise<string | null> {
  const recalled = await memory.recall({ subject, scope });
  if (!recalled.ok) {
    return `this run started without the notebook stored for this work, and memory still could not say whether one is stored (${recalled.detail}), so nothing was written over it`;
  }
  return recalled.held
    ? "this run started without the notebook stored for this work, because memory could not be read then, so the stored notebook was kept and this run's file was not stored"
    : null;
}

/**
 * Where the document sits IN THE WORKSPACE, which is what this step writes and
 * what the agent's prompt points at.
 *
 * It is spelled here and in the built-in provider, and that is not a second
 * derivation of one thing: this one names a file in a checkout, the other names
 * an address in a store, and they only look alike because the store was built
 * to mirror the checkout. A provider that keeps memory somewhere else changes
 * its address and must not change this path.
 */
function memoryDocPath(taskId: string): string {
  // A task id may never walk out of the memory directory.
  if (taskId.split("/").includes("..")) throw new Error("invalid memory task id");
  return `${MEMORY_DIR}/${taskId}.md`;
}

/** The workspace path an older run wrote to. Read only, for backward-compat. */
function legacyMemoryDocPath(taskId: string): string {
  // A task id may never walk out of the memory directory.
  if (taskId.split("/").includes("..")) throw new Error("invalid memory task id");
  return `${LEGACY_MEMORY_DIR}/${taskId}.md`;
}

/**
 * Where the agent's notebook can be at teardown, in the order preferred when
 * two copies are equally new: the sandbox root first (the agent's starting
 * cwd, and where hydration writes), then every checkout the manifest names,
 * each at the current path before any at the legacy one.
 */
function notebookCandidatePaths(
  manifest: WorkspaceManifest,
  taskId: string,
): string[] {
  const roots = [
    WORKSPACE_ROOT_DIR,
    ...manifest.repositories.map((repository) => repository.localPath),
  ].filter((root, index, all) => all.indexOf(root) === index);
  return [
    ...roots.map((root) => `${root}/${memoryDocPath(taskId)}`),
    ...roots.map((root) => `${root}/${legacyMemoryDocPath(taskId)}`),
  ];
}

interface NotebookCopy {
  text: string;
  truncated: boolean;
  path: string;
}

/**
 * The notebook to store, or null when no candidate holds one: the copy the
 * agent wrote last, with the human decisions the platform keeps in the copy
 * at the sandbox root.
 *
 * `writeHumanDecisionsMemory` upserts the "Human decisions" section into the
 * root copy and nowhere else, while an agent working inside a checkout saves
 * its notebook there, without the section or with one it copied before the
 * latest round was answered. Stored as it is, that copy loses what a person
 * decided, so the root copy's section replaces whatever the newest copy has in
 * its place. The root's is always the current one: the platform renders it
 * from every answered round, and the agent is told not to edit it.
 */
async function readAgentNotebook(
  sandbox: SandboxInstance,
  candidates: string[],
  rootCopyPath: string,
  taskId: string,
): Promise<(NotebookCopy & { humanDecisionsFrom?: string }) | null> {
  const found: NotebookCopy[] = [];
  for (const path of candidates) {
    const file = await readMemoryFile(sandbox, path, MAX_WORKSPACE_MEMORY_BYTES);
    if (file && file.text.trim().length > 0) found.push({ ...file, path });
  }
  const newest = await newestNotebook(sandbox, found);
  const rootCopy = found.find((copy) => copy.path === rootCopyPath);
  if (!newest || !rootCopy || rootCopy === newest) return newest;
  const decisions = humanDecisionsSectionOf(rootCopy.text);
  if (decisions === null) return newest;
  return {
    ...newest,
    ...withHumanDecisions(newest, decisions, taskId),
    humanDecisionsFrom: rootCopy.path,
  };
}

/**
 * `notebook` with `decisions` in place of whatever section it carried, within
 * the notebook limit. The decisions always stay whole: appended past the
 * limit, they would be what the store cuts off the end. When the two do not
 * fit together the agent's notes give way, and the notebook says so:
 * - the old section comes out, the notes are cut to the room left and end
 *   with the line saying they were cut (`fitMemoryText`), and the decisions
 *   follow them. Cut with the old section still in, the cut can land inside
 *   it, and the upsert then takes the rest of the notebook for that section,
 *   the notes after it and the cut line included;
 * - with less room left than a cut can use, that line alone stands for them;
 * - a section that fills the limit by itself is the whole notebook. It always
 *   fits, because it came out of a copy read no longer than the limit, and
 *   with anything around it the store would cut its end marker off.
 */
function withHumanDecisions(
  notebook: NotebookCopy,
  decisions: string,
  taskId: string,
): { text: string; truncated: boolean } {
  const merged = upsertHumanDecisionsSection(notebook.text, decisions, taskId);
  if (!notebook.truncated && utf8Bytes(merged) <= MAX_WORKSPACE_MEMORY_BYTES) {
    return { text: merged, truncated: false };
  }
  // Room for the section, the blank line before it and the newline after it.
  const room = MAX_WORKSPACE_MEMORY_BYTES - utf8Bytes(decisions) - 3;
  const notes =
    fitMemoryText(withoutHumanDecisionsSection(notebook.text), room)?.text ?? MEMORY_CUT_MARKER;
  const text = upsertHumanDecisionsSection(notes, decisions, taskId);
  return { text: utf8Bytes(text) <= MAX_WORKSPACE_MEMORY_BYTES ? text : decisions, truncated: false };
}

/**
 * The copy the agent wrote last, or null when there is none.
 *
 * Several copies are an ordinary state, not a corner: hydration writes the
 * stored notebook at the sandbox root, and an agent working inside a checkout
 * writes its update there. Taking the root copy would store the notebook this
 * run started from and drop what it learned, so the newest file wins. When
 * the modification times cannot be read, the candidate order decides.
 */
async function newestNotebook(
  sandbox: SandboxInstance,
  found: NotebookCopy[],
): Promise<NotebookCopy | null> {
  if (found.length <= 1) return found[0] ?? null;
  const mtimes = await modificationTimes(
    sandbox,
    found.map((file) => file.path),
  );
  let newest = found[0]!;
  for (const file of found) {
    if ((mtimes.get(file.path) ?? -Infinity) > (mtimes.get(newest.path) ?? -Infinity)) {
      newest = file;
    }
  }
  return newest;
}

/** Seconds since the epoch per path, from one `stat` call. Missing entries mean
 * the time could not be read, never that the file is old. */
async function modificationTimes(
  sandbox: SandboxInstance,
  paths: string[],
): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  try {
    const result = await sandbox.runCommand("stat", ["-c", "%Y %n", "--", ...paths]);
    for (const line of (await result.stdout()).split("\n")) {
      const separator = line.indexOf(" ");
      if (separator <= 0) continue;
      const seconds = Number(line.slice(0, separator));
      if (Number.isFinite(seconds)) times.set(line.slice(separator + 1), seconds);
    }
  } catch {
    // The candidate order decides, which is what it did before copies existed.
  }
  return times;
}

/** PR subject keys contain slashes, so the directory to create is derived from
 * the resolved path instead of the fixed memory dir. */
function parentDirectory(absolutePath: string): string {
  return absolutePath.slice(0, absolutePath.lastIndexOf("/"));
}

/**
 * The agent's cwd first. In the discovery-promoted layout the primary repository
 * sits under repos/<slug>, so a document an earlier run committed lives there and
 * is the only copy worth seeding from. Each location is probed at the new path
 * and then the legacy path, so a document committed under the old directory by an
 * earlier run is still seeded.
 */
async function readLegacyMemoryFile(
  sandbox: SandboxInstance,
  manifest: WorkspaceManifest,
  docPath: string,
  legacyDocPath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const candidates = [
    `${WORKSPACE_ROOT_DIR}/${docPath}`,
    `${WORKSPACE_ROOT_DIR}/${legacyDocPath}`,
  ];
  const primary = manifest.repositories[0];
  if (primary && primary.localPath !== WORKSPACE_ROOT_DIR) {
    candidates.push(`${primary.localPath}/${docPath}`, `${primary.localPath}/${legacyDocPath}`);
  }
  for (const candidate of candidates) {
    const found = await readMemoryFile(sandbox, candidate, maxBytes);
    if (found) return found;
  }
  return null;
}

async function readMemoryFile(
  sandbox: SandboxInstance,
  absolutePath: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean } | null> {
  const stream = await sandbox.readFile({ path: absolutePath });
  if (stream === null) return null;
  return readCappedStream(stream, maxBytes);
}

/**
 * Mirrors readRepositoryInstructionStream but keeps the bytes it already read:
 * an oversized memory document is stored truncated with a marker, not dropped.
 */
async function readCappedStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    size += bytes.byteLength;
    if (size > maxBytes) {
      truncated = true;
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      break;
    }
  }
  const bytes = Buffer.concat(chunks, size);
  const text = bytes.subarray(0, utf8BoundaryEnd(bytes, maxBytes)).toString("utf8");
  return { text, truncated };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
