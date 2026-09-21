import { env } from "./runtime-env.js";

export { env };
export type { Env } from "./runtime-env.js";

export interface GitHubAppAuth {
  appId: number;
  privateKeyBase64: string;
  installationId: number;
}

/** Core's remaining VCS config. Integration-owned providers resolve elsewhere. */
export type VcsProviderConfig =
  {
    kind: "github";
    auth: GitHubAppAuth;
    host: string;
    legacyRepoPath?: string;
  };

export type VcsProviderKind = string;

function isGithubProviderConfigured(): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID);
}

/** Resolve every provider configured by credentials. */
export function getConfiguredVcsProviders(): VcsProviderConfig[] {
  const providers: VcsProviderConfig[] = [];

  if (isGithubProviderConfigured()) {
    providers.push({
      kind: "github",
      auth: {
        appId: env.GITHUB_APP_ID!,
        privateKeyBase64: env.GITHUB_APP_PRIVATE_KEY!,
        installationId: env.GITHUB_INSTALLATION_ID!,
      },
      host: "https://github.com",
      ...(env.GITHUB_OWNER && env.GITHUB_REPO
        ? { legacyRepoPath: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}` }
        : {}),
    });
  }

  return providers;
}

/** Raw bot-login values; provider-specific resolution belongs to VCS auth. */
export function getVcsBotLoginConfig(): {
  byProvider: Readonly<Record<string, string | undefined>>;
  legacy?: string;
} {
  return {
    byProvider: { github: env.GITHUB_BOT_LOGIN },
    legacy: env.VCS_BOT_LOGIN,
  };
}

export function getVcsProviderConfig(kind: string): VcsProviderConfig {
  const provider = getConfiguredVcsProviders().find((candidate) => candidate.kind === kind);
  if (!provider) {
    throw new Error(`VCS provider is not configured: ${kind}`);
  }
  return provider;
}
