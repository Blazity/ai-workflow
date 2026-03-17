#!/bin/bash
# Claude Code Stop hook — ensures all work is committed before the agent finishes.
# Exit 2 blocks the stop and feeds stderr back to the agent as instructions.

INPUT=$(cat)

# On the second pass (after the agent acted on our feedback), let it stop.
if [ "$(echo "$INPUT" | jq -r '.stop_hook_active')" = "true" ]; then
  exit 0
fi

cd /workspace/repo 2>/dev/null || exit 0

STATUS=$(/usr/bin/git status --porcelain 2>/dev/null)
if [ -z "$STATUS" ]; then
  exit 0
fi

UNTRACKED=$(/usr/bin/git status --porcelain 2>/dev/null | grep '^??' | wc -l | tr -d ' ')
MODIFIED=$(/usr/bin/git status --porcelain 2>/dev/null | grep -v '^??' | wc -l | tr -d ' ')

{
  echo "STOP BLOCKED — you have uncommitted changes in the repository."
  echo ""
  echo "Uncommitted file count: $MODIFIED modified/staged, $UNTRACKED untracked."
  echo ""
  echo "You MUST do one of the following before finishing:"
  echo "  1. Stage and commit all work that is part of your task: git add <files> && git commit -m '...'"
  echo "  2. Discard files that are NOT part of your task: git checkout -- <file> or rm <file>"
  echo "  3. If untracked files are build artifacts or dependencies, add them to .gitignore first."
  echo ""
  echo "Do NOT leave uncommitted changes — the orchestrator pushes the branch after you finish,"
  echo "and uncommitted work will be silently lost."
} >&2

exit 2
