#!/bin/bash
set -e

/usr/bin/git clone --branch "$BLAZEBOT_BRANCH" --single-branch \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL}.git" /workspace/repo

cd /workspace/repo

cp /inject/requirements.md ./requirements.md

MODEL="${CLAUDE_MODEL:-claude-sonnet-4-20250514}"

CLAUDE_EXIT=0
claude --print --output-format json --model "$MODEL" --dangerously-skip-permissions < requirements.md || CLAUDE_EXIT=$?

if [ "$CLAUDE_EXIT" -eq 0 ] || [ "$CLAUDE_EXIT" -eq 2 ]; then
  if /usr/bin/git diff --quiet HEAD 2>/dev/null; then
    : # no changes to push
  else
    /usr/bin/git push origin "$BLAZEBOT_BRANCH"
  fi
fi

exit $CLAUDE_EXIT
