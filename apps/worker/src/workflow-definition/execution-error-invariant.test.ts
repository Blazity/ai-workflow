import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatTicketEvent } from "../adapters/messaging/format.js";
import { scrubForPublication } from "../lib/publication-scrub.js";
import { sanitizeRunError } from "../lib/overview/sanitize-run-detail.js";
import {
  createWorkflowExecutionErrorState,
  executionError,
  formatExecutionErrorForUser,
  SAFE_EXECUTION_ERROR_MESSAGES,
  type ExecutionErrorCategory,
} from "./interpreter.js";
import { sanitizeDetail, sanitizeFailureMessage } from "./failure-message.js";

/**
 * AIW-254's headline acceptance criterion, as an executable invariant:
 *
 *   "No failure surface in the product can render only the generic per-category
 *    sentence plus a diagnostic ID."
 *
 * Two halves, both needed. The behavioural half drives every shape a call site
 * can hand `executionError` and asserts the composed user-facing string always
 * says more than its category. The structural half proves that IS every call
 * site, by asserting `executionError` is the only place in the worker that
 * composes a block failure message: an invariant checked in one function is
 * worth nothing while a second construction path exists, and there WAS one
 * (v2-scheduler kept its own copy of the sentence table and returned it
 * verbatim, so scheduler failures rendered generic text no matter what they
 * knew).
 */

const CATEGORIES = Object.keys(
  SAFE_EXECUTION_ERROR_MESSAGES,
) as ExecutionErrorCategory[];

const RUN_ID = "wrun_01KYSFRC85YWWMD6WH2FQG0C30";

/** Every distinguishable shape a call site passes. `detail` is varied across the
 *  three cases that used to collapse to the bare category line: real text, text
 *  the generic sentence already contains, and nothing at all. */
const DETAILS: Array<{ label: string; detail: string }> = [
  { label: "a real cause", detail: "the upstream socket hung up" },
  { label: "whitespace only", detail: "   " },
  { label: "empty", detail: "" },
  // Substrings of the per-category sentences. Passing one used to produce the
  // sentence alone, because the snippet is legitimately suppressed as a
  // duplicate of the lead and nothing replaced it.
  { label: "text the generic sentence already states", detail: "could not be completed" },
  { label: "the whole generic sentence", detail: "The block could not be completed." },
];

const EXPLICIT_MESSAGES: Array<{ label: string; message?: string }> = [
  { label: "no explicit message" },
  { label: "an explicit lead", message: "The current agent phase could not be completed." },
];

function userFacing(
  category: ExecutionErrorCategory,
  detail: string,
  message: string | undefined,
): string {
  const built = executionError(detail, {
    category,
    ...(message ? { message } : {}),
  });
  return formatExecutionErrorForUser(
    createWorkflowExecutionErrorState(RUN_ID, "planning", 1, built.error),
  );
}

describe("execution error invariant: no surface renders only the category line", () => {
  for (const category of CATEGORIES) {
    const generic = SAFE_EXECUTION_ERROR_MESSAGES[category];
    for (const { label: detailLabel, detail } of DETAILS) {
      for (const { label: messageLabel, message } of EXPLICIT_MESSAGES) {
        it(`${category} with ${detailLabel} and ${messageLabel}`, () => {
          const out = userFacing(category, detail, message);
          const diagnosticSuffix = out.slice(out.indexOf(" Diagnostic ID: "));
          const body = out.slice(0, out.indexOf(" Diagnostic ID: "));

          // The exact pre-AIW-254 output, in both spellings it took.
          expect(body).not.toBe(generic);
          expect(out).not.toBe(`${generic}${diagnosticSuffix}`);

          // The property, stated as an operator would: the message either quotes
          // the cause it was given, or, having none worth quoting, names the
          // candidate causes and where the raw session is. Never neither.
          const quotesTheCause =
            sanitizeDetail(detail).length > 0 && body.includes(sanitizeDetail(detail));
          const namesCandidates =
            body.includes("Likely causes:") && body.includes("LOGS tab");
          expect(
            quotesTheCause || namesCandidates,
            `neither quoted the cause nor named candidates: ${body}`,
          ).toBe(true);

          // The diagnostic ID survives, as AIW-143 requires.
          expect(diagnosticSuffix).toContain(`AIW-DIAG-${RUN_ID}-planning-1`);
          // Nothing degenerate: no empty parentheses, no doubled spaces.
          expect(body).not.toContain("()");
          expect(body).not.toMatch(/ {2}/);
        });
      }
    }
  }

  it("keeps every composed message inside the response boundary", () => {
    for (const category of CATEGORIES) {
      for (const { detail } of DETAILS) {
        for (const { message } of EXPLICIT_MESSAGES) {
          const out = userFacing(category, detail, message);
          // Idempotent under the boundary sanitizer, which is what makes the
          // run header agree with Slack and the ticket comment.
          expect(sanitizeFailureMessage(out), out).toBe(out);
        }
      }
    }
  });
});

/** Worker sources, tests excluded: the invariant is about production paths. */
function workerSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      workerSourceFiles(path, found);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry === "test-support.ts") continue;
    found.push(path);
  }
  return found;
}

const SOURCE_ROOT = join(import.meta.dirname, "..");
const INTERPRETER = join(SOURCE_ROOT, "workflow-definition", "interpreter.ts");

describe("execution error invariant: one construction path", () => {
  const files = workerSourceFiles(SOURCE_ROOT).map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));

  it("finds worker sources to scan at all", () => {
    // Guards the two scans below against silently passing on an empty list if
    // this file ever moves.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.path === INTERPRETER)).toBe(true);
  });

  it("composes a block failure message nowhere but interpreter.ts", () => {
    // An `execution_error` object literal that also assigns `message` is a
    // second construction path, and a second path cannot be held to the
    // invariant above. Type positions (`Extract<..., { kind: "execution_error" }>`)
    // and re-wraps of an already-built error (no `message:`) are not matches.
    const offenders: string[] = [];
    for (const { path, text } of files) {
      if (path === INTERPRETER) continue;
      const pattern = /kind:\s*"execution_error",/g;
      for (const match of text.matchAll(pattern)) {
        const window = text.slice(match.index, match.index + 400);
        if (/\bmessage:/.test(window)) {
          offenders.push(`${path} at index ${match.index}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the per-category sentences in one table", () => {
    // A copy of the table is how the scheduler path drifted: it produced the
    // right-looking sentence and skipped derivation entirely. Any duplicate is a
    // failure surface that can render the category line alone.
    const offenders: string[] = [];
    for (const sentence of Object.values(SAFE_EXECUTION_ERROR_MESSAGES)) {
      for (const { path, text } of files) {
        if (path === INTERPRETER) continue;
        if (text.includes(`"${sentence}"`)) offenders.push(`${sentence} in ${path}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("execution error invariant: every surface shows the same message", () => {
  // The failure the ticket was filed on: an agent phase whose CLI exited 1 on an
  // exhausted OpenAI account, with the provider's own sentence in the captured
  // stdout tail.
  const built = executionError("The CLI exited with code 1.", {
    category: "provider",
    message: "The current agent phase could not be completed.",
    phase: "planning",
    evidence: {
      failureKind: "cli_exit",
      exitCode: 1,
      stdoutTail:
        "stream disconnected before completion: You have no credits remaining. " +
        "Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
    },
  });
  const state = createWorkflowExecutionErrorState(RUN_ID, "planning", 1, built.error);
  /** The one string. `failureExit` passes exactly this to the run status reason,
   *  the Slack notification and the ticket comment, and the run header reads the
   *  same value back out of run telemetry. */
  const reason = formatExecutionErrorForUser(state);

  it("names the billing exhaustion without opening a log tab", () => {
    expect(reason).toContain("credit or billing balance is too low");
    expect(reason).toContain(`AIW-DIAG-${RUN_ID}-planning-1`);
  });

  it("names the enforced spend limit without opening a log tab (AIW-312)", () => {
    // The 2026-08-21 recurrence: Codex classified the refusal as provider_error
    // (after the AIW-312 reorder), the provider sentence rides in providerError,
    // and the stderr tail is only the benign PATH-aliases startup warning.
    const spend = executionError("Codex emitted a provider error event.", {
      category: "provider",
      message: "The current agent phase could not be completed.",
      phase: "implementation",
      evidence: {
        failureKind: "provider_error",
        exitCode: 1,
        providerError:
          "stream disconnected before completion: Your project has reached its " +
          "configured enforced spend limit. Update your limit at " +
          "https://platform.openai.com/settings/proj_test1234/limits.",
        stderrTail:
          "WARNING: proceeding, even though we could not create PATH aliases: " +
          'Refusing to create helper binaries under temporary dir "/tmp"',
      },
    });
    const spendReason = formatExecutionErrorForUser(
      createWorkflowExecutionErrorState(RUN_ID, "implementation", 1, spend.error),
    );
    expect(spendReason).toContain("spend limit");
    expect(spendReason).toContain(`AIW-DIAG-${RUN_ID}-implementation-1`);
    expect(spendReason).not.toContain("PATH aliases");
    expect(sanitizeRunError(spendReason, "Workflow execution failed.")).toEqual({
      message: spendReason,
      code: `AIW-DIAG-${RUN_ID}-implementation-1`,
    });
  });

  it("shows the same message in the run header and the run list", () => {
    // Both read run.error / the durable status reason through this boundary.
    expect(sanitizeRunError(reason, "Workflow execution failed.")).toEqual({
      message: reason,
      code: `AIW-DIAG-${RUN_ID}-planning-1`,
    });
  });

  it("shows the same message in the Slack notification", () => {
    const slack = formatTicketEvent(
      { kind: "failed", phase: "research", reason },
      "AWT-42",
      "https://blazity.atlassian.net",
    );
    expect(slack).toContain(reason);
  });

  it("agrees across surfaces even when the cause carried a credentialed URL", () => {
    // The run header runs a SECOND redaction pass (the replay sanitizer) that
    // Slack and the ticket comment do not. It rewrites any `scheme://userinfo@host`
    // whole, host included, so a message still carrying "[redacted]@host" read
    // three different ways on three surfaces.
    const withCredentialedUrl = formatExecutionErrorForUser(
      createWorkflowExecutionErrorState(
        RUN_ID,
        "push",
        1,
        executionError("The CLI exited with code 1.", {
          category: "unknown",
          evidence: {
            failureKind: "cli_exit",
            exitCode: 1,
            stderrTail:
              "push rejected for https://ci:glpat-AbCdEfGhIjKlMnOpQr@gitlab.com/acme/app.git",
          },
        }).error,
      ),
    );
    expect(withCredentialedUrl).not.toContain("glpat-AbCdEfGhIjKlMnOpQr");
    // The host survives, on every surface.
    expect(withCredentialedUrl).toContain("https://gitlab.com/acme/app.git");
    expect(
      sanitizeRunError(withCredentialedUrl, "Workflow execution failed.")?.message,
    ).toBe(withCredentialedUrl);
    expect(
      formatTicketEvent(
        { kind: "failed", reason: withCredentialedUrl },
        "AWT-42",
        "https://blazity.atlassian.net",
      ),
    ).toContain(withCredentialedUrl);
  });

  it("shows the same message in the ticket comment", () => {
    // The comment posts `reason` verbatim. This pins WHY it is not passed
    // through scrubForPublication: that scrub is built for agent prose and its
    // markers match text a captured provider tail can legitimately contain, so
    // running it here would delete the reason from this one surface and make the
    // four disagree. Demonstrated rather than asserted by comment.
    const withSandboxPath = formatExecutionErrorForUser(
      createWorkflowExecutionErrorState(
        RUN_ID,
        "planning",
        1,
        executionError("The CLI exited with code 1.", {
          category: "provider",
          message: "The current agent phase could not be completed.",
          evidence: {
            failureKind: "cli_exit",
            exitCode: 1,
            stderrTail: "codex: cannot write /vercel/sandbox/repo/app: read-only",
          },
        }).error,
      ),
    );
    expect(withSandboxPath).toContain("read-only");
    expect(scrubForPublication(withSandboxPath)).not.toBe(withSandboxPath);
  });
});
