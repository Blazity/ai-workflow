import { describe, it, expect } from "vitest";
import { buildPhaseScript } from "./wrapper-script.js";

describe("buildPhaseScript", () => {
  it("generates research phase script without json-schema", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "research",
      inputFile: "/tmp/research-requirements.md",
      outputFile: "/tmp/research-stdout.txt",
      stderrFile: "/tmp/research-stderr.txt",
      sentinelFile: "/tmp/research-done",
    });

    expect(script).toContain("#!/bin/bash");
    expect(script).toContain("claude");
    expect(script).toContain("claude-opus-4-6");
    expect(script).toContain("/tmp/research-requirements.md");
    expect(script).toContain("/tmp/research-stdout.txt");
    expect(script).toContain("/tmp/research-stderr.txt");
    expect(script).toContain("/tmp/research-done");
    expect(script).not.toContain("--json-schema");
    expect(script).not.toContain("--output-format");
  });

  it("generates impl phase script with json-schema", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "impl",
      inputFile: "/tmp/impl-requirements.md",
      outputFile: "/tmp/impl-stdout.txt",
      stderrFile: "/tmp/impl-stderr.txt",
      sentinelFile: "/tmp/impl-done",
      jsonSchema: '{"type":"object"}',
    });

    expect(script).toContain("--json-schema");
    expect(script).toContain("--output-format json");
    expect(script).toContain("/tmp/impl-requirements.md");
    expect(script).toContain("/tmp/impl-done");
  });

  it("generates review phase script with json-schema", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "review",
      inputFile: "/tmp/review-requirements.md",
      outputFile: "/tmp/review-stdout.txt",
      stderrFile: "/tmp/review-stderr.txt",
      sentinelFile: "/tmp/review-done",
      jsonSchema: '{"type":"object"}',
    });

    expect(script).toContain("--json-schema");
    expect(script).toContain("/tmp/review-requirements.md");
    expect(script).toContain("/tmp/review-done");
  });

  it("includes cleanup and sentinel touch", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "research",
      inputFile: "/tmp/research-requirements.md",
      outputFile: "/tmp/research-stdout.txt",
      stderrFile: "/tmp/research-stderr.txt",
      sentinelFile: "/tmp/research-done",
    });

    expect(script).toContain("rm -rf .claude/");
    expect(script).toContain("touch /tmp/research-done");
  });

  it("removes stale sentinel, stdout, and stderr before running", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "impl",
      inputFile: "/tmp/impl-requirements.md",
      outputFile: "/tmp/impl-stdout.txt",
      stderrFile: "/tmp/impl-stderr.txt",
      sentinelFile: "/tmp/impl-done",
      jsonSchema: '{"type":"object"}',
    });

    // Cleanup line must appear before the claude invocation
    const cleanupIdx = script.indexOf("rm -f /tmp/impl-done /tmp/impl-stdout.txt /tmp/impl-stderr.txt");
    const claudeIdx = script.indexOf("claude");
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeLessThan(claudeIdx);
  });

  it("escapes single quotes in json schema", () => {
    const script = buildPhaseScript({
      model: "claude-opus-4-6",
      phase: "impl",
      inputFile: "/tmp/impl-requirements.md",
      outputFile: "/tmp/impl-stdout.txt",
      stderrFile: "/tmp/impl-stderr.txt",
      sentinelFile: "/tmp/impl-done",
      jsonSchema: `{"type":"object","desc":"it's"}`,
    });

    expect(script).not.toContain("it's");
    expect(script).toContain("it'\\''s");
  });
});
