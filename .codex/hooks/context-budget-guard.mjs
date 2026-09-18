// Codex guard for the agent instruction files, the counterpart of
// .claude/hooks/context-budget-guard.mjs. Codex edits through apply_patch and
// through the shell, so this runs twice:
//   PreToolUse  reads the patch and warns before a budgeted file grows,
//   PostToolUse measures what is on disk, which catches a shell write too.
// It never blocks, and it prints nothing for anything outside the budget file.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BUDGET_PATH,
  RULE_DEFAULT,
  RULE_DIRECTORY,
  canonical,
  ceilingFor,
  currentSize,
  hookOutput,
  messagesFor,
  projectedRulesSize,
  readBudgets,
  readStdin,
  relativePath,
  repositoryRoot,
} from "../../.claude/hooks/context-budget-core.mjs";

const overCeilingNow = (path, size, ceiling) =>
  `${path} is ${size} bytes on disk, over its ceiling of ${ceiling} (${BUDGET_PATH}). ` +
  "Move history to docs/archive/agent-notes/, move area knowledge to a " +
  ".claude/rules/<area>.md file with paths:, or raise the ceiling with a reason.";

const overCollectiveNow = (size, ceiling) =>
  `${RULE_DEFAULT} is ${size} bytes on disk, over its collective ceiling of ${ceiling} ` +
  `(${BUDGET_PATH}). Reduce area rules or raise the collective ceiling with a reason.`;

const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/u;
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/u;

/**
 * What an apply_patch envelope would do to each file it touches.
 *
 * Codex sends the patch verbatim in `tool_input.command`, so the byte delta is
 * the sum of the lines it adds minus the lines it removes. A file it adds is
 * known in full; a file it updates is not, which is why the caller passes the
 * added text rather than a whole document to the shared checks. The map is
 * keyed by the path the file ends up at, and `source` is where its bytes are
 * now, which differ only when the patch moves the file.
 */
export function parsePatch(patch) {
  const targets = new Map();
  let current;
  let currentPath;
  for (const line of patch.split("\n")) {
    const header = line.match(FILE_HEADER);
    if (header) {
      const [, verb, rawPath] = header;
      currentPath = rawPath.trim();
      current = verb === "Delete" ? undefined : { verb, source: currentPath, added: [], addedBytes: 0, removedBytes: 0 };
      if (current) targets.set(currentPath, current);
      continue;
    }
    const move = line.match(MOVE_HEADER);
    if (move && current) {
      targets.delete(currentPath);
      currentPath = move[1].trim();
      targets.set(currentPath, current);
      continue;
    }
    if (!current || line.startsWith("***") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      const added = line.slice(1);
      current.added.push(added);
      current.addedBytes += Buffer.byteLength(added) + 1;
    } else if (line.startsWith("-")) {
      current.removedBytes += Buffer.byteLength(line.slice(1)) + 1;
    }
  }
  return targets;
}

async function preToolMessages(payload, root, budgets) {
  if (payload.tool_name !== "apply_patch") return [];
  const patch = payload.tool_input?.command;
  if (typeof patch !== "string") return [];

  const messages = [];
  for (const [rawPath, target] of parsePatch(patch)) {
    const path = relativePath(root, canonical(resolve(payload.cwd ?? root, rawPath)));
    if (!path || ceilingFor(path, budgets) === undefined) continue;

    const addedText = target.added.join("\n");
    if (target.verb === "Add") {
      messages.push(...(await messagesFor({ root, path, text: addedText, budgets })));
      continue;
    }
    const source = canonical(resolve(payload.cwd ?? root, target.source));
    const size = (await currentSize(source)) + target.addedBytes - target.removedBytes;
    messages.push(...(await messagesFor({ root, path, size, addedText, budgets })));
  }
  return messages;
}

/**
 * Every budgeted file that is over its ceiling right now, whoever wrote it.
 *
 * This is the net under the shell: a heredoc or a sed cannot be projected from
 * the tool call, but the file on disk can be measured afterwards. It stats, it
 * never reads, so it stays cheap enough to run after every write.
 */
async function postToolMessages(payload, root, budgets) {
  if (payload.tool_name !== "apply_patch" && payload.tool_name !== "Bash") return [];

  const messages = [];
  for (const [path, ceiling] of budgets) {
    if (path.endsWith("/") || path.includes("*")) continue;
    const size = await currentSize(join(root, path));
    if (size > ceiling) messages.push(overCeilingNow(path, size, ceiling));
  }
  const collectiveCeiling = budgets.get(RULE_DIRECTORY);
  if (collectiveCeiling !== undefined) {
    const collective = await projectedRulesSize(root, new Map());
    if (collective > collectiveCeiling) messages.push(overCollectiveNow(collective, collectiveCeiling));
  }
  return messages;
}

export async function runCodexContextBudgetGuard() {
  const payload = JSON.parse(await readStdin(process.stdin));
  const event = payload?.hook_event_name;
  if (event !== "PreToolUse" && event !== "PostToolUse") return;

  const start = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const root = repositoryRoot(start, undefined);
  if (!root) return;

  let budgets;
  try {
    budgets = await readBudgets(root);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const messages =
    event === "PreToolUse"
      ? await preToolMessages(payload, root, budgets)
      : await postToolMessages(payload, root, budgets);
  const output = hookOutput(event, messages);
  if (output) process.stdout.write(output);
}

const entryUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (import.meta.url === entryUrl) {
  try {
    await runCodexContextBudgetGuard();
  } catch {
    process.exitCode = 0;
  }
}
