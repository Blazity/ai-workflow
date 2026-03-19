import type { SandboxProvider } from "./types.js";
import type { VercelSandboxConfig } from "./vercel-provider.js";

export type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js";
export type { VercelSandboxConfig } from "./vercel-provider.js";

// TODO: Re-enable Docker provider when not deploying to Vercel
// import type { DockerSandboxConfig } from "./docker-provider.js";
// export type { DockerSandboxConfig } from "./docker-provider.js";

type ProviderConfig =
  // | { provider: "docker"; docker: DockerSandboxConfig }
  | { provider: "vercel"; vercel: VercelSandboxConfig };

export async function createSandboxProvider(config: ProviderConfig): Promise<SandboxProvider> {
  switch (config.provider) {
    // case "docker": {
    //   const { DockerSandboxProvider } = await import("./docker-provider.js");
    //   return new DockerSandboxProvider(config.docker);
    // }
    case "vercel": {
      const missing = (["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"] as const)
        .filter((k) => !process.env[k]);
      if (missing.length > 0) {
        throw new Error(`Vercel sandbox requires env vars: ${missing.join(", ")}`);
      }
      const { VercelSandboxProvider } = await import("./vercel-provider.js");
      return new VercelSandboxProvider(config.vercel);
    }
    default:
      throw new Error(`Unknown sandbox provider: ${(config as { provider: string }).provider}`);
  }
}
