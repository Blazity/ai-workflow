import type { SandboxProvider } from "./types.js";
import type { DockerSandboxConfig } from "./docker-provider.js";
import type { VercelSandboxConfig } from "./vercel-provider.js";

export type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js";
export type { DockerSandboxConfig } from "./docker-provider.js";
export type { VercelSandboxConfig } from "./vercel-provider.js";

type ProviderConfig =
  | { provider: "docker"; docker: DockerSandboxConfig }
  | { provider: "vercel"; vercel: VercelSandboxConfig };

export async function createSandboxProvider(config: ProviderConfig): Promise<SandboxProvider> {
  switch (config.provider) {
    case "docker": {
      const { DockerSandboxProvider } = await import("./docker-provider.js");
      return new DockerSandboxProvider(config.docker);
    }
    case "vercel": {
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      return new VercelSandboxProvider(config.vercel);
    }
    default:
      throw new Error(`Unknown sandbox provider: ${(config as { provider: string }).provider}`);
  }
}
