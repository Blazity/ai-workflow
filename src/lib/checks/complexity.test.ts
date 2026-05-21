import { describe, it, expect } from "vitest";
import { complexityCheck, ComplexityParamsSchema } from "./complexity.js";
import type { CheckContext, PRContext } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  files: Array<{ path: string; content: string; changed_line_ranges: Array<{ start: number; end: number }> }>,
): CheckContext {
  const pr: PRContext = {
    owner: "test-owner",
    repo: "test-repo",
    pr_number: 1,
    pr_url: "https://github.com/test-owner/test-repo/pull/1",
    base_sha: "base000",
    head_sha: "head000",
    labels: [],
  };
  return {
    pr,
    requested_data: { files },
    dependency_results: {},
  };
}

function defaultParams(overrides: Partial<{ files: string; ignore: string[]; max_cyclomatic: number }> = {}) {
  return ComplexityParamsSchema.parse(overrides);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("complexityCheck", () => {
  it("reports a changed function that exceeds max_cyclomatic", async () => {
    // cyclomatic = 1 + 5 ifs = 6, which exceeds max_cyclomatic: 2
    const content = `function foo(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {
  if (a) if (b) if (c) if (d) if (e) return 1;
}`;
    const ctx = makeCtx([
      {
        path: "src/foo.ts",
        content,
        changed_line_ranges: [{ start: 1, end: 3 }],
      },
    ]);
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 2 }), ctx);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toContain("foo");
    expect(result.findings[0].message).toContain("cyclomatic complexity");
  });

  it("ignores an unchanged function", async () => {
    const content = `function foo(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {
  if (a) if (b) if (c) if (d) if (e) return 1;
}`;
    const ctx = makeCtx([
      {
        path: "src/foo.ts",
        content,
        // Lines 999-1000 don't overlap the function at lines 1-3
        changed_line_ranges: [{ start: 999, end: 1000 }],
      },
    ]);
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 2 }), ctx);
    expect(result.findings).toHaveLength(0);
  });

  it("skips files matching ignore patterns", async () => {
    const content = `function foo(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {
  if (a) if (b) if (c) if (d) if (e) return 1;
}`;
    const ctx = makeCtx([
      {
        path: "src/generated/foo.ts",
        content,
        changed_line_ranges: [{ start: 1, end: 3 }],
      },
    ]);
    const result = await complexityCheck.run(
      defaultParams({ max_cyclomatic: 2, ignore: ["**/generated/**"] }),
      ctx,
    );
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain("skipped 1");
  });

  it("skips files not matching the file pattern (e.g. .md files)", async () => {
    const content = `# Some markdown
This is not a TS file.
`;
    const ctx = makeCtx([
      {
        path: "README.md",
        content,
        changed_line_ranges: [{ start: 1, end: 2 }],
      },
    ]);
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 2 }), ctx);
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain("skipped 1");
  });

  it("emits no finding when function is below threshold", async () => {
    // cyclomatic = 1 (no branches)
    const content = `function simple() { return 42; }`;
    const ctx = makeCtx([
      {
        path: "src/simple.ts",
        content,
        changed_line_ranges: [{ start: 1, end: 1 }],
      },
    ]);
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 10 }), ctx);
    expect(result.findings).toHaveLength(0);
  });

  it("emits warning when complexity is above threshold but <= 2x threshold", async () => {
    // cyclomatic = 1 + 5 ifs = 6, threshold = 5 → 6 > 5, 6 <= 10 → warning
    const content = `function borderline(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {
  if (a) { }
  if (b) { }
  if (c) { }
  if (d) { }
  if (e) { }
}`;
    const ctx = makeCtx([
      {
        path: "src/borderline.ts",
        content,
        changed_line_ranges: [{ start: 1, end: 8 }],
      },
    ]);
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 5 }), ctx);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("warning");
  });

  it("emits critical when complexity is above 2x threshold", async () => {
    // Build a function with cyclomatic = 1 + 11 ifs = 12, threshold = 5 → 12 > 10 → critical
    const ifs = Array.from({ length: 11 }, (_, i) => `  if (x${i}) { }`).join("\n");
    const content = `function veryComplex(${Array.from({ length: 11 }, (_, i) => `x${i}: boolean`).join(", ")}) {\n${ifs}\n}`;
    const ctx = makeCtx([
      {
        path: "src/complex.ts",
        content,
        changed_line_ranges: [{ start: 1, end: 15 }],
      },
    ]);
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 5 }), ctx);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("critical");
  });

  it("adds a notice and no findings for a file that fails to parse", async () => {
    // Intentionally broken TypeScript
    const content = `function ( ) { broken`;
    const ctx = makeCtx([
      {
        path: "src/broken.ts",
        content,
        changed_line_ranges: [{ start: 1, end: 1 }],
      },
    ]);
    // TypeScript's createSourceFile is lenient and won't throw on many syntax errors.
    // Force an error by making the content cause an issue in our own analyzeFile processing.
    // Actually, we need to test via a path that triggers an error in processing.
    // The TS compiler API is forgiving — so we test "no findings" by using a .ts file that results in 0 functions
    // but rely on the try/catch in the run loop to add a notice.
    // To actually trigger the catch block, we pass a null-coercing value via a workaround:
    // We use a special file whose parsing we can force to throw.
    // Since ts.createSourceFile doesn't throw, we instead test what happens when files data is wrong type:
    const ctxBadFiles: CheckContext = {
      ...ctx,
      requested_data: {
        files: [
          {
            path: "src/broken.ts",
            // Content that causes a real error: we'll test by checking the content
            // that makes the compiler API throw (e.g., null content)
            content: null as unknown as string,
            changed_line_ranges: [{ start: 1, end: 1 }],
          },
        ],
      },
    };
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 2 }), ctxBadFiles);
    expect(result.findings).toHaveLength(0);
    expect(result.notices.length).toBeGreaterThanOrEqual(1);
    expect(result.notices[0]).toContain("src/broken.ts");
  });

  it("parses TSX files with JSX and counts && complexity", async () => {
    const content = `function Foo({ cond }: { cond: boolean }) {
  return <div>{cond && <span />}</div>;
}`;
    const ctx = makeCtx([
      {
        path: "src/Foo.tsx",
        content,
        changed_line_ranges: [{ start: 1, end: 3 }],
      },
    ]);
    // max_cyclomatic: 1 means any function with complexity > 1 triggers a finding.
    // Foo has 1 (base) + 1 (&&) = 2 > 1 → should produce a finding without throwing.
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 1 }), ctx);
    // No parse error notices
    const parseErrors = result.notices.filter((n) => n.includes("Foo.tsx"));
    expect(parseErrors).toHaveLength(0);
    // Should have exactly one finding for the && operator
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toContain("Foo");
  });

  it("produces a finding with the method name for a class method", async () => {
    const content = `class MyService {
  processAll(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, f: boolean) {
    if (a) { }
    if (b) { }
    if (c) { }
    if (d) { }
    if (e) { }
    if (f) { }
  }
}`;
    const ctx = makeCtx([
      {
        path: "src/service.ts",
        content,
        changed_line_ranges: [{ start: 1, end: 12 }],
      },
    ]);
    // complexity = 1 + 6 ifs = 7, max = 5 → warning (7 <= 10)
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 5 }), ctx);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].message).toContain("processAll");
  });

  it("produces a finding with <anonymous> for an arrow function without assignment", async () => {
    // An arrow function passed directly as an argument (no variable assignment)
    // that is in the changed range and exceeds threshold
    const content = `export const handler = [
  (a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, f: boolean) => {
    if (a) { }
    if (b) { }
    if (c) { }
    if (d) { }
    if (e) { }
    if (f) { }
  },
];`;
    const ctx = makeCtx([
      {
        path: "src/handlers.ts",
        content,
        changed_line_ranges: [{ start: 1, end: 10 }],
      },
    ]);
    // complexity = 1 + 6 ifs = 7, max = 5
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 5 }), ctx);
    expect(result.findings).toHaveLength(1);
    // Arrow function inside an array literal — no identifier parent → <anonymous>
    expect(result.findings[0].message).toContain("<anonymous>");
  });

  it("emits a coverage notice when patch is undefined and changed_line_ranges is empty", async () => {
    // Simulates GitHub omitting `patch` for an oversized diff —
    // the file matches the glob but has no line-range information.
    const content = `function huge() {
  if (true) { }
}`;
    const ctx = makeCtx([
      {
        path: "src/oversized.ts",
        content,
        changed_line_ranges: [],
        // patch intentionally omitted (undefined) to mimic GitHub's oversized-diff behavior
      },
    ]);
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 2 }), ctx);
    expect(result.findings).toHaveLength(0);
    const coverageNotices = result.notices.filter((n) => n.includes("src/oversized.ts"));
    expect(coverageNotices).toHaveLength(1);
    expect(coverageNotices[0]).toContain("patch unavailable");
  });

  it("stays silent when changed_line_ranges is empty but patch was provided (rename-only)", async () => {
    const content = `function renamed() { return 1; }`;
    const ctx = makeCtx([
      {
        path: "src/renamed.ts",
        content,
        changed_line_ranges: [],
        // patch is defined (e.g. empty string from a rename-only diff)
        patch: "",
      } as any,
    ]);
    const result = await complexityCheck.run(defaultParams({ max_cyclomatic: 2 }), ctx);
    expect(result.findings).toHaveLength(0);
    const coverageNotices = result.notices.filter((n) => n.includes("src/renamed.ts"));
    expect(coverageNotices).toHaveLength(0);
  });

  it("returns empty result with notice when files data is not an array", async () => {
    const pr: PRContext = {
      owner: "o",
      repo: "r",
      pr_number: 1,
      pr_url: "https://example.com",
      base_sha: "b",
      head_sha: "h",
      labels: [],
    };
    const ctx: CheckContext = {
      pr,
      requested_data: {},
      dependency_results: {},
    };
    const result = await complexityCheck.run(defaultParams(), ctx);
    expect(result.findings).toHaveLength(0);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("complexity");
  });
});
