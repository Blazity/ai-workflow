import type { SandboxProvider, SandboxOptions, SandboxResult } from "./types.js";
import {
  runSandbox as dockerRunSandbox,
  pushBranchFromContainer,
  teardownContainer,
  cleanupOrphanContainers,
} from "./manager.js";

export interface DockerSandboxConfig {
  image: string;
  memoryLimitMb: number;
}

export class DockerSandboxProvider implements SandboxProvider {
  constructor(private config: DockerSandboxConfig) {}

  async runSandbox(options: SandboxOptions): Promise<SandboxResult> {
    return dockerRunSandbox({
      ...options,
      image: this.config.image,
      memoryLimitMb: this.config.memoryLimitMb,
    });
  }

  async pushBranch(handle: string, branchName: string): Promise<{ pushed: boolean; output: string }> {
    return pushBranchFromContainer(handle, branchName);
  }

  async teardown(handle: string): Promise<void> {
    return teardownContainer(handle);
  }

  async cleanupOrphans(): Promise<void> {
    return cleanupOrphanContainers();
  }
}
