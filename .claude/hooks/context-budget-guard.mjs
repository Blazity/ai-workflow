import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const BUDGET_PATH = ".claude/context-budget.tsv";
const RULE_DEFAULT = ".claude/rules/*.md";
const RULE_DIRECTORY = ".claude/rules/";

// Compare real paths: git reports the resolved top level, so a project reached
// through a symlink (macOS /tmp is /private/tmp) would otherwise match nothing.
function canonical(path) {
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

function relativePath(root, target) {
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

function ceilingFor(path, budgets) {
  return budgets.get(path) ?? (isRule(path) ? budgets.get(RULE_DEFAULT) : undefined);
}

async function readBudgets(root) {
  return parseBudgets(await readFile(join(root, BUDGET_PATH), "utf8"));
}

function quickPathCouldBeCovered(filePath, projectRoot, projectBudgets) {
  if (projectRoot && projectBudgets) {
    const candidate = relativePath(projectRoot, filePath);
    if (candidate && ceilingFor(candidate, projectBudgets) !== undefined) return true;
  }
  if (basename(filePath) === "AGENTS.md" || basename(filePath) === "CLAUDE.md") {
    return true;
  }
  return /[/\\]\.claude[/\\]rules[/\\][^/\\]+\.md$/u.test(filePath);
}

function repositoryRoot(filePath, projectRoot) {
  try {
    return execFileSync(
      "/usr/bin/git",
      ["-C", dirname(filePath), "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return projectRoot;
  }
}

async function currentContent(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function replacement(content, edit) {
  if (
    !edit ||
    typeof edit !== "object" ||
    typeof edit.old_string !== "string" ||
    typeof edit.new_string !== "string" ||
    edit.old_string === ""
  ) {
    throw new Error("Invalid edit input");
  }
  if (edit.replace_all === true) {
    return content.split(edit.old_string).join(edit.new_string);
  }
  return content.replace(edit.old_string, edit.new_string);
}

async function projectedContent(toolName, toolInput, filePath) {
  if (toolName === "Write") {
    if (typeof toolInput.content !== "string") throw new Error("Invalid Write input");
    return toolInput.content;
  }

  let content = await currentContent(filePath);
  if (toolName === "Edit") return replacement(content, toolInput);
  if (toolName === "MultiEdit") {
    if (!Array.isArray(toolInput.edits)) throw new Error("Invalid MultiEdit input");
    for (const edit of toolInput.edits) content = replacement(content, edit);
    return content;
  }
  throw new Error("Unsupported tool");
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

async function projectedRulesSize(root, targetPath, projected) {
  const rulesDirectory = join(root, RULE_DIRECTORY);
  let entries;
  try {
    entries = await readdir(rulesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return Buffer.byteLength(projected);
    }
    throw error;
  }

  let total = 0;
  let targetSeen = false;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(rulesDirectory, entry.name);
    if (resolve(path) === resolve(targetPath)) {
      total += Buffer.byteLength(projected);
      targetSeen = true;
    } else {
      total += (await readFile(path)).byteLength;
    }
  }
  if (!targetSeen) total += Buffer.byteLength(projected);
  return total;
}

export async function runContextBudgetGuard() {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  const toolName = payload?.tool_name;
  const toolInput = payload?.tool_input;
  if (!toolInput || typeof toolInput !== "object" || typeof toolInput.file_path !== "string") {
    return;
  }
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit") return;

  const filePath = canonical(resolve(toolInput.file_path));
  const configuredRoot = process.env.CLAUDE_PROJECT_DIR
    ? canonical(resolve(process.env.CLAUDE_PROJECT_DIR))
    : undefined;
  let configuredBudgets;
  if (configuredRoot && relativePath(configuredRoot, filePath)) {
    try {
      configuredBudgets = await readBudgets(configuredRoot);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
  if (!quickPathCouldBeCovered(filePath, configuredRoot, configuredBudgets)) return;

  const root = repositoryRoot(filePath, configuredRoot);
  if (!root) return;
  const path = relativePath(root, filePath);
  if (!path) return;

  let budgets;
  try {
    budgets = await readBudgets(root);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const ceiling = ceilingFor(path, budgets);
  if (ceiling === undefined) return;

  const projected = await projectedContent(toolName, toolInput, filePath);
  const size = Buffer.byteLength(projected);
  const messages = [];
  if (size > ceiling) {
    messages.push(
      `${path} would be ${size} bytes, over its ceiling of ${ceiling} (${BUDGET_PATH}). ` +
        "Move history to docs/archive/agent-notes/, move area knowledge to a " +
        ".claude/rules/<area>.md file with paths:, or raise the ceiling with a reason.",
    );
  }

  if (isRule(path)) {
    const collectiveCeiling = budgets.get(RULE_DIRECTORY);
    if (collectiveCeiling !== undefined) {
      const collectiveSize = await projectedRulesSize(root, filePath, projected);
      if (collectiveSize > collectiveCeiling) {
        messages.push(
          `${RULE_DEFAULT} would be ${collectiveSize} bytes, over its collective ceiling ` +
            `of ${collectiveCeiling} (${BUDGET_PATH}). Reduce area rules or raise the ` +
            "collective ceiling with a reason.",
        );
      }
    }
    if (!hasNonEmptyPaths(projected)) {
      messages.push(`${path} has no non-empty paths: list in its leading frontmatter, so it loads in every session.`);
    }
  }

  if (/\u2014|\u2013/u.test(projected)) {
    messages.push(`${path} would contain U+2014 or U+2013. Replace those characters with plain ASCII punctuation.`);
  }

  if (messages.length > 0) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: messages.join("\n"),
        },
      }),
    );
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (import.meta.url === entryUrl) {
  try {
    await runContextBudgetGuard();
  } catch {
    process.exitCode = 0;
  }
}
