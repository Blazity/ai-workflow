#!/bin/bash
set -e

echo "Blazebot sandbox starting — branch: $BLAZEBOT_BRANCH" >&2

/usr/bin/git clone \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL}.git" /workspace/repo

cd /workspace/repo

/usr/bin/git checkout "$BLAZEBOT_BRANCH" 2>/dev/null || /usr/bin/git checkout -b "$BLAZEBOT_BRANCH"

cp /inject/requirements.md ./requirements.md

MODEL="${CLAUDE_MODEL:-claude-sonnet-4-20250514}"

echo "Launching Claude Code (model: $MODEL)" >&2

CLAUDE_EXIT=0
claude --print --output-format json --model "$MODEL" --dangerously-skip-permissions < requirements.md || CLAUDE_EXIT=$?

echo "Claude Code exited with code: $CLAUDE_EXIT" >&2

if [ "$CLAUDE_EXIT" -eq 0 ] || [ "$CLAUDE_EXIT" -eq 2 ]; then
  if /usr/bin/git diff --quiet HEAD 2>/dev/null; then
    echo "No changes to push" >&2
  else
    echo "Pushing changes to origin/$BLAZEBOT_BRANCH" >&2
    /usr/bin/git push origin "$BLAZEBOT_BRANCH"
  fi
fi

exit $CLAUDE_EXIT
