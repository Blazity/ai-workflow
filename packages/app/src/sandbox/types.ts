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
  /** SHA of HEAD before the agent ran — used as diff base for extractChanges */
  initialSha?: string;
};

export interface AgentOutput {
  result: "implemented" | "clarification_needed" | "failed";
  summary?: string;
  questions?: string[];
  error?: string;
}

export interface FileChange {
  path: string;
  /** Base64-encoded content, or null for deleted files */
  content: string | null;
}

export interface ExtractedChanges {
  files: FileChange[];
  commitMessage: string;
  hasChanges: boolean;
}

export interface SandboxProvider {
  runSandbox(options: SandboxOptions): Promise<SandboxResult>;
  extractChanges(handle: string, initialSha: string): Promise<ExtractedChanges>;
  teardown(handle: string): Promise<void>;
  cleanupOrphans(): Promise<void>;
}
