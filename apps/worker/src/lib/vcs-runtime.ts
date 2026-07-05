import {
  env,
  getConfiguredVcsProviders,
  getVcsProviderConfig,
  getVcsToken,
  type VcsProviderConfig,
  type VcsProviderKind,
} from "../../env.js";
import type { VCSAdapter } from "../adapters/vcs/types.js";
import type { SandboxProviderConfig } from "../sandbox/manager.js";
import { createVCSForRepository } from "./create-vcs.js";
import { getBotIdentity } from "./github-auth.js";

export interface RepositoryVcsTarget {
  provider: VcsProviderKind;
  repoPath: string;
  baseBranch: string;
}

export interface RepositoryVcsRuntime {
  provider: VcsProviderKind;
  repoPath: string;
  baseBranch: string;
  config: VcsProviderConfig;
  vcs: VCSAdapter;
  getToken: () => Promise<string>;
}

export function createRepositoryVcsRuntime(target: RepositoryVcsTarget): RepositoryVcsRuntime {
  const config = getVcsProviderConfig(target.provider);
  let vcs: VCSAdapter | undefined;
  return {
    provider: target.provider,
    repoPath: target.repoPath,
    baseBranch: target.baseBranch,
    config,
    get vcs() {
      vcs ??= createVCSForRepository(config, {
        repoPath: target.repoPath,
        baseBranch: target.baseBranch,
      });
      return vcs;
    },
    getToken: () => getVcsToken(config),
  };
}

export function createRepositoryVCS(target: RepositoryVcsTarget): VCSAdapter {
  return createRepositoryVcsRuntime(target).vcs;
}

export async function buildSandboxProviderConfigs(
  neededProviders?: Iterable<VcsProviderKind>,
): Promise<SandboxProviderConfig[]> {
  const { logger } = await import("./logger.js");
  const needed = neededProviders ? new Set(neededProviders) : null;
  const configs: SandboxProviderConfig[] = [];
  for (const provider of getConfiguredVcsProviders().filter((provider) => !needed || needed.has(provider.kind))) {
    try {
      const commitIdentity = await resolveCommitIdentity(provider);
      configs.push({
        kind: provider.kind,
        host: provider.host,
        getToken: () => getVcsToken(provider),
        commitAuthor: commitIdentity.name,
        commitEmail: commitIdentity.email,
      });
    } catch (err) {
      logger.warn(
        { provider: provider.kind, err: err instanceof Error ? err.message : String(err) },
        "sandbox_provider_identity_resolution_failed",
      );
    }
  }
  return configs;
}

async function resolveCommitIdentity(
  provider: VcsProviderConfig,
): Promise<{ name: string; email: string }> {
  if (env.COMMIT_AUTHOR && env.COMMIT_EMAIL) {
    return { name: env.COMMIT_AUTHOR, email: env.COMMIT_EMAIL };
  }
  if (provider.kind === "github") {
    return getBotIdentity(provider.auth);
  }
  return { name: "ai-workflow-blazity", email: "ai-workflow@blazity.com" };
}
