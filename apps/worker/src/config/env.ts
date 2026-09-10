import { env } from "../../env.js";

export { env };
export type { Env } from "../../env.js";

export interface GitHubAppAuth {
  appId: number;
  privateKeyBase64: string;
  installationId: number;
}

/**
 * VCS config, discriminated on `kind`.
 * GitHub auth is App-based; GitLab auth is a static PAT.
 */
export type VcsProviderConfig =
  | {
      kind: "github";
      auth: GitHubAppAuth;
      host: string;
      legacyRepoPath?: string;
      legacyBaseBranch: string;
    }
  | {
      kind: "gitlab";
      token: string;
      host: string;
      legacyRepoPath?: string;
      legacyBaseBranch: string;
    };

type LegacyVcsConfig<T extends VcsProviderConfig> = T extends unknown
  ? Omit<T, "legacyRepoPath" | "legacyBaseBranch"> & {
      repoPath: string;
      baseBranch: string;
    }
  : never;

export type VcsConfig = LegacyVcsConfig<VcsProviderConfig>;
export type VcsProviderKind = VcsProviderConfig["kind"];

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
      legacyBaseBranch: env.GITHUB_BASE_BRANCH ?? "main",
    });
  }

  if (env.GITLAB_TOKEN) {
    providers.push({
      kind: "gitlab",
      token: env.GITLAB_TOKEN,
      host: env.GITLAB_HOST,
      ...(env.GITLAB_PROJECT_ID ? { legacyRepoPath: env.GITLAB_PROJECT_ID } : {}),
      legacyBaseBranch: env.GITLAB_BASE_BRANCH ?? "main",
    });
  }

  return providers;
}

/** Raw bot-login values; provider-specific resolution belongs to VCS auth. */
export function getVcsBotLoginConfig(): {
  github?: string;
  gitlab?: string;
  legacy?: string;
} {
  return {
    github: env.GITHUB_BOT_LOGIN,
    gitlab: env.GITLAB_BOT_LOGIN,
    legacy: env.VCS_BOT_LOGIN,
  };
}

export function getVcsProviderConfig(kind: VcsProviderKind): VcsProviderConfig {
  const provider = getConfiguredVcsProviders().find((candidate) => candidate.kind === kind);
  if (!provider) {
    throw new Error(`VCS provider is not configured: ${kind}`);
  }
  return provider;
}

/** Resolve legacy single-repo VCS config. New multi-repo code should use provider configs. */
export function getVcsConfig(): VcsConfig {
  const providers = getConfiguredVcsProviders();
  const selectedProvider = env.VCS_KIND
    ? providers.find((provider) => provider.kind === env.VCS_KIND)
    : providers.length === 1
      ? providers[0]
      : undefined;

  if (!selectedProvider) {
    throw new Error("legacy VCS config requires exactly one selected provider");
  }
  if (!selectedProvider.legacyRepoPath) {
    throw new Error("legacy VCS config requires a repository");
  }

  if (selectedProvider.kind === "gitlab") {
    return {
      kind: "gitlab",
      token: selectedProvider.token,
      repoPath: selectedProvider.legacyRepoPath,
      baseBranch: selectedProvider.legacyBaseBranch,
      host: selectedProvider.host,
    };
  }
  return {
    kind: "github",
    auth: selectedProvider.auth,
    repoPath: selectedProvider.legacyRepoPath,
    baseBranch: selectedProvider.legacyBaseBranch,
    host: selectedProvider.host,
  };
}
