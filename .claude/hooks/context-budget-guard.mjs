// Claude Code PreToolUse guard: warns when a Write or Edit would push an agent
// instruction file over its ceiling. It never blocks; the shared checks live in
// context-budget-core.mjs, which the Codex guard uses too.
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonical,
  ceilingFor,
  currentContent,
  hookOutput,
  messagesFor,
  readBudgets,
  readStdin,
  relativePath,
  repositoryRoot,
} from "./context-budget-core.mjs";

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

export async function runContextBudgetGuard() {
  const payload = JSON.parse(await readStdin(process.stdin));
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

  const root = repositoryRoot(dirname(filePath), configuredRoot);
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
  if (ceilingFor(path, budgets) === undefined) return;

  const text = await projectedContent(toolName, toolInput, filePath);
  const output = hookOutput("PreToolUse", await messagesFor({ root, path, text, budgets }));
  if (output) process.stdout.write(output);
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (import.meta.url === entryUrl) {
  try {
    await runContextBudgetGuard();
  } catch {
    process.exitCode = 0;
  }
}
