#!/bin/bash
set -euo pipefail

# Trap errors to ensure the message reaches Docker's log driver before exit
trap 'EXIT_CODE=$?; echo "entrypoint failed at line $LINENO with exit code $EXIT_CODE" >&2; exit $EXIT_CODE' ERR

echo "Blazebot sandbox starting — branch: $BLAZEBOT_BRANCH" >&2

/usr/bin/git clone \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL}.git" /workspace/repo 2>&1

cd /workspace/repo

/usr/bin/git checkout "$BLAZEBOT_BRANCH" 2>&1 || /usr/bin/git checkout -b "$BLAZEBOT_BRANCH" 2>&1

cp /inject/requirements.md /workspace/requirements.md

MODEL="${CLAUDE_MODEL:-claude-opus-4-6}"

AGENT_SCHEMA='{"type":"object","required":["result"],"properties":{"result":{"type":"string","enum":["implemented","clarification_needed","failed"]},"summary":{"type":"string"},"questions":{"type":"array","items":{"type":"string"}},"error":{"type":"string"}},"additionalProperties":false}'

echo "Launching Claude Code (model: $MODEL)" >&2

CLAUDE_EXIT=0
if [ "${DEVELOPER_MODE:-false}" = "true" ]; then
  echo "Developer mode enabled — streaming structured output" >&2
  claude --print --verbose --output-format stream-json --json-schema "$AGENT_SCHEMA" --model "$MODEL" --dangerously-skip-permissions < /workspace/requirements.md | /opt/blazebot/format-stream.sh || CLAUDE_EXIT=$?
else
  claude --print --output-format json --json-schema "$AGENT_SCHEMA" --model "$MODEL" --dangerously-skip-permissions < /workspace/requirements.md || CLAUDE_EXIT=$?
fi

echo "Claude Code exited with code: $CLAUDE_EXIT" >&2

exit $CLAUDE_EXIT
