import type { RepoScriptsGroupStatusEntry } from "../../pre-pr-checks/runner.js";

/**
 * The engine's own group-status entry, restated as an object type alias.
 *
 * Not a duplicate declaration: the mapped type copies every field from
 * RepoScriptsGroupStatusEntry, so adding a field there adds it here. The
 * restatement is needed because a block output must satisfy BlockOutput's
 * `[key: string]: JsonValue` index signature, and TypeScript grants an implicit
 * index signature to object type ALIASES only, never to an interface.
 */
export type RepositoryScriptGroupStatus = {
  [K in keyof RepoScriptsGroupStatusEntry]: RepoScriptsGroupStatusEntry[K];
};

export type RepositoryScriptResult = {
  repo: string;
  command: string;
  group: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
};

export type RepositoryScriptFailure = {
  repo: string;
  command: string;
  exitCode: number;
  output: string;
  phase: string | null;
};

export type RepositoryScriptDirtied = {
  repo: string;
  files: string[];
  preExisting: string[];
};

/**
 * The output fields both repository script blocks publish.
 *
 * Declared as a type alias rather than an interface on purpose: a block output
 * has to satisfy BlockOutput's `[key: string]: JsonValue` index signature, and
 * TypeScript only grants an implicit index signature to object type aliases.
 *
 * It lives here rather than beside the block that builds it because three
 * different readers recover it from a walk's durable steps, and a reader that
 * imported the workflow entry point would invert this package's one structural
 * rule: nothing under blocks/ imports agent.ts.
 */
export type RepositoryScriptsOutput = {
  ok: boolean;
  outcome: "passed" | "failed" | "skipped" | "missing_configuration";
  allPassed: boolean;
  anyFailed: boolean;
  groupStatuses: RepositoryScriptGroupStatus[];
  results: RepositoryScriptResult[];
  failures: RepositoryScriptFailure[];
  dirtied: RepositoryScriptDirtied[];
  setupFailed: boolean;
  summary: string;
};

/**
 * Recognise a repository scripts output among a walk's durable step outputs.
 *
 * By shape, never by node id: a definition names its nodes whatever it likes,
 * and both script blocks publish this same output. The check is the FULL field
 * set because the emitter writes every field on every path
 * (agent.ts repositoryScriptsOutput), so a partial match means the output came
 * from something else and reading it would attribute another block's data to
 * the scripts.
 *
 * One guard, deliberately. Three readers used to carry three hand-rolled
 * versions of this test, and they had already drifted apart: one required a
 * summary, one required `dirtied`, one required `failures`, so the same step
 * output was recognised by some readers and not others.
 *
 * Not exhaustive over element types: it proves the containers exist and the
 * scalars have the right primitive types, and leaves the elements to the
 * emitter, which is the only writer. Widening it to walk every element would
 * make an oversized output cost a deep scan on a hot path for no reader that
 * could act on the difference.
 */
export function asRepositoryScriptsOutput(
  output: unknown,
): RepositoryScriptsOutput | null {
  if (!output || typeof output !== "object") return null;
  const candidate = output as Record<string, unknown>;
  if (typeof candidate.outcome !== "string") return null;
  if (typeof candidate.summary !== "string") return null;
  if (typeof candidate.ok !== "boolean") return null;
  if (typeof candidate.allPassed !== "boolean") return null;
  if (typeof candidate.anyFailed !== "boolean") return null;
  if (typeof candidate.setupFailed !== "boolean") return null;
  if (!Array.isArray(candidate.groupStatuses)) return null;
  if (!Array.isArray(candidate.results)) return null;
  if (!Array.isArray(candidate.failures)) return null;
  if (!Array.isArray(candidate.dirtied)) return null;
  return candidate as unknown as RepositoryScriptsOutput;
}
