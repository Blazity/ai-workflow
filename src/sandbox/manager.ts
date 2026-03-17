import Docker from "dockerode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../logger.js";

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
  containerId?: string;
};

interface AgentOutput {
  result: "implemented" | "clarification_needed" | "failed";
  summary?: string;
  questions?: string[];
  error?: string;
}

const docker = new Docker();
const logger = createLogger();

export async function teardownContainer(containerId: string): Promise<void> {
  logger.info({ containerId }, "container_teardown_requested");
  try {
    const container = docker.getContainer(containerId);
    await container.kill();
  } catch {
    /* may already be stopped */
  }
  try {
    const container = docker.getContainer(containerId);
    await container.remove({ force: true });
  } catch {
    /* best effort */
  }
}

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

    const startTime = Date.now();
    await container.start();
    logger.info({ containerId: container.id, image: options.image, branchName: options.branchName }, "container_started");

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
      logger.info({ containerId: container.id, exitCode, durationMs: Date.now() - startTime }, "container_exited");
    } catch {
      logger.warn({ containerId: container?.id, timeoutMs: options.timeoutMs }, "container_timeout");
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
        containerId: container?.id,
      };
    }

    return await readResult(container, exitCode);
  } catch (err) {
    return {
      exitCode: -1,
      status: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
      containerId: container?.id,
    };
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
        logger.info({ containerId: container.id }, "container_removed");
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
  const containerId = container.id;
  let output: AgentOutput | null = null;

  try {
    const logs = await container.logs({ stdout: true, stderr: false });
    const stdout = typeof logs === "string" ? logs : logs.toString("utf-8");
    const jsonMatch = stdout.match(/\{[\s\S]*"result"\s*:[\s\S]*\}$/m);
    if (jsonMatch) {
      output = JSON.parse(jsonMatch[0]);
    }
  } catch {
    /* fall through to default handling */
  }

  if (!output) {
    return {
      exitCode,
      status: "failed",
      error: "Agent did not return valid structured JSON output",
      containerId,
    };
  }

  switch (output.result) {
    case "implemented":
      return {
        exitCode,
        status: "complete",
        summary: output.summary ?? "",
        containerId,
      };
    case "clarification_needed":
      return {
        exitCode,
        status: "clarification_needed",
        questions: output.questions ?? [],
        containerId,
      };
    default:
      return {
        exitCode,
        status: "failed",
        error: output.error ?? `Agent returned result: ${output.result}`,
        containerId,
      };
  }
}
