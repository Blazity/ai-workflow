export interface SandboxOptions {
  branchName: string;
  requirementsMd: string;
  githubToken: string;
  repoUrl: string;
  oauthToken: string;
  model: string;
  timeoutMs: number;
  developerMode: boolean;
}

export type SandboxResult = {
  exitCode: number;
  status: "complete" | "clarification_needed" | "failed";
  summary?: string;
  questions?: string[];
  error?: string;
  containerId?: string;
};

export interface AgentOutput {
  result: "implemented" | "clarification_needed" | "failed";
  summary?: string;
  questions?: string[];
  error?: string;
}

export interface SandboxProvider {
  runSandbox(options: SandboxOptions): Promise<SandboxResult>;
  pushBranch(handle: string, branchName: string): Promise<{ pushed: boolean; output: string }>;
  teardown(handle: string): Promise<void>;
  cleanupOrphans(): Promise<void>;
}
