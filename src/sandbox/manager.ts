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

/**
 * Push the feature branch from inside a stopped container.
 * Restarts the container with a push-only command, then stops it.
 * Must be called before teardownContainer / container removal.
 */
export async function pushBranchFromContainer(containerId: string, branchName: string): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    // Commit the stopped container's filesystem to a temporary image, then
    // run a new container from it with the push command. This is necessary
    // because docker exec requires a running container.
    const commitResult = await container.commit({ repo: "blazebot-push-tmp", tag: "latest" });
    const pushContainer = await docker.createContainer({
      Image: (commitResult as { Id?: string }).Id ?? "blazebot-push-tmp:latest",
      Cmd: ["/bin/bash", "-c", `cd /workspace/repo && /usr/bin/git push origin ${branchName}`],
      User: "blazebot",
    });
    try {
      await pushContainer.start();
      const waitResult = await pushContainer.wait();
      if (waitResult.StatusCode !== 0) {
        const stderr = await readContainerLogs(pushContainer, "stderr");
        logger.warn({ containerId, branchName, exitCode: waitResult.StatusCode, stderr: sanitizeForLog(stderr) }, "branch_push_failed");
      } else {
        logger.info({ containerId, branchName }, "branch_pushed");
      }
    } finally {
      try { await pushContainer.remove({ force: true }); } catch { /* best effort */ }
    }
  } catch (err) {
    logger.warn({ containerId, branchName, error: err instanceof Error ? err.message : "Unknown error" }, "branch_push_failed");
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

    const sandboxResult = await readResult(container, exitCode);

    // Container is NOT removed here — the worker handles push + teardown
    return sandboxResult;
  } catch (err) {
    return {
      exitCode: -1,
      status: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
      containerId: container?.id,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function sanitizeForLog(text: string): string {
  // Truncate to last 1000 chars — enough for diagnostics, bounded for safety.
  return text.slice(-1000);
}

async function readContainerLogs(
  container: Docker.Container,
  stream: "stdout" | "stderr",
): Promise<string> {
  try {
    const raw = await container.logs({
      stdout: stream === "stdout",
      stderr: stream === "stderr",
      follow: false,
    });

    // dockerode may return a Buffer or string
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "binary");

    return demuxDockerStream(buf, stream === "stdout" ? 1 : 2);
  } catch {
    return "";
  }
}

/**
 * Docker multiplexed streams have an 8-byte header per frame:
 *   byte 0: stream type (0=stdin, 1=stdout, 2=stderr)
 *   bytes 4-7: payload length (big-endian uint32)
 * We extract only frames matching the requested stream type.
 * If the buffer doesn't look multiplexed, return as plain text.
 */
function demuxDockerStream(buf: Buffer, streamType: number): string {
  if (buf.length < 8) return buf.toString("utf-8");

  const firstByte = buf[0];
  if (firstByte !== 0 && firstByte !== 1 && firstByte !== 2) {
    // Not a multiplexed stream — return as-is
    return buf.toString("utf-8");
  }

  const chunks: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const type = buf[offset];
    if (type !== 0 && type !== 1 && type !== 2) break;
    const len = buf.readUInt32BE(offset + 4);
    if (offset + 8 + len > buf.length) break;
    if (type === streamType) {
      chunks.push(buf.subarray(offset + 8, offset + 8 + len).toString("utf-8"));
    }
    offset += 8 + len;
  }
  return chunks.join("");
}

async function readResult(
  container: Docker.Container,
  exitCode: number,
): Promise<SandboxResult> {
  const containerId = container.id;
  let output: AgentOutput | null = null;

  const stdout = await readContainerLogs(container, "stdout");
  const stderr = await readContainerLogs(container, "stderr");

  try {
    const jsonMatch = stdout.match(/\{[\s\S]*"result"\s*:[\s\S]*\}$/m);
    if (jsonMatch) {
      output = JSON.parse(jsonMatch[0]);
    }
  } catch {
    /* fall through to default handling */
  }

  if (!output) {
    const diagnostic = sanitizeForLog(stderr || stdout) || "(no output captured)";
    logger.error({ containerId, exitCode, diagnostic }, "container_no_structured_output");
    return {
      exitCode,
      status: "failed",
      error: `Agent did not return valid structured JSON output. Container output: ${diagnostic.slice(-500)}`,
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
