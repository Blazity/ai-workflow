#!/bin/bash
set -euo pipefail

# Trap errors to ensure the message reaches Docker's log driver before exit
trap 'EXIT_CODE=$?; echo "entrypoint failed at line $LINENO with exit code $EXIT_CODE" >&2; exit $EXIT_CODE' ERR

echo "Blazebot sandbox starting — branch: $BLAZEBOT_BRANCH" >&2

/usr/bin/git clone \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL}.git" /workspace/repo 2>&1

cd /workspace/repo

/usr/bin/git checkout "$BLAZEBOT_BRANCH" 2>&1 || /usr/bin/git checkout -b "$BLAZEBOT_BRANCH" 2>&1

cp /inject/requirements.md ./requirements.md

MODEL="${CLAUDE_MODEL:-claude-sonnet-4-20250514}"

echo "Launching Claude Code (model: $MODEL)" >&2

CLAUDE_EXIT=0
claude --print --output-format json --model "$MODEL" --dangerously-skip-permissions < requirements.md || CLAUDE_EXIT=$?

echo "Claude Code exited with code: $CLAUDE_EXIT" >&2

exit $CLAUDE_EXIT
