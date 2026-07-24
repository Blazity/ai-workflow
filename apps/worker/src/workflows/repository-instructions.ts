import type { WorkflowBlockType } from "@shared/contracts";
import {
  buildWorkspaceLocalPath,
  workspaceManifestSchema,
  type WorkspaceManifest,
} from "../sandbox/repo-workspace.js";
import type { EffectivePromptRepositorySource } from "./effective-prompt.js";

const INSTRUCTION_PATHS = ["AGENTS.md", "CLAUDE.md"] as const;
const MAX_REPOSITORY_INSTRUCTION_BYTES = 256 * 1024;

/**
 * Reads the trusted workspace paths in repository order. Missing instruction
 * files are expected; an unreadable or oversized present file fails the
 * invocation instead of silently compiling a partial effective prompt.
 */
export async function loadRepositoryInstructionSources(
  sandboxId: string,
  manifest: WorkspaceManifest,
): Promise<EffectivePromptRepositorySource[]> {
  "use step";
  const trustedManifest = validateRepositoryInstructionManifest(manifest);
  const [{ Sandbox }, { getSandboxCredentials }] = await Promise.all([
    import("@vercel/sandbox"),
    import("../sandbox/credentials.js"),
  ]);
  const sandbox = await Sandbox.get({
    sandboxId,
    ...getSandboxCredentials(),
  });
  const sources: EffectivePromptRepositorySource[] = [];

  for (const repository of trustedManifest.repositories) {
    for (const path of INSTRUCTION_PATHS) {
      const absolutePath = `${repository.localPath}/${path}`;
      const stream = await sandbox.readFile({ path: absolutePath });
      if (stream === null) continue;
      const bytes = await readRepositoryInstructionStream(stream);
      if (bytes === null) {
        throw new Error(
          `${repository.repoPath}/${path} exceeds the repository-instruction size limit`,
        );
      }
      sources.push({
        repository: repository.repoPath,
        path,
        content: bytes.toString("utf8"),
      });
    }
  }
  return sources;
}
loadRepositoryInstructionSources.maxRetries = 0;

export async function readRepositoryInstructionStream(
  stream: NodeJS.ReadableStream,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REPOSITORY_INSTRUCTION_BYTES) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      return null;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

type RepositoryInstructionLoader = (
  sandboxId: string,
  manifest: WorkspaceManifest,
) => Promise<EffectivePromptRepositorySource[]>;

/**
 * Planning executes in an isolated agent sandbox with no checkout. Its prompt
 * still reads trusted instructions from the authoritative shared code
 * workspace. Other agent phases read from their execution workspace.
 */
export async function loadInvocationRepositoryInstructionSources(
  input: {
    nodeType: WorkflowBlockType;
    executionSandboxId: string | null;
    sharedCodeSandboxId: string | null;
    manifest: WorkspaceManifest;
  },
  load: RepositoryInstructionLoader = loadRepositoryInstructionSources,
): Promise<EffectivePromptRepositorySource[]> {
  const sourceSandboxId =
    input.nodeType === "planning_agent"
      ? input.sharedCodeSandboxId
      : input.executionSandboxId;
  if (!sourceSandboxId) return [];
  return load(sourceSandboxId, input.manifest);
}

function validateRepositoryInstructionManifest(
  input: WorkspaceManifest,
): WorkspaceManifest {
  const manifest = workspaceManifestSchema.parse(input);
  const seenPaths = new Set<string>();
  for (const [index, repository] of manifest.repositories.entries()) {
    const expectedPath = buildWorkspaceLocalPath(
      repository.provider,
      repository.repoPath,
      index,
    );
    if (repository.localPath !== expectedPath) {
      throw new Error(
        `Repository instruction path is invalid for ${repository.repoPath}`,
      );
    }
    if (seenPaths.has(repository.localPath)) {
      throw new Error(
        `Repository instruction path is duplicated for ${repository.repoPath}`,
      );
    }
    seenPaths.add(repository.localPath);
  }
  return manifest;
}

export function unresolvedRepositoryInstructionSources(
  repositories?: readonly string[],
): string[] {
  const labels = repositories && repositories.length > 0
    ? repositories
    : ["prepared workspace"];
  return labels.flatMap((repository) =>
    INSTRUCTION_PATHS.map((path) => `${repository}/${path}`)
  );
}
