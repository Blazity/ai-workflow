/**
 * Diagnostic: provision a bare sandbox, install the Arthur tracer the same way
 * SandboxManager does, and inspect what actually landed.
 *
 * Usage:
 *   pnpm build:arthur-tracer
 *   npx tsx scripts/test-arthur-sandbox.ts
 *
 * Reads GENAI_ENGINE_API_KEY / TASK_ID / TRACE_ENDPOINT from env (.env).
 */

import "dotenv/config";
import { Sandbox } from "@vercel/sandbox";
import { ARTHUR_TRACER_PY_BASE64 } from "../src/sandbox/arthur-tracer.js";

async function run(sandbox: Awaited<ReturnType<typeof Sandbox.create>>, label: string, cmd: string, args: string[]) {
  const r = await sandbox.runCommand(cmd, args);
  const stdout = (await r.stdout()).trim();
  const stderr = (await r.stderr()).trim();
  console.log(`--- ${label} (exit=${r.exitCode}) ---`);
  if (stdout) console.log("stdout:", stdout.slice(0, 1200));
  if (stderr) console.log("stderr:", stderr.slice(0, 1200));
  console.log();
  return r;
}

async function main() {
  const apiKey = process.env.GENAI_ENGINE_API_KEY;
  const taskId = process.env.GENAI_ENGINE_TASK_ID;
  const endpoint = process.env.GENAI_ENGINE_TRACE_ENDPOINT;
  if (!apiKey || !taskId || !endpoint) {
    console.error("Missing GENAI_ENGINE_{API_KEY,TASK_ID,TRACE_ENDPOINT} in env/.env");
    process.exit(1);
  }

  console.log("=== Provisioning sandbox (node24) ===\n");
  const sandbox = await Sandbox.create({ runtime: "node24", timeout: 300_000 });
  console.log(`sandboxId=${sandbox.sandboxId}\n`);

  try {
    await run(sandbox, "which python3", "bash", ["-c", "command -v python3 || echo MISSING"]);
    await run(sandbox, "python3 --version", "bash", ["-c", "python3 --version 2>&1 || echo MISSING"]);
    await run(sandbox, "which pip3", "bash", ["-c", "command -v pip3 || echo MISSING"]);
    await run(sandbox, "pip3 --version", "bash", ["-c", "pip3 --version 2>&1 || echo MISSING"]);

    console.log("=== pip bootstrap + install (same command as installArthurTracer) ===\n");
    await run(sandbox, "ensurepip + pip install", "bash", [
      "-c",
      "python3 -m ensurepip --user && python3 -m pip install --user --quiet 'opentelemetry-sdk>=1.20.0' 'opentelemetry-exporter-otlp-proto-http>=1.20.0' 2>&1",
    ]);

    await run(sandbox, "python3 -c import otel", "bash", [
      "-c",
      "python3 -c 'import opentelemetry.sdk, opentelemetry.exporter.otlp.proto.http.trace_exporter; print(\"OK\")' 2>&1",
    ]);

    console.log("=== Writing tracer + config ===\n");
    const tracerBytes = Buffer.from(ARTHUR_TRACER_PY_BASE64, "base64");
    await sandbox.writeFiles([{ path: "/tmp/arthur-tracer.py", content: tracerBytes }]);
    await run(sandbox, "mv tracer", "bash", [
      "-c",
      "mkdir -p $HOME/.claude/hooks && mv /tmp/arthur-tracer.py $HOME/.claude/hooks/claude_code_tracer.py && chmod +x $HOME/.claude/hooks/claude_code_tracer.py && ls -l $HOME/.claude/hooks/",
    ]);

    const configJson = JSON.stringify({ api_key: apiKey, task_id: taskId, endpoint }, null, 2);
    await sandbox.writeFiles([{ path: "/tmp/arthur_config.json", content: Buffer.from(configJson) }]);
    await run(sandbox, "mv config", "bash", [
      "-c",
      "mkdir -p $HOME/.claude && mv /tmp/arthur_config.json $HOME/.claude/arthur_config.json && chmod 600 $HOME/.claude/arthur_config.json && ls -l $HOME/.claude/arthur_config.json",
    ]);

    console.log("=== Dry-run the tracer directly with a synthetic UserPromptSubmit payload ===\n");
    // Feed the tracer a minimal hook payload so it attempts to build+send a trace.
    await run(sandbox, "tracer user_prompt_submit", "bash", [
      "-c",
      `cat <<'JSON' | python3 $HOME/.claude/hooks/claude_code_tracer.py user_prompt_submit 2>&1
{"session_id":"diag-session","prompt":"hello from diagnostic","cwd":"/tmp"}
JSON`,
    ]);

    console.log("=== Check the tracer's own log (if any) ===\n");
    await run(sandbox, "ls ~/.claude", "bash", ["-c", "ls -la $HOME/.claude/ 2>&1 || true"]);
    await run(sandbox, "tracer log tail", "bash", [
      "-c",
      "find $HOME/.claude -maxdepth 3 -name '*.log' -o -name 'trace*' 2>/dev/null | head -20 && echo --- && for f in $(find $HOME/.claude -maxdepth 3 -name '*.log' 2>/dev/null); do echo \">>> $f\"; tail -n 40 $f; done",
    ]);

    console.log("=== Curl the endpoint from inside the sandbox ===\n");
    await run(sandbox, "curl endpoint", "bash", [
      "-c",
      `curl -sS -o /tmp/curl.out -w 'HTTP %{http_code} time=%{time_total}s\\n' -X POST '${endpoint}' -H 'Content-Type: application/x-protobuf' -H 'Authorization: Bearer ${apiKey}' -H 'ngrok-skip-browser-warning: true' --data-binary '' --max-time 10; echo '---'; head -c 400 /tmp/curl.out`,
    ]);
  } finally {
    console.log("\n=== Stopping sandbox ===");
    await sandbox.stop().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
