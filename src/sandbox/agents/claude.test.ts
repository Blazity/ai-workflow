import { describe, it, expect, vi } from "vitest";
import { ClaudeAgentAdapter } from "./claude.js";
import { AGENT_SCHEMA, REVIEW_SCHEMA } from "./types.js";

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

  it("infers implemented when result envelope has success but text output", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 6404,
      num_turns: 1,
      result: "\n\nI kept the response as-is to match the acceptance criteria.\n",
    });
    const out = adapter.parseAgentOutput(envelope, null);
    expect(out.result).toBe("implemented");
    expect(out.summary).toContain("acceptance criteria");
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
  it("parses a STATUS line and returns the body", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "STATUS: completed\n\nPlan body here",
    });
    const r = adapter.parseResearchStatus(envelope, null);
    expect(r.status).toBe("completed");
    expect(r.body).toBe("Plan body here");
  });

  it("parses clarification_needed with numbered questions", () => {
    const raw = "STATUS: clarification_needed\n\n1. What database?\n2. Which auth?";
    const r = adapter.parseResearchStatus(raw, null);
    expect(r.status).toBe("clarification_needed");
    expect(r.body).toContain("What database?");
  });

  it("parses failed status", () => {
    expect(adapter.parseResearchStatus("STATUS: failed\n\nCould not access repository", null).status).toBe("failed");
  });

  it("falls back to failed when no STATUS line is present", () => {
    expect(adapter.parseResearchStatus("no status here", null).status).toBe("failed");
  });

  it("handles STATUS line with extra whitespace", () => {
    expect(adapter.parseResearchStatus("  STATUS:   completed  \n\nPlan here", null).status).toBe("completed");
  });

  it("handles leading blank lines before STATUS", () => {
    const r = adapter.parseResearchStatus("\n\nSTATUS: clarification_needed\n\n1. Which provider?", null);
    expect(r.status).toBe("clarification_needed");
    expect(r.body).toContain("Which provider?");
  });

  it("normalizes uppercase status values", () => {
    expect(adapter.parseResearchStatus("STATUS: CLARIFICATION_NEEDED\n\n1. Which provider?", null).status)
      .toBe("clarification_needed");
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
    expect(s).not.toContain("--json-schema");
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
