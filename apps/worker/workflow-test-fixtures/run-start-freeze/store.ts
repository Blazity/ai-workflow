import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The stand-in for the repository catalog, as a file.
 *
 * A file rather than a module-level variable because the test process and the
 * step that reads it do not reliably share a module instance: the Workflow
 * builder bundles step code of its own. The file is the honest channel anyway,
 * since the thing being modelled is a database an operator edits while a run is
 * suspended.
 */
export interface ProbeRepositoryAccess {
  activated: boolean;
  enabledKeys: string[];
}

const ROOT = join(tmpdir(), "aiw-run-start-freeze");
const ACCESS_PATH = join(ROOT, "access.json");
const LOADS_PATH = join(ROOT, "loads");

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** What the "catalog" holds right now. The test moves this mid-run. */
export function writeAccess(access: ProbeRepositoryAccess): void {
  write(ACCESS_PATH, JSON.stringify(access));
}

export function readAccess(): ProbeRepositoryAccess {
  return JSON.parse(readFileSync(ACCESS_PATH, "utf8")) as ProbeRepositoryAccess;
}

/**
 * How many times the run-start step's BODY actually ran.
 *
 * The load-bearing control. Without it the case proves nothing: a body that
 * never replayed would also report the first value, and the test would pass
 * while saying nothing about the journal.
 */
export function recordLoad(): void {
  const previous = existsSync(LOADS_PATH) ? Number(readFileSync(LOADS_PATH, "utf8")) : 0;
  write(LOADS_PATH, String(previous + 1));
}

export function loadCount(): number {
  return existsSync(LOADS_PATH) ? Number(readFileSync(LOADS_PATH, "utf8")) : 0;
}

export function resetStore(): void {
  rmSync(ROOT, { recursive: true, force: true });
}
