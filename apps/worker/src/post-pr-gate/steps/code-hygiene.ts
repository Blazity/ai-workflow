import { generateText, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { PostPrGateStepHandler } from "../types.js";
import {
  hasPRFilesCapability,
  type CheckRunAnnotation,
  type PRFile,
} from "../../adapters/vcs/types.js";

const withSchema = z
  .object({
    model: z.string().min(1).default("claude-haiku-4-5"),
    maxFiles: z.number().int().positive().default(50),
    maxPatchCharsPerFile: z.number().int().positive().default(8_000),
    concurrency: z.number().int().positive().default(5),
  })
  .default({});

const fileReportSchema = z.object({
  issues: z.array(
    z.object({
      kind: z.enum(["comment", "console", "debugger"]),
      line: z.number().int().nonnegative().optional(),
      snippet: z.string(),
      reason: z.string(),
    }),
  ),
});

const SYSTEM_PROMPT = `You review a single unified-diff patch and flag low-quality additions on ADDED lines only (lines starting with "+").

Flag these (with kind):
- "comment": TODO / FIXME / HACK / XXX markers, commented-out code, filler or placeholder comments ("// trash", "// remove this", "// idk", lorem-ipsum noise), or comments that describe future work belonging in an issue tracker
- "console": stray debugging output left in production code — console.log / console.debug / console.warn / console.error used as debug prints, print() / println(), System.out.println, fmt.Println used as debug prints
- "debugger": "debugger;" statements or equivalent breakpoint hooks

Do NOT flag:
- Well-written comments that explain non-obvious WHY (constraints, invariants, workarounds)
- Pre-existing comments or console calls on context lines (no leading "+")
- License headers, copyright notices, generated-file markers
- JSDoc / TSDoc public-API documentation
- Intentional logging via a real logger (logger.info, log.error, pino, winston) or console.* calls inside obvious CLI / script entrypoints

For each finding return:
- kind: "comment" | "console" | "debugger"
- line: 1-based line number in the new file when determinable, otherwise omit
- snippet: the offending text verbatim (trim leading "+")
- reason: one short sentence on why this is low quality

If nothing is wrong, return { "issues": [] }.`;

interface FileIssue {
  path: string;
  kind: "comment" | "console" | "debugger";
  line?: number;
  snippet: string;
  reason: string;
}

type ReviewOutcome =
  | { kind: "issues"; path: string; issues: FileIssue[] }
  | { kind: "error"; path: string; error: string };

export const codeHygiene: PostPrGateStepHandler = async ({ context, config }) => {
  const { model, maxFiles, maxPatchCharsPerFile, concurrency } = withSchema.parse(config ?? {});

  if (!hasPRFilesCapability(context.adapters.vcs)) {
    return {
      conclusion: "neutral",
      summary: "VCS adapter does not support listing PR files.",
    };
  }

  const files = await context.adapters.vcs.listPRFiles(context.pr.number);
  const candidates = files
    .filter((f) => f.changeType !== "removed" && f.patch && f.patch.length > 0)
    .slice(0, maxFiles);

  if (candidates.length === 0) {
    return {
      conclusion: "success",
      summary: "No changed files with patches to inspect.",
    };
  }

  const results = await runWithConcurrency(candidates, concurrency, (file) =>
    reviewFile(file, { model, maxPatchCharsPerFile }),
  );

  const issues: FileIssue[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.kind === "issues") issues.push(...r.issues);
    else errors.push(`- \`${r.path}\`: ${r.error}`);
  }

  if (issues.length === 0 && errors.length === 0) {
    return {
      conclusion: "success",
      summary: "No low-quality comments, console logs, or debugger statements found in added lines.",
    };
  }

  if (issues.length === 0 && errors.length > 0) {
    return {
      conclusion: "neutral",
      summary: `AI review failed for ${errors.length} file${errors.length === 1 ? "" : "s"}.`,
      details: "Failures:\n\n" + errors.join("\n"),
    };
  }

  const details =
    `**Reviewed by:** \`${model}\`\n\n` +
    issues.map(renderIssue).join("\n") +
    (errors.length > 0
      ? `\n\n**Files that failed review (${errors.length}):**\n${errors.join("\n")}`
      : "");

  return {
    conclusion: "failure",
    summary: `Found ${issues.length} hygiene issue${issues.length === 1 ? "" : "s"} in changed code.`,
    details,
    annotations: issues
      .filter((i) => i.line !== undefined)
      .map<CheckRunAnnotation>((i) => ({
        path: i.path,
        startLine: i.line!,
        endLine: i.line!,
        annotationLevel: "warning",
        message: i.reason,
        title: titleFor(i.kind),
        rawDetails: i.snippet,
      })),
  };
};

async function reviewFile(
  file: PRFile,
  opts: { model: string; maxPatchCharsPerFile: number },
): Promise<ReviewOutcome> {
  const patch = truncate(file.patch ?? "", opts.maxPatchCharsPerFile);
  try {
    const { output } = await generateText({
      model: anthropic(opts.model),
      output: Output.object({ schema: fileReportSchema }),
      system: SYSTEM_PROMPT,
      prompt:
        `File path: ${file.path}\n\nUnified diff patch:\n\n` +
        "```diff\n" +
        patch +
        "\n```\n\n" +
        "Report low-quality comments, stray console / print statements, and debugger statements on added lines for THIS file only.",
    });
    const raw = output?.issues ?? [];
    return {
      kind: "issues",
      path: file.path,
      issues: raw.map((r) => ({ path: file.path, ...r })),
    };
  } catch (err) {
    return {
      kind: "error",
      path: file.path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}

function renderIssue(i: FileIssue): string {
  const loc = i.line !== undefined ? ` (line ${i.line})` : "";
  return `- **${i.path}**${loc} — _${titleFor(i.kind)}_: \`${i.snippet}\`\n  - ${i.reason}`;
}

function titleFor(kind: FileIssue["kind"]): string {
  if (kind === "console") return "Stray console / print statement";
  if (kind === "debugger") return "Debugger statement";
  return "Low-quality comment";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}
