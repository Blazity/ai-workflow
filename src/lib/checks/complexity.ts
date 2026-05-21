import * as ts from "typescript";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Check, CheckResult, Finding, Severity } from "./types.js";
import { registerCheck } from "./registry.js";

export const ComplexityParamsSchema = z.object({
  files: z.string().default("**/*.{ts,tsx,js,jsx}"),
  ignore: z.array(z.string()).default([]),
  max_cyclomatic: z.number().int().positive().default(10),
});

export type ComplexityParams = z.infer<typeof ComplexityParamsSchema>;

interface ComplexityFileInput {
  path: string;
  content: string;
  changed_line_ranges: Array<{ start: number; end: number }>;
  /**
   * Raw unified diff hunk header text from the VCS provider. GitHub omits the
   * `patch` field for very large diffs — when this is undefined and
   * `changed_line_ranges` is empty, we cannot know which lines changed, so the
   * file is skipped and a coverage notice is emitted.
   */
  patch?: string;
}

// Workflow contract: the workflow step (M9) must populate ctx.requested_data["files"]
// with Array<{ path: string; content: string; changed_line_ranges: Array<{ start: number; end: number }> }>
// before invoking this check. Each entry represents a changed file in the PR.

// Reads ctx.requested_data.files (set by workflow) — see workflow contract above.
export const complexityCheck: Check<ComplexityParams> = {
  kind: "complexity",
  paramsSchema: ComplexityParamsSchema as z.ZodType<ComplexityParams>,
  async run(params, ctx) {
    const filesRaw = ctx.requested_data["files"];
    // Defensive — workflow guarantees this; but if missing, return empty result with a notice.
    if (!Array.isArray(filesRaw)) {
      return {
        summary: "Complexity check: no files supplied.",
        findings: [],
        notices: ["complexity: workflow did not supply files data"],
      };
    }
    const files = filesRaw as ComplexityFileInput[];
    const ignorePatterns = params.ignore;

    const findings: Finding[] = [];
    const notices: string[] = [];
    let analyzed = 0;
    let skipped = 0;
    for (const file of files) {
      if (matchesAnyGlob(file.path, ignorePatterns)) {
        skipped++;
        continue;
      }
      if (!matchesGlob(file.path, params.files)) {
        skipped++;
        continue;
      }
      // Coverage notice: when GitHub omits the `patch` field for an oversized
      // diff, `changed_line_ranges` ends up empty. Without ranges, the check
      // would silently skip the entire file. Spec: limit overflow must not be
      // silent. Files where the patch WAS provided but ranges are still empty
      // (rare; usually rename-only) stay silent.
      if (
        file.changed_line_ranges.length === 0 &&
        file.patch === undefined
      ) {
        notices.push(
          `complexity: ${file.path}: patch unavailable, likely oversized — file skipped for complexity check`,
        );
        skipped++;
        continue;
      }
      try {
        const fileFindings = analyzeFile(file, params, ctx.pr.head_sha);
        analyzed++;
        for (const f of fileFindings) findings.push(f);
      } catch (err) {
        notices.push(`complexity: failed to parse ${file.path}: ${(err as Error).message}`);
      }
    }

    return {
      summary: `Complexity check analyzed ${analyzed} files (skipped ${skipped}); ${findings.length} findings.`,
      findings,
      notices,
    };
  },
};

registerCheck(complexityCheck);

// ---------------------------------------------------------------------------
// TypeScript compiler API analysis
// ---------------------------------------------------------------------------

interface FunctionInfo {
  node: ts.Node;
  name: string | undefined;
  startLine: number; // 1-based
  endLine: number;   // 1-based
}

function analyzeFile(
  file: ComplexityFileInput,
  params: ComplexityParams,
  headSha: string,
): Finding[] {
  const scriptKind = pickScriptKind(file.path);
  const sourceFile = ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );

  const fns = collectFunctions(sourceFile);
  const findings: Finding[] = [];
  for (const fn of fns) {
    const startLine = fn.startLine; // 1-based
    const endLine = fn.endLine;
    if (!overlapsChangedLines(startLine, endLine, file.changed_line_ranges)) continue;
    const cyclomatic = computeCyclomatic(fn.node);
    if (cyclomatic <= params.max_cyclomatic) continue;
    const severity: Severity = cyclomatic > params.max_cyclomatic * 2 ? "critical" : "warning";
    findings.push({
      severity,
      message: `Function "${fn.name ?? "<anonymous>"}" has cyclomatic complexity ${cyclomatic} (max ${params.max_cyclomatic}).`,
      primary_location: {
        path: file.path,
        start_line: startLine,
        end_line: endLine,
      },
      fingerprint: fingerprintFinding({
        check_id: "complexity",
        head_sha: headSha,
        path: file.path,
        start_line: startLine,
        end_line: endLine,
        message: `complexity=${cyclomatic}`,
      }),
    });
  }
  return findings;
}

function collectFunctions(sourceFile: ts.SourceFile): FunctionInfo[] {
  const results: FunctionInfo[] = [];

  function visit(node: ts.Node): void {
    if (isFunctionLike(node)) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      results.push({
        node,
        name: getFunctionName(node),
        startLine: start.line + 1,
        endLine: end.line + 1,
      });
      // Don't descend into nested function bodies — they'll be their own findings via the outer walk.
      // But we still need to walk non-body children (e.g. parameters with default values that contain functions).
      // The simplest correct approach: continue descending so nested functions are also collected as siblings.
      // computeCyclomatic stops at nested function boundaries.
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return results;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function getFunctionName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.getText();
  }
  if (ts.isMethodDeclaration(node) && node.name) {
    return node.name.getText();
  }
  if (ts.isGetAccessor(node) && node.name) {
    return `get ${node.name.getText()}`;
  }
  if (ts.isSetAccessor(node) && node.name) {
    return `set ${node.name.getText()}`;
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  // For FunctionExpression, check if assigned to a variable: const foo = function() {}
  if (ts.isFunctionExpression(node) && node.name) {
    return node.name.getText();
  }
  // ArrowFunction or unnamed FunctionExpression: check parent for variable declaration
  const parent = (node as ts.Node & { parent?: ts.Node }).parent;
  if (parent) {
    if (ts.isVariableDeclaration(parent as ts.VariableDeclaration) && (parent as ts.VariableDeclaration).name) {
      return ((parent as ts.VariableDeclaration).name as ts.Identifier).getText?.();
    }
    if (ts.isPropertyAssignment(parent as ts.PropertyAssignment) && (parent as ts.PropertyAssignment).name) {
      return ((parent as ts.PropertyAssignment).name as ts.Identifier).getText?.();
    }
  }
  return undefined;
}

/**
 * Compute cyclomatic complexity for a function-like node.
 * Starts at 1 and adds 1 for each branching construct.
 * Does NOT descend into nested function bodies.
 */
function computeCyclomatic(fnNode: ts.Node): number {
  let complexity = 1;

  function walk(node: ts.Node): void {
    // Stop at nested function boundaries — they're counted separately.
    if (node !== fnNode && isFunctionLike(node)) return;

    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
        complexity++;
        break;
      case ts.SyntaxKind.ConditionalExpression: // ternary ?:
        complexity++;
        break;
      case ts.SyntaxKind.CaseClause: {
        // Count non-empty cases (has statements)
        const c = node as ts.CaseClause;
        if (c.statements.length > 0) complexity++;
        break;
      }
      case ts.SyntaxKind.BinaryExpression: {
        const b = node as ts.BinaryExpression;
        const op = b.operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity++;
        }
        break;
      }
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
        complexity++;
        break;
      case ts.SyntaxKind.CatchClause:
        complexity++;
        break;
    }

    ts.forEachChild(node, walk);
  }

  walk(fnNode);
  return complexity;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function overlapsChangedLines(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((r) => !(r.end < start || r.start > end));
}

function pickScriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return ts.ScriptKind.TS;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

interface FingerprintInput {
  check_id: string;
  head_sha: string;
  path: string;
  start_line: number;
  end_line: number;
  message: string;
}

function fingerprintFinding(input: FingerprintInput): string {
  const canonical = JSON.stringify({
    check_id: input.check_id,
    head_sha: input.head_sha,
    path: input.path,
    start_line: input.start_line,
    end_line: input.end_line,
    message: input.message,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Glob helpers (no external dependency)
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
  // Normalize path separators
  const p = pattern.replace(/\\/g, "/");
  let regex = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      // ** matches anything including slashes
      regex += ".*";
      i += 2;
      // consume optional trailing slash
      if (p[i] === "/") i++;
    } else if (c === "*") {
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (c === "{") {
      // {a,b,c} -> (?:a|b|c)
      const close = p.indexOf("}", i);
      if (close === -1) {
        regex += "\\{";
        i++;
      } else {
        const choices = p.slice(i + 1, close).split(",").map(escapeRegex);
        regex += `(?:${choices.join("|")})`;
        i = close + 1;
      }
    } else {
      regex += escapeRegex(c);
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const re = globToRegex(pattern);
  // Also try matching just the basename for patterns without slashes
  if (re.test(normalized)) return true;
  // If pattern has no slash component, match against basename
  if (!pattern.includes("/") && !pattern.startsWith("**/")) {
    const basename = normalized.split("/").pop() ?? normalized;
    return re.test(basename);
  }
  return false;
}

export function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(filePath, p));
}
