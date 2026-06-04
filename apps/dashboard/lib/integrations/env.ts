// Centralised env access. Each integration calls isConfigured() before making
// outbound calls; route handlers fall back to mock data when false.

function read(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const env = {
  vercel: {
    token: () => read("VERCEL_TOKEN"),
    teamId: () => read("VERCEL_TEAM_ID"),
    projectId: () => read("VERCEL_PROJECT_ID"),
  },
  arthur: {
    apiKey: () => read("ARTHUR_API_KEY"),
    baseUrl: () => read("ARTHUR_BASE_URL") ?? "https://platform.arthur.ai",
  },
  jira: {
    baseUrl: () => read("JIRA_BASE_URL"),
    email: () => read("JIRA_EMAIL"),
    token: () => read("JIRA_API_TOKEN"),
  },
  github: {
    appId: () => read("GITHUB_APP_ID"),
    installationId: () => read("GITHUB_APP_INSTALLATION_ID"),
    privateKey: () => read("GITHUB_APP_PRIVATE_KEY")?.replace(/\\n/g, "\n"),
  },
};

export const isConfigured = {
  vercel: () => !!(env.vercel.token() && env.vercel.projectId()),
  arthur: () => !!env.arthur.apiKey(),
  jira: () => !!(env.jira.baseUrl() && env.jira.email() && env.jira.token()),
  github: () => !!(env.github.appId() && env.github.installationId() && env.github.privateKey()),
};
