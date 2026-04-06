export interface PhaseScriptOptions {
  model: string;
  phase: "research" | "impl" | "review";
  inputFile: string;
  outputFile: string;
  stderrFile: string;
  sentinelFile: string;
  jsonSchema?: string;
}

/**
 * Generates a bash script for a single agent phase.
 * Designed to run detached inside a Vercel Sandbox.
 */
export function buildPhaseScript(opts: PhaseScriptOptions): string {
  const { model, inputFile, outputFile, stderrFile, sentinelFile, jsonSchema } = opts;

  let claudeFlags = `--print --model '${model}' --dangerously-skip-permissions`;

  if (jsonSchema) {
    const escapedSchema = jsonSchema.replace(/'/g, "'\\''");
    claudeFlags += ` --output-format json --json-schema '${escapedSchema}'`;
  }

  return `#!/bin/bash

# --- Cleanup stale files from prior runs ---
rm -f ${sentinelFile} ${outputFile} ${stderrFile}

# --- Phase: ${opts.phase} ---
cat ${inputFile} | claude \\
  ${claudeFlags} \\
  > ${outputFile} 2>${stderrFile}; echo $? > /tmp/${opts.phase}-exit-code || true

# --- Cleanup ---
cd /vercel/sandbox

# Remove repo-level .claude/ artifacts that Claude Code auto-creates.
# git checkout restores any that were already committed.
rm -rf .claude/
git checkout -- .claude/ 2>/dev/null || true

# --- Signal completion ---
touch ${sentinelFile}
`;
}
