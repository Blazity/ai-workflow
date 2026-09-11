/**
 * Shared gate mechanics keep process execution, argument parsing, and tables
 * consistent. This helper throws on malformed input or unreadable tool output.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dirname, "../..");

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
