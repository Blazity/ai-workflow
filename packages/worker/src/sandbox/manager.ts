import Docker from "dockerode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "@blazebot/shared";

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
export async function pushBranchFromContainer(
  containerId: string,
  branchName: string,
): Promise<void> {
  const container = docker.getContainer(containerId);
  try {
    // Commit the stopped container's filesystem to a temporary image, then
    // run a new container from it with the push command. This is necessary
    // because docker exec requires a running container.
    const commitResult = await container.commit({
      repo: "blazebot-push-tmp",
      tag: "latest",
    });
    const pushContainer = await docker.createContainer({
      Image: (commitResult as { Id?: string }).Id ?? "blazebot-push-tmp:latest",
      Entrypoint: ["/bin/bash", "-c"],
      Cmd: [
        `cd /workspace/repo && /usr/bin/git push origin HEAD:${branchName} 2>&1`,
      ],
      User: "kasin-it",
    });
    try {
      await pushContainer.start();
      const waitResult = await pushContainer.wait();
      const pushLogs = await readAllContainerLogs(pushContainer);
      const output = sanitizeForLog(pushLogs.stdout + pushLogs.stderr);
      if (waitResult.StatusCode !== 0) {
        logger.warn(
          { containerId, branchName, exitCode: waitResult.StatusCode, output },
          "branch_push_failed",
        );
      } else {
        logger.info({ containerId, branchName, output }, "branch_pushed");
      }
    } finally {
      try {
        await pushContainer.remove({ force: true });
      } catch {
        /* best effort */
      }
    }
  } catch (err) {
    logger.warn(
      {
        containerId,
        branchName,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      "branch_push_failed",
    );
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
      Labels: { blazebot: "true", "blazebot.branch": options.branchName },
      Env: [
        `BLAZEBOT_BRANCH=${options.branchName}`,
        `GITHUB_TOKEN=${options.githubToken}`,
        `REPO_URL=${options.repoUrl}`,
        `CLAUDE_CODE_OAUTH_TOKEN=${options.oauthToken}`,
        `CLAUDE_MODEL=${options.model}`,
        `DEVELOPER_MODE=${options.developerMode}`,
      ],
      HostConfig: {
        Memory: options.memoryLimitMb * 1024 * 1024,
        Binds: [`${tmpDir}:/inject:ro`],
      },
    });

    const startTime = Date.now();
    await container.start();
    logger.info(
      {
        containerId: container.id,
        image: options.image,
        branchName: options.branchName,
      },
      "container_started",
    );

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
      logger.info(
        {
          containerId: container.id,
          exitCode,
          durationMs: Date.now() - startTime,
        },
        "container_exited",
      );
    } catch {
      logger.warn(
        { containerId: container?.id, timeoutMs: options.timeoutMs },
        "container_timeout",
      );
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

export async function cleanupOrphanContainers(): Promise<void> {
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ["blazebot=true"] },
    });

    if (containers.length === 0) {
      logger.info("orphan_cleanup_none_found");
      return;
    }

    logger.info({ count: containers.length }, "orphan_cleanup_started");

    for (const containerInfo of containers) {
      try {
        await teardownContainer(containerInfo.Id);
        logger.info(
          { containerId: containerInfo.Id },
          "orphan_container_removed",
        );
      } catch {
        logger.warn(
          { containerId: containerInfo.Id },
          "orphan_container_removal_failed",
        );
      }
    }

    logger.info({ removed: containers.length }, "orphan_cleanup_complete");
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : "Unknown error" },
      "orphan_cleanup_failed",
    );
  }
}

function sanitizeForLog(text: string): string {
  return text.slice(-1000);
}

/**
 * Read all container logs (both stdout and stderr) in a single call,
 * then demux the multiplexed stream into separate strings.
 */
async function readAllContainerLogs(
  container: Docker.Container,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const raw = await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
    });

    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "binary");
    return demuxDockerStream(buf);
  } catch {
    return { stdout: "", stderr: "" };
  }
}

/**
 * Docker multiplexed streams have an 8-byte header per frame:
 *   byte 0: stream type (0=stdin, 1=stdout, 2=stderr)
 *   bytes 4-7: payload length (big-endian uint32)
 * We separate frames into stdout and stderr.
 * If the buffer doesn't look multiplexed, return everything as stdout.
 */
function demuxDockerStream(buf: Buffer): { stdout: string; stderr: string } {
  if (buf.length < 8) return { stdout: buf.toString("utf-8"), stderr: "" };

  const firstByte = buf[0];
  if (firstByte !== 0 && firstByte !== 1 && firstByte !== 2) {
    return { stdout: buf.toString("utf-8"), stderr: "" };
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const type = buf[offset];
    if (type !== 0 && type !== 1 && type !== 2) break;
    const len = buf.readUInt32BE(offset + 4);
    if (offset + 8 + len > buf.length) break;
    const text = buf.subarray(offset + 8, offset + 8 + len).toString("utf-8");
    if (type === 1) stdoutChunks.push(text);
    if (type === 2) stderrChunks.push(text);
    offset += 8 + len;
  }

  // If we didn't parse any frames, the stream isn't multiplexed
  if (stdoutChunks.length === 0 && stderrChunks.length === 0) {
    return { stdout: buf.toString("utf-8"), stderr: "" };
  }

  return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

/**
 * Claude Code with `--output-format json --json-schema <schema>` returns an envelope:
 *   { "type": "result", "subtype": "success", "result": "...", "structured_output": { ... } }
 * Our agent schema lives in `structured_output`. If `--json-schema` was not honoured
 * (older Claude Code, or schema error) we fall back to parsing the envelope `result` field.
 */
function parseAgentOutput(stdout: string): AgentOutput | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const envelope = JSON.parse(line);

      if (
        envelope.structured_output &&
        typeof envelope.structured_output.result === "string"
      ) {
        return envelope.structured_output as AgentOutput;
      }

      if (
        envelope.result &&
        typeof envelope.result === "string" &&
        ["implemented", "clarification_needed", "failed"].includes(
          envelope.result,
        )
      ) {
        return envelope as AgentOutput;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function readResult(
  container: Docker.Container,
  exitCode: number,
): Promise<SandboxResult> {
  const containerId = container.id;

  const { stdout, stderr } = await readAllContainerLogs(container);
  const output = parseAgentOutput(stdout);

  if (!output) {
    const diagnostic =
      sanitizeForLog(stderr || stdout) || "(no output captured)";
    logger.error(
      { containerId, exitCode, diagnostic },
      "container_no_structured_output",
    );
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
