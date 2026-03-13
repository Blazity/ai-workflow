#!/bin/bash
set -e

/usr/bin/git clone --branch "$BLAZEBOT_BRANCH" --single-branch \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL}.git" /workspace/repo

cd /workspace/repo

cp /inject/requirements.md ./requirements.md

if [ ! -f .blazebot/implement.md ]; then
  mkdir -p .blazebot
  echo '{"summary":"","questions":[],"error":".blazebot/implement.md not found in repo"}' > .blazebot/output.json
  exit 1
fi

mkdir -p .blazebot

MODEL="${CLAUDE_MODEL:-claude-sonnet-4-20250514}"

CLAUDE_EXIT=0
claude --print --model "$MODEL" --dangerously-skip-permissions < requirements.md || CLAUDE_EXIT=$?

if [ ! -f .blazebot/output.json ]; then
  echo '{"summary":"","questions":[],"error":"Agent exited without writing .blazebot/output.json"}' > .blazebot/output.json
fi

exit $CLAUDE_EXIT
