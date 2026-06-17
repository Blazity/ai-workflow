import { describe, it, expect, vi } from "vitest";
import { ClaudeAgentAdapter } from "./claude.js";
import { AGENT_SCHEMA, RESEARCH_SCHEMA, REVIEW_SCHEMA } from "./types.js";

const adapter = new ClaudeAgentAdapter();

describe("ClaudeAgentAdapter.parseAgentOutput", () => {
  it("parses implemented result", () => {
    const raw = JSON.stringify({ result: "implemented", summary: "done" });
    expect(adapter.parseAgentOutput(raw, null).result).toBe("implemented");
  });

  it("parses clarification_needed result", () => {
    const raw = JSON.stringify({
      result: "clarification_needed",
      questions: ["What OAuth provider?", "Should we support SSO?"],
    });
    const out = adapter.parseAgentOutput(raw, null);
    expect(out.result).toBe("clarification_needed");
    expect(out.questions).toHaveLength(2);
  });

  it("parses failed result", () => {
    const raw = JSON.stringify({ result: "failed", error: "Tests do not pass" });
    const out = adapter.parseAgentOutput(raw, null);
    expect(out.result).toBe("failed");
    expect(out.error).toBe("Tests do not pass");
  });

  it("returns failed on empty output", () => {
    expect(adapter.parseAgentOutput("", null).result).toBe("failed");
  });

  it("returns failed on garbage", () => {
    const out = adapter.parseAgentOutput("not json at all", null);
    expect(out.result).toBe("failed");
    expect(out.error).toContain("not structured JSON");
  });

  it("returns failed on JSON missing result field", () => {
    expect(adapter.parseAgentOutput(JSON.stringify({ summary: "oops" }), null).result).toBe("failed");
  });

  it("parses structured_output from result envelope", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "freeform text",
      structured_output: { result: "implemented", summary: "Renamed endpoint" },
    });
    expect(adapter.parseAgentOutput(envelope, null).summary).toBe("Renamed endpoint");
  });

  it("falls back to event.result as JSON when structured_output is missing", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({ result: "clarification_needed", questions: ["Which DB?"] }),
    });
    const out = adapter.parseAgentOutput(envelope, null);
    expect(out.result).toBe("clarification_needed");
    expect(out.questions).toEqual(["Which DB?"]);
  });

  it("fails (not infers implemented) when envelope is success but payload is plain text", () => {
    // Claude runs with --json-schema; a success envelope without structured
    // output means the schema didn't kick in. Don't silently call that a win.
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 6404,
      num_turns: 1,
      result: "\n\nI kept the response as-is to match the acceptance criteria.\n",
    });
    const out = adapter.parseAgentOutput(envelope, null);
    expect(out.result).toBe("failed");
    expect(out.error).toContain("acceptance criteria");
  });

  it("infers failed when result envelope has error status", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Agent crashed unexpectedly",
    });
    const out = adapter.parseAgentOutput(envelope, null);
    expect(out.result).toBe("failed");
    expect(out.error).toContain("crashed");
  });

  it("ignores the structured argument (Claude embeds output in raw)", () => {
    const raw = JSON.stringify({ result: "implemented", summary: "via raw" });
    expect(adapter.parseAgentOutput(raw, "ignored payload").summary).toBe("via raw");
  });
});

describe("ClaudeAgentAdapter.parseResearchStatus", () => {
  it("parses structured_output JSON from result envelope (completed)", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      structured_output: {
        status: "completed",
        plan: "Step 1: edit foo.ts\nStep 2: run tests",
        questions: null,
        error: null,
      },
    });
    const r = adapter.parseResearchStatus(envelope, null);
    expect(r.status).toBe("completed");
    expect(r.body).toContain("Step 1");
  });

  it("parses structured_output JSON (clarification_needed) and numbers questions", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      structured_output: {
        status: "clarification_needed",
        plan: null,
        questions: ["Which database?", "Which auth provider?"],
        error: null,
      },
    });
    const r = adapter.parseResearchStatus(envelope, null);
    expect(r.status).toBe("clarification_needed");
    expect(r.body).toBe("1. Which database?\n2. Which auth provider?");
  });

  it("parses structured_output JSON (failed) and exposes error in body", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      structured_output: { status: "failed", plan: null, questions: null, error: "Could not read repo" },
    });
    const r = adapter.parseResearchStatus(envelope, null);
    expect(r.status).toBe("failed");
    expect(r.body).toBe("Could not read repo");
  });

  it("parses direct JSON output when there is no Claude envelope", () => {
    const raw = JSON.stringify({ status: "completed", plan: "Plan", questions: null, error: null });
    expect(adapter.parseResearchStatus(raw, null).status).toBe("completed");
  });

  it("parses JSON encoded in envelope.result string (no structured_output)", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: JSON.stringify({ status: "completed", plan: "P", questions: null, error: null }),
    });
    expect(adapter.parseResearchStatus(envelope, null).status).toBe("completed");
  });

  it("fails when output is a STATUS text line (no schema-validated JSON)", () => {
    // Claude runs with --json-schema; if we only see a STATUS text line then
    // the schema didn't enforce. Don't fall back to fuzzy text matching —
    // surface the anomaly instead of pretending it worked.
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "STATUS: completed\n\nPlan body here",
    });
    expect(adapter.parseResearchStatus(envelope, null).status).toBe("failed");
  });

  it("fails when no JSON payload is present", () => {
    expect(adapter.parseResearchStatus("no status here", null).status).toBe("failed");
  });

  it("error body for failed parse includes the raw prefix for debugging", () => {
    const out = adapter.parseResearchStatus("garbage in, garbage out", null);
    expect(out.body).toContain("garbage in, garbage out");
  });
});

describe("ClaudeAgentAdapter.parseReviewOutput", () => {
  it("parses approved with empty issues", () => {
    const raw = JSON.stringify({ result: "approved", feedback: "looks good", issues: [] });
    expect(adapter.parseReviewOutput(raw, null).result).toBe("approved");
  });

  it("parses approved with critical issues", () => {
    const raw = JSON.stringify({
      result: "approved",
      feedback: "Fixed several issues",
      issues: [{ file: "src/foo.ts", description: "Fixed null check", severity: "critical" }],
    });
    const out = adapter.parseReviewOutput(raw, null);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].severity).toBe("critical");
  });

  it("returns failed on empty input", () => {
    expect(adapter.parseReviewOutput("", null).result).toBe("failed");
  });

  it("returns failed on unparseable output", () => {
    const out = adapter.parseReviewOutput("not json", null);
    expect(out.result).toBe("failed");
    expect(out.error).toBeDefined();
  });

  it("extracts from result envelope structured_output", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: { result: "approved", feedback: "All good", issues: [] },
    });
    expect(adapter.parseReviewOutput(envelope, null).result).toBe("approved");
  });
});

describe("schema constants", () => {
  it("AGENT_SCHEMA is valid JSON", () => {
    expect(() => JSON.parse(AGENT_SCHEMA)).not.toThrow();
  });
  it("REVIEW_SCHEMA is valid JSON", () => {
    expect(() => JSON.parse(REVIEW_SCHEMA)).not.toThrow();
  });
  it("RESEARCH_SCHEMA is valid JSON with the expected fields", () => {
    const s = JSON.parse(RESEARCH_SCHEMA);
    expect(s.required).toEqual(["status", "plan", "questions", "error"]);
    expect(s.properties.status.enum).toEqual(["completed", "clarification_needed", "failed"]);
  });
});

describe("ClaudeAgentAdapter.extractUsage", () => {
  it("extracts cost_usd from a result envelope", () => {
    const raw = JSON.stringify({
      type: "result", subtype: "success",
      cost_usd: 0.42, duration_ms: 60_000, duration_api_ms: 30_000, num_turns: 3,
      result: "ok",
    });
    expect(adapter.extractUsage(raw, null)).toEqual({
      cost_usd: 0.42,
      tokens: null,
      duration_ms: 60_000,
      duration_api_ms: 30_000,
      num_turns: 3,
    });
  });

  it("parses token counts from the envelope usage object", () => {
    const raw = JSON.stringify({
      type: "result", subtype: "success",
      total_cost_usd: 0.34, duration_ms: 60_000, duration_api_ms: 30_000, num_turns: 3,
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 5_000,
        output_tokens: 400,
      },
      result: "ok",
    });
    expect(adapter.extractUsage(raw, null)?.tokens).toEqual({
      input: 120,
      cached_input: 5_000,
      output: 400,
    });
  });

  it("returns null when no envelope is present", () => {
    expect(adapter.extractUsage("not json", null)).toBeNull();
  });
});

describe("ClaudeAgentAdapter.buildPhaseScript", () => {
  it("research phase emits a script that sources agent-env.sh and invokes claude", () => {
    const paths = adapter.artifactPaths("research");
    const s = adapter.buildPhaseScript({ phase: "research", model: "claude-opus-4-6", paths });
    expect(s).toContain("#!/bin/bash");
    expect(s).toContain("claude");
    expect(s).toContain("--model 'claude-opus-4-6'");
    expect(s).toContain("--output-format json");
    expect(s).toContain("/tmp/research-requirements.md");
    expect(s).toContain("/tmp/research-stdout.txt");
    expect(s).toContain("/tmp/research-stderr.txt");
    expect(s).toContain("/tmp/research-done");
  });

  it("research phase includes --json-schema when supplied", () => {
    const paths = adapter.artifactPaths("research");
    const s = adapter.buildPhaseScript({
      phase: "research",
      model: "claude-opus-4-6",
      paths,
      jsonSchema: '{"type":"object"}',
    });
    expect(s).toContain("--json-schema");
  });

  it("impl phase includes --json-schema when supplied", () => {
    const paths = adapter.artifactPaths("impl");
    const s = adapter.buildPhaseScript({
      phase: "impl",
      model: "claude-opus-4-6",
      paths,
      jsonSchema: '{"type":"object"}',
    });
    expect(s).toContain("--json-schema");
    expect(s).toContain("/tmp/impl-requirements.md");
    expect(s).toContain("/tmp/impl-done");
  });

  it("review phase includes --json-schema when supplied", () => {
    const paths = adapter.artifactPaths("review");
    const s = adapter.buildPhaseScript({
      phase: "review",
      model: "claude-opus-4-6",
      paths,
      jsonSchema: '{"type":"object"}',
    });
    expect(s).toContain("--json-schema");
    expect(s).toContain("/tmp/review-requirements.md");
    expect(s).toContain("/tmp/review-done");
  });

  it("includes cleanup and sentinel touch in correct order", () => {
    const paths = adapter.artifactPaths("research");
    const s = adapter.buildPhaseScript({ phase: "research", model: "claude-opus-4-6", paths });
    expect(s).toContain("rm -rf .claude/");
    expect(s).toContain("touch /tmp/research-done");
    const cleanupIdx = s.indexOf("rm -f /tmp/research-done /tmp/research-stdout.txt /tmp/research-stderr.txt");
    const claudeIdx = s.indexOf("| claude");
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(claudeIdx);
  });

  it("escapes single quotes in json schema", () => {
    const paths = adapter.artifactPaths("impl");
    const s = adapter.buildPhaseScript({
      phase: "impl",
      model: "claude-opus-4-6",
      paths,
      jsonSchema: `{"type":"object","desc":"it's"}`,
    });
    // Schema appears inside a single-quoted shell string; raw apostrophe must
    // be escaped via the '\'' sequence to avoid closing the quote prematurely.
    expect(s).not.toContain("it's\"}");
    expect(s).toContain("it'\\''s");
  });
});

describe("ClaudeAgentAdapter.artifactPaths", () => {
  it("returns Claude paths with structuredOutput=null", () => {
    expect(adapter.artifactPaths("research")).toEqual({
      wrapper: "/tmp/research-wrapper.sh",
      input: "/tmp/research-requirements.md",
      stdout: "/tmp/research-stdout.txt",
      stderr: "/tmp/research-stderr.txt",
      sentinel: "/tmp/research-done",
      structuredOutput: null,
    });
  });
});

describe("ClaudeAgentAdapter.setCommitGuard", () => {
  it("upserts the Stop hook when enabled and writes commit-guard.sh", async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const sandbox = { runCommand, writeFiles } as any;

    await adapter.setCommitGuard(sandbox, true);

    const calls = runCommand.mock.calls;
    expect(calls.some(([cmd, args]) => cmd === "bash" && args[1].includes("commit-guard.sh"))).toBe(true);
    const mergeCall = calls.find(([cmd, args]) =>
      cmd === "node" && args[1] === "-e" && args[2].includes('"commitGuard":"enable"'),
    );
    expect(mergeCall).toBeDefined();
  });

  it("disables by writing commitGuard=disable directive", async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const sandbox = { runCommand, writeFiles: vi.fn() } as any;

    await adapter.setCommitGuard(sandbox, false);

    const mergeCall = runCommand.mock.calls.find(([cmd, args]) =>
      cmd === "node" && typeof args[2] === "string" && args[2].includes('"commitGuard":"disable"'),
    );
    expect(mergeCall).toBeDefined();
  });
});
