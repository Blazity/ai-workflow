import Docker from "dockerode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface SandboxOptions {
  image: string;
  branchName: string;
  requirementsMd: string;
  githubToken: string;
  repoUrl: string;
  oauthToken: string;
  model: string;
  timeoutMs: number;
  memoryLimitMb: number;
}

export type SandboxResult = {
  exitCode: number;
  status: "complete" | "clarification_needed" | "failed";
  summary?: string;
  questions?: string[];
  error?: string;
};

const docker = new Docker();

export async function runSandbox(
  options: SandboxOptions,
): Promise<SandboxResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "blazebot-"));
  await writeFile(join(tmpDir, "requirements.md"), options.requirementsMd);

  let container: Docker.Container | null = null;

  try {
    container = await docker.createContainer({
      Image: options.image,
      Env: [
        `BLAZEBOT_BRANCH=${options.branchName}`,
        `GITHUB_TOKEN=${options.githubToken}`,
        `REPO_URL=${options.repoUrl}`,
        `CLAUDE_CODE_OAUTH_TOKEN=${options.oauthToken}`,
        `CLAUDE_MODEL=${options.model}`,
      ],
      HostConfig: {
        Memory: options.memoryLimitMb * 1024 * 1024,
        Binds: [`${tmpDir}:/inject:ro`],
      },
    });

    await container.start();

    const waitPromise = container.wait();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Sandbox timeout exceeded")),
        options.timeoutMs,
      ),
    );

    let exitCode: number;
    try {
      const result = await Promise.race([waitPromise, timeoutPromise]);
      exitCode = result.StatusCode;
    } catch {
      if (container) {
        try {
          await container.kill();
        } catch {
          /* may already be stopped */
        }
      }
      return {
        exitCode: -1,
        status: "failed",
        error: "Sandbox timeout exceeded",
      };
    }

    return await readResult(container, exitCode);
  } catch (err) {
    return {
      exitCode: -1,
      status: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
    };
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
      } catch {
        /* best effort */
      }
    }
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function readResult(
  container: Docker.Container,
  exitCode: number,
): Promise<SandboxResult> {
  let output: { summary?: string; questions?: string[]; error?: string } = {};

  try {
    const archive = await container.getArchive({
      path: "/workspace/repo/.blazebot/output.json",
    });
    const content = await streamToString(archive);
    output = JSON.parse(content);
  } catch {
    return {
      exitCode,
      status: "failed",
      error: "Failed to read .blazebot/output.json from container",
    };
  }

  switch (exitCode) {
    case 0:
      return { exitCode, status: "complete", summary: output.summary ?? "" };
    case 2:
      return {
        exitCode,
        status: "clarification_needed",
        questions: output.questions ?? [],
      };
    default:
      return {
        exitCode,
        status: "failed",
        error: output.error ?? `Agent exited with code ${exitCode}`,
      };
  }
}

async function streamToString(
  stream: NodeJS.ReadableStream,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const content = buffer.subarray(512);
  const nullIndex = content.indexOf(0);
  return content
    .subarray(0, nullIndex > 0 ? nullIndex : content.length)
    .toString("utf-8");
}
