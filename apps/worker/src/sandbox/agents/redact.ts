/**
 * Diagnostic redaction, deliberately alone in a module of its own.
 *
 * It lives here rather than in protocol.ts so it can be imported from workflow
 * scope: protocol.ts imports `node:crypto` for its schema hashing, and a Node
 * builtin anywhere in the workflow module graph fails the Vercel build alone,
 * never vitest or a local build, which is what makes it worth stating. This
 * module imports nothing at all.
 *
 * Redacting before a value crosses into a step is not cosmetic. Workflow
 * journals step arguments durably, so an unredacted secret handed to a step is
 * written to the run's event log whatever the step then does with it.
 *
 * The secrets are the caller's to supply, and that is the point: this function
 * used to read the environment itself, with a filter of its own, so a secret
 * an admin stored in the dashboard (never in the environment) passed straight
 * through. A caller that can await passes `knownSecretValues()`; workflow scope
 * and the synchronous agent protocol parser pass `environmentSecretValues()`,
 * and the step that writes what they produced applies the whole set.
 */
export function redactDiagnosticText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  // Longest first, so a secret that contains a shorter one is blanked whole
  // rather than left with the shorter one's marker in its middle.
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}
