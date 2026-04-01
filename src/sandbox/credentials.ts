type Credentials = {
  token: string;
  teamId: string;
  projectId: string;
};

/**
 * Returns explicit Sandbox credentials when all three env vars are set (local dev).
 * On Vercel, returns empty object — the SDK authenticates via OIDC automatically.
 */
export function getSandboxCredentials(): Partial<Credentials> {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }
  return {};
}
