/**
 * Shared gate mechanics keep process execution, argument parsing, and tables
 * consistent. This helper throws on malformed input or unreadable tool output.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dirname, "../..");

/**
 * An anchor is a path a gate was told to look at: the root it walks, the file
 * it compares against, the list it reads. When an anchor moves, the gate scans
 * an empty set and reports zero violations, which reads exactly like a clean
 * run. requireAnchor turns the lost anchor into a refusal that names the path
 * and the invariant it leaves unproven.
 */
export function requireAnchor(root, relativePath, label, invariant) {
  const absolute = isAbsolute(relativePath) ? relativePath : join(root, relativePath);
  if (!existsSync(absolute)) {
    throw new Error(
      `${label} is missing at ${relativePath}, so ${invariant} is unproven. Restore that path or point the gate at where it moved.`,
    );
  }
  return absolute;
}

/**
 * The second half of the same rule: an anchor can exist and still hold nothing
 * the gate recognizes. A scan of zero files proves nothing, so say so instead
 * of passing.
 */
export function requireScan(count, noun, where, invariant) {
  if (count > 0) return count;
  throw new Error(
    `0 ${noun} were found under ${where}, so ${invariant} is unproven. The gate had nothing to look at; check that the paths it scans still hold the code.`,
  );
}

export function parseOptions(argv, definitions = {}) {
  const options = { root: repositoryRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    const key = definitions[argument];
    const value = argv[index + 1];
    if (!key || !value) throw new Error(`Unknown or incomplete argument: ${argument}`);
    options[key] = resolve(value);
    index += 1;
  }
  return options;
}

export function runTool(tool, args, cwd = repositoryRoot) {
  const result = spawnSync(join(repositoryRoot, "node_modules/.bin", tool), args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(`${tool} is not installed. Run pnpm install --frozen-lockfile.`);
    }
    throw result.error;
  }
  return result;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function printTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (row) =>
    row.map((cell, index) => String(cell).padEnd(widths[index])).join("  ").trimEnd();
  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
}

export function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}
