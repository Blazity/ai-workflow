import { AGENT_SCHEMA } from "./agent-runner.js";

interface WrapperScriptOptions {
  model: string;
}

/**
 * Generates a bash wrapper script that:
 * 1. Runs claude --print with the given model (agent commits via stop hook)
 * 2. Does cleanup (removes .claude/, requirements.md artifacts)
 * 3. Writes stdout/stderr to /tmp/ files
 * 4. Touches /tmp/agent-done as sentinel
 *
 * Designed to run detached inside a Vercel Sandbox.
 * The agent is responsible for committing — this script does NOT auto-commit.
 */
export function buildWrapperScript(opts: WrapperScriptOptions): string {
  const { model } = opts;

  // Escape single quotes in the schema for safe embedding in bash
  const escapedSchema = AGENT_SCHEMA.replace(/'/g, "'\\''");

  return `#!/bin/bash

# --- Phase 1: Run Claude Code agent ---
cat /vercel/sandbox/requirements.md | claude \\
  --print \\
  --model '${model}' \\
  --dangerously-skip-permissions \\
  --output-format json \\
  --json-schema '${escapedSchema}' \\
  > /tmp/agent-stdout.txt 2>/tmp/agent-stderr.txt; echo $? > /tmp/agent-exit-code || true

# --- Phase 2: Cleanup ---
cd /vercel/sandbox

# Remove repo-level .claude/ artifacts that Claude Code auto-creates.
# git checkout restores any that were already committed.
rm -rf .claude/ requirements.md
git checkout -- .claude/ 2>/dev/null || true
git checkout -- requirements.md 2>/dev/null || true

# --- Phase 3: Signal completion ---
touch /tmp/agent-done
`;
}
