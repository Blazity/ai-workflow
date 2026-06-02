import { describe, it, expect, vi } from "vitest";
import { CodexAgentAdapter } from "./codex.js";

const adapter = new CodexAgentAdapter();

describe("CodexAgentAdapter.parseAgentOutput", () => {
  it("prefers structured JSON when valid", () => {
    const structured = JSON.stringify({ result: "implemented", summary: "ok" });
    const out = adapter.parseAgentOutput("ignored ndjson", structured);
    expect(out.result).toBe("implemented");
    expect(out.summary).toBe("ok");
  });

  it("falls back to NDJSON item.completed when structured is missing", () => {
    const ndjson = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: '{"result":"implemented","summary":"foo"}' },
      }),
    ].join("\n");
    const out = adapter.parseAgentOutput(ndjson, null);
    expect(out.result).toBe("implemented");
    expect(out.summary).toBe("foo");
  });

  it("ignores non-agent_message item.completed events (e.g. tool-call output)", () => {
    // A function_call_output item that happens to carry a `text` field with
    // valid JSON must not be mistaken for the assistant's final message.
    const ndjson = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: '{"result":"implemented","summary":"real"}' },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "function_call_output", text: '{"result":"failed","error":"tool noise"}' },
      }),
    ].join("\n");
    const out = adapter.parseAgentOutput(ndjson, null);
    expect(out.result).toBe("implemented");
    expect(out.summary).toBe("real");
  });

  it("returns failed when both sources are unparseable", () => {
    expect(adapter.parseAgentOutput("not ndjson", null).result).toBe("failed");
  });

  it("returns failed on empty input", () => {
    const out = adapter.parseAgentOutput("", null);
    expect(out.result).toBe("failed");
    expect(out.error).toContain("no output");
  });
});

describe("CodexAgentAdapter.parseResearchStatus", () => {
  it("parses schema-validated structured JSON (completed)", () => {
    const structured = JSON.stringify({
      status: "completed",
      plan: "Plan body",
      questions: null,
      error: null,
    });
    const r = adapter.parseResearchStatus("ndjson irrelevant", structured);
    expect(r.status).toBe("completed");
    expect(r.body).toBe("Plan body");
  });

  it("parses schema-validated structured JSON (clarification_needed) and numbers questions", () => {
    const structured = JSON.stringify({
      status: "clarification_needed",
      plan: null,
      questions: ["First?", "Second?"],
      error: null,
    });
    const r = adapter.parseResearchStatus("", structured);
    expect(r.status).toBe("clarification_needed");
    expect(r.body).toBe("1. First?\n2. Second?");
  });

  it("falls back to JSON inside last agent_message when structured is null", () => {
    const text = JSON.stringify({ status: "failed", plan: null, questions: null, error: "boom" });
    const ndjson = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
    ].join("\n");
    const r = adapter.parseResearchStatus(ndjson, null);
    expect(r.status).toBe("failed");
    expect(r.body).toBe("boom");
  });

  it("falls back to text STATUS line when JSON parsing fails", () => {
    const r = adapter.parseResearchStatus("ndjson irrelevant", "STATUS: completed\n\nbody");
    expect(r.status).toBe("completed");
    expect(r.body).toBe("body");
  });

  it("falls back to text STATUS line from last item.completed message", () => {
    const ndjson = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "STATUS: failed\n\nreason" } }),
    ].join("\n");
    expect(adapter.parseResearchStatus(ndjson, null).status).toBe("failed");
  });

  it("returns failed when no STATUS line and no JSON is present", () => {
    expect(adapter.parseResearchStatus("no status here", null).status).toBe("failed");
  });
});

describe("CodexAgentAdapter.parseReviewOutput", () => {
  it("parses approved with empty issues from structured", () => {
    const structured = JSON.stringify({ result: "approved", feedback: "looks good", issues: [] });
    expect(adapter.parseReviewOutput("", structured).result).toBe("approved");
  });

  it("returns failed on empty input", () => {
    expect(adapter.parseReviewOutput("", null).result).toBe("failed");
  });
});

describe("CodexAgentAdapter.extractUsage", () => {
  it("sums usage across multiple turn.completed events", () => {
    const ndjson = [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 200, cached_input_tokens: 10 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 50, output_tokens: 75, cached_input_tokens: 5 } }),
    ].join("\n");
    const u = adapter.extractUsage(ndjson, null);
    expect(u).toMatchObject({
      cost_usd: null,
      tokens: { input: 150, cached_input: 15, output: 275 },
      duration_api_ms: 0,
      num_turns: 2,
    });
  });

  it("computes duration_ms from event timestamps when available", () => {
    const t0 = "2026-04-27T10:00:00.000Z";
    const t1 = "2026-04-27T10:02:00.000Z";
    const ndjson = [
      JSON.stringify({ type: "thread.started", timestamp: t0 }),
      JSON.stringify({ type: "turn.completed", timestamp: t1, usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }),
    ].join("\n");
    const u = adapter.extractUsage(ndjson, null);
    expect(u?.duration_ms).toBe(120_000);
  });

  it("returns null when no turn.completed event is present", () => {
    expect(adapter.extractUsage("\n", null)).toBeNull();
  });

  it("falls back to phase.duration synthetic event when events lack timestamps", () => {
    const ndjson = [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 20, cached_input_tokens: 0 } }),
      JSON.stringify({ type: "phase.duration", duration_ms: 90_000 }),
    ].join("\n");
    const u = adapter.extractUsage(ndjson, null);
    expect(u?.duration_ms).toBe(90_000);
  });

  it("prefers event-derived duration over wall-clock when both are present", () => {
    const t0 = "2026-04-27T10:00:00.000Z";
    const t1 = "2026-04-27T10:01:00.000Z";
    const ndjson = [
      JSON.stringify({ type: "thread.started", timestamp: t0 }),
      JSON.stringify({ type: "turn.completed", timestamp: t1, usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }),
      JSON.stringify({ type: "phase.duration", duration_ms: 99_999 }),
    ].join("\n");
    expect(adapter.extractUsage(ndjson, null)?.duration_ms).toBe(60_000);
  });
});

describe("CodexAgentAdapter.buildPhaseScript", () => {
  it("research phase uses -o and accepts --output-schema when supplied", () => {
    const paths = adapter.artifactPaths("research");
    const baseScript = adapter.buildPhaseScript({ phase: "research", model: "gpt-5-codex", paths });
    expect(baseScript).toContain("codex exec");
    // We bypass Codex's inner sandbox because Vercel Sandbox (outer microVM)
    // already provides isolation and blocks bwrap's user-namespace syscall.
    expect(baseScript).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(baseScript).not.toContain("--full-auto");
    expect(baseScript).toContain("--skip-git-repo-check");
    expect(baseScript).toContain("--json");
    expect(baseScript).toContain("-o /tmp/research-result.json");

    const withSchema = adapter.buildPhaseScript({
      phase: "research",
      model: "gpt-5-codex",
      paths,
      jsonSchema: '{"type":"object"}',
    });
    expect(withSchema).toContain("--output-schema /tmp/research-schema.json");
  });

  it("impl phase uses --output-schema with a quoted heredoc", () => {
    const paths = adapter.artifactPaths("impl");
    const s = adapter.buildPhaseScript({
      phase: "impl",
      model: "gpt-5-codex",
      paths,
      jsonSchema: '{"type":"object"}',
    });
    expect(s).toContain("--output-schema /tmp/impl-schema.json");
    expect(s).toContain("'SCHEMA_EOF'");
  });

  it("schema body containing apostrophes passes through literally", () => {
    const paths = adapter.artifactPaths("impl");
    const tricky = `{"description":"don't break","x":"a\`b$c"}`;
    const s = adapter.buildPhaseScript({ phase: "impl", model: "gpt-5-codex", paths, jsonSchema: tricky });
    expect(s).toContain(tricky);
  });

  it("removes stale phase artifacts before invoking codex", () => {
    const paths = adapter.artifactPaths("impl");
    const s = adapter.buildPhaseScript({ phase: "impl", model: "gpt-5-codex", paths });
    expect(s).toContain(`rm -f ${paths.sentinel} ${paths.stdout} ${paths.stderr} ${paths.structuredOutput}`);
    expect(s).toContain(`touch ${paths.sentinel}`);
  });

  it("emits a phase.duration NDJSON event after codex exits", () => {
    const paths = adapter.artifactPaths("impl");
    const s = adapter.buildPhaseScript({ phase: "impl", model: "gpt-5-codex", paths });
    expect(s).toContain("START_MS=$(date +%s%3N)");
    expect(s).toContain("END_MS=$(date +%s%3N)");
    expect(s).toContain('\\"type\\":\\"phase.duration\\"');
  });
});

describe("CodexAgentAdapter.artifactPaths", () => {
  it("includes structuredOutput pointing at -o file", () => {
    expect(adapter.artifactPaths("impl").structuredOutput).toBe("/tmp/impl-result.json");
  });
});

describe("CodexAgentAdapter.configure", () => {
  it("adds .codex/ to .git/info/exclude so the agent never sees session pollution", async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const sandbox = { runCommand, writeFiles } as any;
    await adapter.configure(sandbox, { codexApiKey: "sk-test", model: "gpt-5-codex" });
    const excludeCall = runCommand.mock.calls.find(
      ([cmd, args]) =>
        cmd === "bash" &&
        typeof args?.[1] === "string" &&
        args[1].includes(".git/info/exclude"),
    );
    expect(excludeCall).toBeDefined();
    expect(excludeCall![1][1]).toContain(".codex/");
  });
});

describe("CodexAgentAdapter.setCommitGuard", () => {
  it("upserts the Stop hook with matcher/hooks shape when enabled", async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const sandbox = { runCommand, writeFiles: vi.fn() } as any;
    await adapter.setCommitGuard(sandbox, true);
    const merge = runCommand.mock.calls.find(([cmd, args]) =>
      cmd === "node" && typeof args[2] === "string" && args[2].includes('"commitGuard":"enable"'),
    );
    expect(merge).toBeDefined();
    // The merge script must wrap commands as { matcher, hooks: [{type,command}] } —
    // not the flat { type, command } shape Codex would silently ignore.
    expect(merge![1][2]).toContain("hooks: [{ type: 'command', command }]");
  });

  it("writes a guard script that reads stop_hook_active and emits decision:block", async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const sandbox = { runCommand, writeFiles: vi.fn() } as any;
    await adapter.setCommitGuard(sandbox, true);
    const writeScript = runCommand.mock.calls.find(([cmd, args]) =>
      cmd === "bash" && typeof args[1] === "string" && args[1].includes("commit-guard.sh"),
    );
    expect(writeScript).toBeDefined();
    const body: string = writeScript![1][1];
    expect(body).toContain('"stop_hook_active":true');
    expect(body).toContain('"decision":"block"');
    // Must NOT use the wrong protocol (continue:false stops the hook, not Codex).
    expect(body).not.toContain('"continue":false');
  });
});
