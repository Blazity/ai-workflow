/** Read the optional repository allowlist without triggering full env validation. */
export function repositoryAllowlistValue(): string {
  return process.env.AGENT_ALLOWED_REPOS ?? "";
}
