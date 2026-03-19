import type { SandboxProvider } from "./types.js";
import { DockerSandboxProvider, type DockerSandboxConfig } from "./docker-provider.js";
import { VercelSandboxProvider, type VercelSandboxConfig } from "./vercel-provider.js";

export type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js";
export type { DockerSandboxConfig } from "./docker-provider.js";
export type { VercelSandboxConfig } from "./vercel-provider.js";

type ProviderConfig =
  | { provider: "docker"; docker: DockerSandboxConfig }
  | { provider: "vercel"; vercel: VercelSandboxConfig };

export function createSandboxProvider(config: ProviderConfig): SandboxProvider {
  switch (config.provider) {
    case "docker":
      return new DockerSandboxProvider(config.docker);
    case "vercel":
      return new VercelSandboxProvider(config.vercel);
    default:
      throw new Error(`Unknown sandbox provider: ${(config as { provider: string }).provider}`);
  }
}
