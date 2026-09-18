// Shared budget logic for the Claude Code and Codex guards. The adapters differ
// only in the payload they read and the JSON they print; what counts as too
// large, and what the agent is told about it, lives here so the two cannot
// drift.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const BUDGET_PATH = ".claude/context-budget.tsv";
export const RULE_DEFAULT = ".claude/rules/*.md";
export const RULE_DIRECTORY = ".claude/rules/";

const DASH = /—|–/u;

// Compare real paths: git reports the resolved top level, so a project reached
// through a symlink (macOS /tmp is /private/tmp) would otherwise match nothing.
export function canonical(path) {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

export function relativePath(root, target) {
  const result = relative(root, target);
  if (result === "" || result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    return undefined;
  }
  return result.split(sep).join("/");
}

function isRule(path) {
  return /^\.claude\/rules\/[^/]+\.md$/u.test(path);
}

function parseBudgets(source) {
  const budgets = new Map();
  for (const line of source.split(/\r?\n/u)) {
    if (line === "" || line.startsWith("#")) continue;
    const [path, rawCeiling] = line.split("\t");
    const ceiling = Number(rawCeiling);
    if (!path || !Number.isSafeInteger(ceiling) || ceiling < 0) {
      throw new Error("Invalid context budget");
    }
    budgets.set(path, ceiling);
  }
  return budgets;
}

export async function readBudgets(root) {
  return parseBudgets(await readFile(join(root, BUDGET_PATH), "utf8"));
}

export function ceilingFor(path, budgets) {
  return budgets.get(path) ?? (isRule(path) ? budgets.get(RULE_DEFAULT) : undefined);
}

export function repositoryRoot(startPath, fallback) {
  try {
    return execFileSync("/usr/bin/git", ["-C", startPath, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

export async function currentContent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export async function currentSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function hasNonEmptyPaths(content) {
  const lines = content.split(/\r?\n/u);
  if (lines[0] !== "---") return false;
  const closing = lines.indexOf("---", 1);
  if (closing < 0) return false;

  const frontmatter = lines.slice(1, closing);
  const pathsIndex = frontmatter.findIndex((line) => /^paths\s*:/u.test(line));
  if (pathsIndex < 0) return false;

  const declaration = frontmatter[pathsIndex].match(/^paths\s*:\s*(.*)$/u);
  const inline = declaration?.[1].trim() ?? "";
  if (/^\[\s*[^\]\s][\s\S]*\]$/u.test(inline)) return true;
  if (inline !== "") return false;

  for (const line of frontmatter.slice(pathsIndex + 1)) {
    if (/^\S/u.test(line)) break;
    if (/^\s+-\s+\S/u.test(line)) return true;
  }
  return false;
}

/** Bytes every rule would occupy once `sizeOverrides` are applied. */
export async function projectedRulesSize(root, sizeOverrides) {
  const rulesDirectory = join(root, RULE_DIRECTORY);
  const seen = new Set();
  let total = 0;
  let entries = [];
  try {
    entries = await readdir(rulesDirectory, { withFileTypes: true });
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = `${RULE_DIRECTORY}${entry.name}`;
    seen.add(path);
    const override = sizeOverrides.get(path);
    total += override ?? (await stat(join(rulesDirectory, entry.name))).size;
  }
  for (const [path, size] of sizeOverrides) {
    if (isRule(path) && !seen.has(path)) total += size;
  }
  return total;
}

const overCeiling = (path, size, ceiling) =>
  `${path} would be ${size} bytes, over its ceiling of ${ceiling} (${BUDGET_PATH}). ` +
  "Move history to docs/archive/agent-notes/, move area knowledge to a " +
  ".claude/rules/<area>.md file with paths:, or raise the ceiling with a reason.";

const overCollective = (size, ceiling) =>
  `${RULE_DEFAULT} would be ${size} bytes, over its collective ceiling of ${ceiling} ` +
  `(${BUDGET_PATH}). Reduce area rules or raise the collective ceiling with a reason.`;

const missingPaths = (path) =>
  `${path} has no non-empty paths: list in its leading frontmatter, so it loads in every session.`;

const carriesDash = (path) =>
  `${path} would contain U+2014 or U+2013. Replace those characters with plain ASCII punctuation.`;

/**
 * Every warning for one projected file state.
 *
 * `text` is the whole projected content when the caller knows it, which lets
 * the frontmatter and typography checks run. A caller that only knows the
 * resulting size (a patch applied to a file it has not read) passes `size`
 * alone plus `addedText`, the lines the change introduces.
 */
export async function messagesFor({ root, path, size, text, addedText, budgets }) {
  const ceiling = ceilingFor(path, budgets);
  if (ceiling === undefined) return [];

  const bytes = size ?? Buffer.byteLength(text ?? "");
  const messages = [];
  if (bytes > ceiling) messages.push(overCeiling(path, bytes, ceiling));

  if (isRule(path)) {
    const collectiveCeiling = budgets.get(RULE_DIRECTORY);
    if (collectiveCeiling !== undefined) {
      const collective = await projectedRulesSize(root, new Map([[path, bytes]]));
      if (collective > collectiveCeiling) messages.push(overCollective(collective, collectiveCeiling));
    }
    if (text !== undefined && !hasNonEmptyPaths(text)) messages.push(missingPaths(path));
  }

  if (DASH.test(text ?? addedText ?? "")) messages.push(carriesDash(path));
  return messages;
}

/** The hook reply Claude Code and Codex both accept, or nothing to say. */
export function hookOutput(hookEventName, messages) {
  if (messages.length === 0) return undefined;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: messages.join("\n") },
  });
}

export async function readStdin(stream) {
  stream.setEncoding("utf8");
  let input = "";
  for await (const chunk of stream) input += chunk;
  return input;
}
