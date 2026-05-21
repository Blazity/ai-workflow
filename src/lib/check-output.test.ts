import { describe, it, expect } from "vitest";
import {
  findingsToAnnotations,
  findingsToComments,
  formatFindingMarker,
  truncateCommentBody,
  MAX_COMMENT_BODY,
  type OutputCaps,
  type CommentPolicy,
} from "./check-output.js";
import type { Finding } from "./checks/types.js";
import type { ExistingReviewComment } from "../adapters/vcs/types.js";

const DEFAULT_CAPS: OutputCaps = {
  max_check_annotations: 50,
  max_review_comments: 20,
  max_suggestions: 10,
};

function makeFinding(overrides: Partial<Finding> & { severity: Finding["severity"]; fingerprint: string }): Finding {
  return {
    message: "Test finding",
    ...overrides,
  };
}

function makeLocatedFinding(
  severity: Finding["severity"],
  fingerprint: string,
  path: string,
  start_line: number,
  end_line?: number,
): Finding {
  return {
    severity,
    message: `Finding at ${path}:${start_line}`,
    fingerprint,
    primary_location: { path, start_line, end_line },
  };
}

// ---------------------------------------------------------------------------
// findingsToAnnotations
// ---------------------------------------------------------------------------

describe("findingsToAnnotations", () => {
  it("all findings with primary_location become annotations", () => {
    const findings: Finding[] = [
      makeLocatedFinding("info", "fp1", "src/a.ts", 10),
      makeLocatedFinding("warning", "fp2", "src/b.ts", 20),
      makeLocatedFinding("critical", "fp3", "src/c.ts", 30),
    ];
    const result = findingsToAnnotations(findings, DEFAULT_CAPS);
    expect(result.annotations).toHaveLength(3);
    expect(result.unanchored).toHaveLength(0);
    expect(result.overflow_text).toBe("");
  });

  it("maps info severity to notice annotation_level", () => {
    const findings = [makeLocatedFinding("info", "fp1", "src/a.ts", 5)];
    const { annotations } = findingsToAnnotations(findings, DEFAULT_CAPS);
    expect(annotations[0].annotation_level).toBe("notice");
  });

  it("maps warning severity to warning annotation_level", () => {
    const findings = [makeLocatedFinding("warning", "fp1", "src/a.ts", 5)];
    const { annotations } = findingsToAnnotations(findings, DEFAULT_CAPS);
    expect(annotations[0].annotation_level).toBe("warning");
  });

  it("maps critical severity to failure annotation_level", () => {
    const findings = [makeLocatedFinding("critical", "fp1", "src/a.ts", 5)];
    const { annotations } = findingsToAnnotations(findings, DEFAULT_CAPS);
    expect(annotations[0].annotation_level).toBe("failure");
  });

  it("findings without primary_location go to unanchored", () => {
    const findings: Finding[] = [
      makeFinding({ severity: "warning", fingerprint: "fp1", message: "No location" }),
      makeLocatedFinding("info", "fp2", "src/a.ts", 1),
    ];
    const result = findingsToAnnotations(findings, DEFAULT_CAPS);
    expect(result.annotations).toHaveLength(1);
    expect(result.unanchored).toHaveLength(1);
    expect(result.unanchored[0].fingerprint).toBe("fp1");
  });

  it("cap is enforced; overflow_text mentions dropped count", () => {
    const caps: OutputCaps = { ...DEFAULT_CAPS, max_check_annotations: 2 };
    const findings = [
      makeLocatedFinding("info", "fp1", "src/a.ts", 1),
      makeLocatedFinding("info", "fp2", "src/b.ts", 2),
      makeLocatedFinding("info", "fp3", "src/c.ts", 3),
      makeLocatedFinding("warning", "fp4", "src/d.ts", 4),
    ];
    const result = findingsToAnnotations(findings, caps);
    expect(result.annotations).toHaveLength(2);
    expect(result.overflow_text).toContain("2 additional finding(s) dropped due to annotation cap");
  });

  it("end_line defaults to start_line when not set", () => {
    const findings = [makeLocatedFinding("info", "fp1", "src/a.ts", 10)]; // no end_line
    const { annotations } = findingsToAnnotations(findings, DEFAULT_CAPS);
    expect(annotations[0].start_line).toBe(10);
    expect(annotations[0].end_line).toBe(10);
  });

  it("uses end_line from primary_location when present", () => {
    const findings = [makeLocatedFinding("info", "fp1", "src/a.ts", 10, 15)];
    const { annotations } = findingsToAnnotations(findings, DEFAULT_CAPS);
    expect(annotations[0].end_line).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// findingsToComments
// ---------------------------------------------------------------------------

const ENABLED_POLICY: CommentPolicy = {
  enabled: true,
  severity_threshold: "info",
  suggestions: false,
  suggestions_threshold: "warning",
};

function makeExistingComment(body: string): ExistingReviewComment {
  return { id: 1, path: "src/a.ts", line: 1, body, user: "bot" };
}

describe("findingsToComments — policy.enabled = false", () => {
  it("returns empty result when disabled", () => {
    const findings = [makeLocatedFinding("critical", "fp1", "src/a.ts", 1)];
    const result = findingsToComments({
      findings,
      policy: { ...ENABLED_POLICY, enabled: false },
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: {},
    });
    expect(result.comments).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
    expect(result.skipped_duplicates).toBe(0);
    expect(result.dropped_by_cap).toBe(0);
    expect(result.invalid_suggestions).toHaveLength(0);
  });
});

describe("findingsToComments — severity threshold", () => {
  it("severity below threshold is not posted", () => {
    const findings = [makeLocatedFinding("info", "fp1", "src/a.ts", 1)];
    const result = findingsToComments({
      findings,
      policy: { ...ENABLED_POLICY, severity_threshold: "warning" },
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: {},
    });
    expect(result.comments).toHaveLength(0);
  });

  it("severity at threshold is posted", () => {
    const findings = [makeLocatedFinding("warning", "fp1", "src/a.ts", 1)];
    const result = findingsToComments({
      findings,
      policy: { ...ENABLED_POLICY, severity_threshold: "warning" },
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: {},
    });
    expect(result.comments).toHaveLength(1);
  });

  it("severity above threshold is posted", () => {
    const findings = [makeLocatedFinding("critical", "fp1", "src/a.ts", 1)];
    const result = findingsToComments({
      findings,
      policy: { ...ENABLED_POLICY, severity_threshold: "warning" },
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: {},
    });
    expect(result.comments).toHaveLength(1);
  });
});

describe("findingsToComments — marker in comment body", () => {
  it("posted comment body contains a hidden marker", () => {
    const findings = [makeLocatedFinding("warning", "fp-abc", "src/a.ts", 5)];
    const result = findingsToComments({
      findings,
      policy: ENABLED_POLICY,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: {},
    });
    expect(result.comments[0].body).toContain(formatFindingMarker("fp-abc"));
  });
});

describe("findingsToComments — deduplication", () => {
  it("skips finding when existing comment already contains its marker", () => {
    const marker = formatFindingMarker("fp-dup");
    const findings = [makeLocatedFinding("warning", "fp-dup", "src/a.ts", 5)];
    const existing = [makeExistingComment(`Some comment\n\n${marker}`)];
    const result = findingsToComments({
      findings,
      policy: ENABLED_POLICY,
      caps: DEFAULT_CAPS,
      existingComments: existing,
      changedLines: {},
    });
    expect(result.comments).toHaveLength(0);
    expect(result.skipped_duplicates).toBe(1);
  });

  it("posts finding when existing comment does NOT contain its marker", () => {
    const findings = [makeLocatedFinding("warning", "fp-new", "src/a.ts", 5)];
    const existing = [makeExistingComment(`Some comment ${formatFindingMarker("fp-other")}`)];
    const result = findingsToComments({
      findings,
      policy: ENABLED_POLICY,
      caps: DEFAULT_CAPS,
      existingComments: existing,
      changedLines: {},
    });
    expect(result.comments).toHaveLength(1);
    expect(result.skipped_duplicates).toBe(0);
  });
});

describe("findingsToComments — suggestions", () => {
  const suggestionPolicy: CommentPolicy = {
    enabled: true,
    severity_threshold: "info",
    suggestions: true,
    suggestions_threshold: "warning",
  };

  function makeSuggestionFinding(
    fingerprint: string,
    path: string,
    start_line: number,
    end_line: number,
    replacement = "const x = 1;",
  ): Finding {
    return {
      severity: "warning",
      message: "Use const",
      fingerprint,
      primary_location: { path, start_line, end_line },
      suggestion: { path, start_line, end_line, replacement },
    };
  }

  it("valid suggestion is posted as suggestion entry with suggestion block", () => {
    const finding = makeSuggestionFinding("fp1", "src/a.ts", 5, 5);
    const result = findingsToComments({
      findings: [finding],
      policy: suggestionPolicy,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: { "src/a.ts": [{ start: 1, end: 20 }] },
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.comments).toHaveLength(0);
    expect(result.suggestions[0].body).toContain("```suggestion");
    expect(result.suggestions[0].body).toContain("const x = 1;");
  });

  it("invalid suggestion (different path) falls back to plain comment and recorded in invalid_suggestions", () => {
    const finding: Finding = {
      severity: "warning",
      message: "Bad path",
      fingerprint: "fp-bad-path",
      primary_location: { path: "src/a.ts", start_line: 5, end_line: 5 },
      suggestion: { path: "src/b.ts", start_line: 5, end_line: 5, replacement: "x" },
    };
    const result = findingsToComments({
      findings: [finding],
      policy: suggestionPolicy,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: { "src/a.ts": [{ start: 1, end: 20 }], "src/b.ts": [{ start: 1, end: 20 }] },
    });
    expect(result.suggestions).toHaveLength(0);
    expect(result.comments).toHaveLength(1);
    expect(result.invalid_suggestions).toHaveLength(1);
    expect(result.invalid_suggestions[0].fingerprint).toBe("fp-bad-path");
  });

  it("invalid suggestion (lines not in changed_line_ranges) falls back to plain comment", () => {
    const finding = makeSuggestionFinding("fp-oor", "src/a.ts", 100, 100);
    const result = findingsToComments({
      findings: [finding],
      policy: suggestionPolicy,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: { "src/a.ts": [{ start: 1, end: 20 }] }, // line 100 not in range
    });
    expect(result.suggestions).toHaveLength(0);
    expect(result.comments).toHaveLength(1);
    expect(result.invalid_suggestions).toHaveLength(1);
  });

  it("invalid suggestion (start_line mismatch) falls back to plain comment", () => {
    const finding: Finding = {
      severity: "warning",
      message: "Mismatch",
      fingerprint: "fp-mismatch",
      primary_location: { path: "src/a.ts", start_line: 5, end_line: 10 },
      suggestion: { path: "src/a.ts", start_line: 6, end_line: 10, replacement: "x" }, // start_line differs
    };
    const result = findingsToComments({
      findings: [finding],
      policy: suggestionPolicy,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: { "src/a.ts": [{ start: 1, end: 20 }] },
    });
    expect(result.suggestions).toHaveLength(0);
    expect(result.comments).toHaveLength(1);
    expect(result.invalid_suggestions).toHaveLength(1);
  });

  it("max_suggestions cap is enforced", () => {
    const caps: OutputCaps = { ...DEFAULT_CAPS, max_suggestions: 1 };
    const findings = [
      makeSuggestionFinding("fp1", "src/a.ts", 5, 5),
      makeSuggestionFinding("fp2", "src/a.ts", 6, 6),
    ];
    const result = findingsToComments({
      findings,
      policy: suggestionPolicy,
      caps,
      existingComments: [],
      changedLines: { "src/a.ts": [{ start: 1, end: 20 }] },
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.dropped_by_cap).toBe(1);
  });
});

describe("findingsToComments — max_review_comments cap", () => {
  it("max_review_comments cap is enforced separately from suggestions", () => {
    const caps: OutputCaps = { ...DEFAULT_CAPS, max_review_comments: 2 };
    const findings = [
      makeLocatedFinding("warning", "fp1", "src/a.ts", 1),
      makeLocatedFinding("warning", "fp2", "src/a.ts", 2),
      makeLocatedFinding("warning", "fp3", "src/a.ts", 3),
    ];
    const result = findingsToComments({
      findings,
      policy: ENABLED_POLICY,
      caps,
      existingComments: [],
      changedLines: {},
    });
    expect(result.comments).toHaveLength(2);
    expect(result.dropped_by_cap).toBe(1);
  });
});

describe("findingsToComments — related locations", () => {
  it("related locations appear in comment body when present", () => {
    const finding: Finding = {
      severity: "warning",
      message: "Complex function",
      fingerprint: "fp-related",
      primary_location: { path: "src/a.ts", start_line: 1 },
      related_locations: [
        { path: "src/b.ts", start_line: 10, note: "related fn" },
        { path: "src/c.ts" },
      ],
    };
    const result = findingsToComments({
      findings: [finding],
      policy: ENABLED_POLICY,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: {},
    });
    const body = result.comments[0].body;
    expect(body).toContain("_Related:_");
    expect(body).toContain("src/b.ts:10");
    expect(body).toContain("related fn");
    expect(body).toContain("src/c.ts");
  });

  it("no related section when related_locations is empty", () => {
    const finding = makeLocatedFinding("warning", "fp1", "src/a.ts", 5);
    const result = findingsToComments({
      findings: [finding],
      policy: ENABLED_POLICY,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: {},
    });
    expect(result.comments[0].body).not.toContain("_Related:_");
  });
});

// ---------------------------------------------------------------------------
// Fence-injection sanitization
// ---------------------------------------------------------------------------

const SUGGESTION_POLICY: CommentPolicy = {
  enabled: true,
  severity_threshold: "info",
  suggestions: true,
  suggestions_threshold: "warning",
};

describe("findingsToComments — fence sanitization", () => {
  it("a finding message containing a triple-backtick fence does not break the outer suggestion fence", () => {
    const finding: Finding = {
      severity: "warning",
      message: "Avoid:\n```bash\nrm -rf /\n```\nUse safer commands.",
      fingerprint: "fp-msg-fence",
      primary_location: { path: "src/a.ts", start_line: 5, end_line: 5 },
      suggestion: {
        path: "src/a.ts",
        start_line: 5,
        end_line: 5,
        replacement: "echo safe",
      },
    };
    const result = findingsToComments({
      findings: [finding],
      policy: SUGGESTION_POLICY,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: { "src/a.ts": [{ start: 1, end: 20 }] },
    });
    expect(result.suggestions).toHaveLength(1);
    const body = result.suggestions[0].body;
    // The outer ```suggestion ... ``` should still parse as exactly one fence
    // pair — i.e. the body contains exactly two unbroken ``` sequences.
    const fences = body.match(/```/g) ?? [];
    expect(fences).toHaveLength(2);
    // The literal user-supplied ```bash should have been neutralized.
    expect(body).not.toContain("```bash");
  });

  it("a suggestion replacement containing a triple-backtick is neutralized", () => {
    const finding: Finding = {
      severity: "warning",
      message: "Replace with literal markdown",
      fingerprint: "fp-replace-fence",
      primary_location: { path: "src/a.ts", start_line: 5, end_line: 5 },
      suggestion: {
        path: "src/a.ts",
        start_line: 5,
        end_line: 5,
        replacement: "const md = `\n```\nhi\n```\n`;",
      },
    };
    const result = findingsToComments({
      findings: [finding],
      policy: SUGGESTION_POLICY,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: { "src/a.ts": [{ start: 1, end: 20 }] },
    });
    expect(result.suggestions).toHaveLength(1);
    const body = result.suggestions[0].body;
    const fences = body.match(/```/g) ?? [];
    // Exactly the outer pair — the inner fences should be neutralized.
    expect(fences).toHaveLength(2);
  });

  it("a plain comment message with a triple-backtick is neutralized", () => {
    const finding: Finding = {
      severity: "warning",
      message: "See:\n```\nbad\n```",
      fingerprint: "fp-plain-fence",
      primary_location: { path: "src/a.ts", start_line: 5 },
    };
    const result = findingsToComments({
      findings: [finding],
      policy: ENABLED_POLICY,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: {},
    });
    expect(result.comments).toHaveLength(1);
    const body = result.comments[0].body;
    // No raw triple-backticks survive in a plain (non-suggestion) body.
    expect(body.match(/```/g) ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 65k cap
// ---------------------------------------------------------------------------

describe("comment body 65k cap", () => {
  it("truncateCommentBody returns input unchanged when under the limit", () => {
    const body = "short body";
    expect(truncateCommentBody(body)).toBe(body);
  });

  it("truncateCommentBody truncates and appends the marker when over the limit", () => {
    const body = "x".repeat(MAX_COMMENT_BODY + 1000);
    const out = truncateCommentBody(body);
    expect(out.length).toBeLessThanOrEqual(MAX_COMMENT_BODY);
    expect(out).toContain("…truncated");
  });

  it("a plain-comment finding with an unreasonably large message is truncated", () => {
    const huge = "A".repeat(MAX_COMMENT_BODY + 5000);
    const finding: Finding = {
      severity: "warning",
      message: huge,
      fingerprint: "fp-huge",
      primary_location: { path: "src/a.ts", start_line: 5 },
    };
    const result = findingsToComments({
      findings: [finding],
      policy: ENABLED_POLICY,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: {},
    });
    expect(result.comments).toHaveLength(1);
    const body = result.comments[0].body;
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_BODY);
    expect(body).toContain("…truncated");
  });

  it("a suggestion finding with a huge replacement is truncated", () => {
    const huge = "B".repeat(MAX_COMMENT_BODY + 5000);
    const finding: Finding = {
      severity: "warning",
      message: "Big replacement",
      fingerprint: "fp-huge-sugg",
      primary_location: { path: "src/a.ts", start_line: 5, end_line: 5 },
      suggestion: { path: "src/a.ts", start_line: 5, end_line: 5, replacement: huge },
    };
    const result = findingsToComments({
      findings: [finding],
      policy: SUGGESTION_POLICY,
      caps: DEFAULT_CAPS,
      existingComments: [],
      changedLines: { "src/a.ts": [{ start: 1, end: 20 }] },
    });
    expect(result.suggestions).toHaveLength(1);
    const body = result.suggestions[0].body;
    expect(body.length).toBeLessThanOrEqual(MAX_COMMENT_BODY);
    expect(body).toContain("…truncated");
  });

  it("annotation overflow_text is truncated when extremely large", () => {
    const caps: OutputCaps = { ...DEFAULT_CAPS, max_check_annotations: 1 };
    const huge = "Z".repeat(MAX_COMMENT_BODY + 1000);
    const findings: Finding[] = [
      makeLocatedFinding("info", "fp1", "src/a.ts", 1),
      // Each overflow item contributes its message into overflow_text.
      { severity: "warning", message: huge, fingerprint: "fp2", primary_location: { path: "src/b.ts", start_line: 2 } },
    ];
    const result = findingsToAnnotations(findings, caps);
    expect(result.overflow_text.length).toBeLessThanOrEqual(MAX_COMMENT_BODY);
    expect(result.overflow_text).toContain("…truncated");
  });
});
