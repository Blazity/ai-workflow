import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scrubForPublication } from "./support/publication-scrub.js";
import { sanitizeRunError } from "../services/overview/sanitize-run-detail.js";
import {
  createWorkflowExecutionErrorState,
  type ExecutionErrorCategory,
} from "@shared/contracts";
import { formatExecutionErrorForUser } from "./helpers/execution-error.js";
import {
  executionError,
  SAFE_EXECUTION_ERROR_MESSAGES,
} from "@shared/workflow-graph";
import { sanitizeDetail, sanitizeFailureMessage } from "@shared/workflow-graph";
import { validateRepositoryDiscoveryResult } from "./repository-discovery/protocol.js";
import { missingRepositoriesFailure } from "./repository-discovery/runner.js";

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
 * (the scheduler kept its own copy of the sentence table and returned it
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

/** Production sources, tests excluded: the invariant is about production paths. */
function productionSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      productionSourceFiles(path, found);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry === "test-support.ts") continue;
    found.push(path);
  }
  return found;
}

const WORKER_SOURCE_ROOT = join(import.meta.dirname, "..");
/** The one construction path moved out of the worker in stage 12-6b, so the
 *  scan has to follow it: a second path could now be written on either side. */
const GRAPH_PACKAGE_ROOT = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "workflow-graph",
);
const INTERPRETER = join(GRAPH_PACKAGE_ROOT, "interpreter.ts");

describe("execution error invariant: one construction path", () => {
  const files = [
    ...productionSourceFiles(WORKER_SOURCE_ROOT),
    ...productionSourceFiles(GRAPH_PACKAGE_ROOT),
  ].map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));

  it("finds the sources to scan at all", () => {
    // Guards the two scans below against silently passing on an empty list if
    // this file or the package ever moves.
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
  // exhausted OpenAI account. The provider's own sentence arrives in the
  // structured provider error, out of the Codex error event (AIW-312); the
  // agent's stdout stream is quoted but never classified.
  const built = executionError("Codex emitted a provider error event.", {
    category: "provider",
    message: "The current agent phase could not be completed.",
    phase: "planning",
    evidence: {
      failureKind: "provider_error",
      exitCode: 1,
      providerError:
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
    expect(sanitizeRunError(spendReason, "Workflow execution failed.", [])).toEqual({
      message: spendReason,
      code: `AIW-DIAG-${RUN_ID}-implementation-1`,
    });
  });

  it("shows the same message in the run header and the run list", () => {
    // Both read run.error / the durable status reason through this boundary.
    expect(sanitizeRunError(reason, "Workflow execution failed.", [])).toEqual({
      message: reason,
      code: `AIW-DIAG-${RUN_ID}-planning-1`,
    });
  });

  // The chat surface left core in S9: the reason travels as
  // `TicketEvent.failed.reason` and the connected messaging provider renders
  // it. `integrations/slack/format.test.ts` holds that the renderer carries it
  // whole, including a reason that still contains a credentialed URL.

  it("agrees across surfaces even when the cause carried a credentialed URL", () => {
    // The run header runs a SECOND redaction pass (the replay sanitizer) that
    // the chat notification and the ticket comment do not. It rewrites any `scheme://userinfo@host`
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
      sanitizeRunError(withCredentialedUrl, "Workflow execution failed.", [])?.message,
    ).toBe(withCredentialedUrl);
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

/**
 * MESSAGE_MAX_LENGTH is a claim, and this is what makes it true: "sized so
 * `deriveFailureMessage` can never produce a message this boundary has to
 * clamp". A bound that does not fit the worst message this code can author is
 * not a bound, it is a truncation, and on 2026-09-18 it truncated: run
 * wrun_01M2SDKXF5QYNCXGCMRJJQ2HFF told the person on the ticket "This
 * deployment's confi [...] o continue.".
 *
 * So the worst case is MEASURED here against the real builders rather than
 * asserted in a comment. It is measurable at all because the count is capped:
 * a discovery result carries at most MAX_DISCOVERED_REPOSITORIES (3)
 * repositories, so each builder writes at most three sentences and one closing
 * note. The other two inputs have no schema bound worth trusting, so the test
 * pins the realistic ceiling it claims: a 70-character repository key (GitHub
 * caps an owner at 39 characters and no real repository name approaches the
 * rest) and a 60-character actor label.
 *
 * What fails this test: raising a refusal's length past the bound, whether by
 * lengthening a sentence, adding a fourth, or raising MAX_DISCOVERED_REPOSITORIES,
 * without moving MESSAGE_MAX_LENGTH with it.
 */
describe("every authored work-scope refusal reaches the person whole", () => {
  /** Exactly 70 characters each, the ceiling this bound is sized against. */
  const KEYS = [
    "github:blazity-engineering-platform/ai-workflow-worker-canary-fixtures",
    "gitlab:blazity-engineering-platform/ai-workflow-dashboard-e2e-fixtures",
    "github:blazity-engineering-platform/ai-workflow-arthur-release-fixture",
  ];
  /** 60 characters: a display name with a team suffix, the long end of real. */
  const ACTOR = {
    kind: "person" as const,
    actorId: "u-1",
    actorLabel: "Aleksandra Kowalska-Nowakowska (Platform Engineering Team)".padEnd(60, "."),
  };
  const DECIDED_AT = "2026-09-18T08:30:00.000Z";
  const CONFIGURATION_GENERIC =
    SAFE_EXECUTION_ERROR_MESSAGES.configuration as string;

  const catalogEntry = (key: string) => ({
    provider: key.slice(0, key.indexOf(":")) as "github" | "gitlab",
    repoPath: key.slice(key.indexOf(":") + 1),
    name: "fixture",
    defaultBranch: "main",
    description: "",
    topics: [],
    relationships: [],
    usable: true,
  });
  const proposals = KEYS.map((key) => ({
    provider: key.slice(0, key.indexOf(":")),
    repoPath: key.slice(key.indexOf(":") + 1),
    rationale: "the ticket names it",
  }));
  const recorded = (state: "excluded" | "unavailable") =>
    KEYS.map((repositoryKey) => ({
      repositoryKey,
      state,
      origin: "person",
      rationale: "decided on this work",
      decidedBy: ACTOR,
      decidedAt: DECIDED_AT,
      ...(state === "unavailable" ? { unavailableReason: "not_enabled" } : {}),
    })) as never;

  /** `named` is what the text must name: every key, unless the case is one
   *  that counts some of them instead. */
  function refusal(
    label: string,
    raw: unknown,
    catalog: ReturnType<typeof catalogEntry>[],
    settled: Parameters<typeof validateRepositoryDiscoveryResult>[3],
    named: readonly string[] = KEYS,
  ): { label: string; text: string; named: readonly string[] } {
    const decision = validateRepositoryDiscoveryResult(raw, catalog, [], settled);
    if (decision.kind !== "failed") {
      throw new Error(`${label}: discovery decided ${decision.kind}, not a refusal`);
    }
    return { label, text: decision.error, named };
  }

  const usableCatalog = KEYS.map(catalogEntry);
  const lowConfidence = {
    status: "selected",
    confidence: "low",
    repositories: proposals,
    questions: null,
    error: null,
  };
  const highConfidence = { ...lowConfidence, confidence: "high" };

  /** The three builders, each driven at three repositories, in every variant
   *  whose length differs. A mix of one exclusion and two unavailable entries is
   *  the longest `nothingLeftToWorkOn` can write: the unavailable sentence is
   *  the longer of its two, and a single exclusion is enough to swap the short
   *  closing note for the long one. */
  const WORST_CASES = [
    refusal("nothingLeftToStartFrom, comment path open", lowConfidence, usableCatalog, {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: KEYS,
      recorded: [],
      commentPathIsTaken: () => true,
    }),
    refusal("nothingLeftToStartFrom, record only", lowConfidence, usableCatalog, {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: KEYS,
      recorded: [],
      commentPathIsTaken: () => false,
    }),
    refusal("nothingLeftButUnnamed, comment path open", highConfidence, usableCatalog, {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: KEYS,
      recorded: [],
      commentPathIsTaken: () => true,
    }),
    refusal("nothingLeftButUnnamed, record only", highConfidence, usableCatalog, {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: KEYS,
      recorded: [],
      commentPathIsTaken: () => false,
    }),
    // The offer an answer emptied can hold any number, so it is driven past
    // the ceiling: five left out, two named and three counted. The keys it
    // does not name are why it is not checked for every key below.
    refusal(
      "nothingLeftToOffer, more left out than named",
      { status: "clarification_needed", confidence: null, repositories: null, questions: null, error: null },
      [],
      {
        answerLeftUnnamed: [
          ...KEYS,
          "github:blazity-engineering-platform/ai-workflow-fourth-left-out-fixture",
          "github:blazity-engineering-platform/ai-workflow-fifth-left-out-fixture",
        ],
        answeredRepositoryKeys: KEYS,
        recorded: [],
        commentPathIsTaken: () => true,
      },
      KEYS.slice(0, 2),
    ),
    refusal("nothingLeftToWorkOn, all excluded", highConfidence, [], {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: KEYS,
      recorded: recorded("excluded"),
      commentPathIsTaken: () => true,
    }),
    refusal("nothingLeftToWorkOn, all unavailable", highConfidence, [], {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: KEYS,
      recorded: recorded("unavailable"),
      commentPathIsTaken: () => true,
    }),
    refusal("nothingLeftToWorkOn, one excluded and two unavailable", highConfidence, [], {
      answerLeftUnnamed: [],
      answeredRepositoryKeys: KEYS,
      recorded: [
        (recorded("excluded") as unknown as unknown[])[0],
        ...((recorded("unavailable") as unknown as unknown[]).slice(1)),
      ] as never,
      commentPathIsTaken: () => true,
    }),
  ];

  it("drives all three builders at the ceiling it claims", () => {
    // Guards the loop below against silently passing on a list that stopped
    // reaching one of the three, or on keys that quietly shrank: each builder
    // writes a sentence only it writes, and the ceiling is the whole basis for
    // the number below.
    for (const key of KEYS) expect(key).toHaveLength(70);
    expect(ACTOR.actorLabel).toHaveLength(60);
    const all = WORST_CASES.map((worst) => worst.text).join("\n");
    expect(all).toContain("Not naming a repository is not choosing it");
    expect(all).toContain("was listed in a repository question already answered");
    expect(all).toContain("was excluded on this work by");
    expect(all).toContain("is not available to this run");
  });

  for (const { label, text, named } of WORST_CASES) {
    it(`${label} crosses every surface unclamped`, () => {
      const out = formatExecutionErrorForUser(
        createWorkflowExecutionErrorState(
          RUN_ID,
          "prepare",
          1,
          // Exactly what the discovery closure in agent-workflow.ts passes: the
          // refusal as the lead AND as the detail.
          executionError(text, { category: "configuration", message: text }).error,
        ),
      );

      // Whole, to the character: the refusal the builder wrote, then the
      // diagnostic ID, and nothing removed from between them. The elision check
      // is redundant against that equality and stays because it names the
      // defect: it is the marker production put where the repository was.
      expect(out, `${label} was elided: ${out}`).not.toContain("[...]");
      expect(out).toBe(`${text} Diagnostic ID: AIW-DIAG-${RUN_ID}-prepare-1`);
      // Said separately, because these are the two facts the person on the
      // ticket could not act without: which repositories, and the way back,
      // which is always the refusal's last sentence.
      for (const key of named) expect(out).toContain(key);
      expect(out).toContain(text.slice(text.lastIndexOf(". ", text.length - 2) + 2));

      // Never the bare category line, which is the AIW-254 invariant above.
      expect(out.startsWith(CONFIGURATION_GENERIC)).toBe(false);

      // The cross-surface guarantee: the run header applies this bound, Slack
      // and the ticket comment do not, so a clamp here would make them disagree.
      expect(sanitizeFailureMessage(out), `${label} was clamped at the boundary`).toBe(out);
    });
  }

  it("cuts an actor label no real display name reaches, and marks the cut", () => {
    // The third input to the sizing above, and the one with no schema bound:
    // `workScopeActorSchema` is `z.string().min(1)` with no maximum, and the
    // label appears once per repository, so an unbounded label is an unbounded
    // message however few repositories there are. The cap is a DISPLAY bound at
    // composition, not a `.max()` on the contract: entries are already stored
    // and a read that throws on one of them is worse than a long sentence.
    const absurd = "A".repeat(500);
    const [{ text }] = [
      refusal("over-long label", highConfidence, [], {
        answerLeftUnnamed: [],
        answeredRepositoryKeys: KEYS,
        recorded: KEYS.map((repositoryKey) => ({
          repositoryKey,
          state: "excluded",
          origin: "person",
          rationale: "decided on this work",
          decidedBy: { kind: "person", actorId: "u-1", actorLabel: absurd },
          decidedAt: DECIDED_AT,
        })) as never,
        commentPathIsTaken: () => true,
      }),
    ];
    expect(text).not.toContain(absurd);
    // Marked, not silently shortened: a name cut without a mark is a different
    // name, and this sentence is telling somebody whose decision it was.
    expect(text).toContain(`${"A".repeat(57)}...`);
    // And the sizing claim survives the worst label anybody could store.
    expect(text.length).toBeLessThanOrEqual(909);
  });

  it("keeps the planning loop's own refusal inside the bound too", () => {
    // The fourth builder, added when the planning loop stopped dying on a
    // repository it could not have and started saying why. Same ceiling: three
    // repositories (what one request may name), 70-character keys, and the
    // longest mix of levers it can owe. It is bounded by construction rather
    // than measured, so what this pins is that the construction really holds
    // and that no surface has to clamp the result.
    const reasons = ["excluded", "outside_catalog", "unusable"] as const;
    const text = missingRepositoriesFailure(
      KEYS.map((repositoryKey, index) => ({
        repositoryKey,
        reason: reasons[index]!,
        sentence: `${repositoryKey} was excluded on this work by ${ACTOR.actorLabel} on 2026-09-18, so it is not attached.`,
      })),
      [
        "Excluding a repository is not final: this work's repository list can be changed through the work scope API or the work_scope.edit tool, and the next run starts from the changed list.",
        `The catalog cannot serve ${KEYS[0]} at the moment, so changing the list brings that repository back only once the catalog can.`,
      ],
    );
    const out = formatExecutionErrorForUser(
      createWorkflowExecutionErrorState(
        RUN_ID,
        "planning",
        1,
        executionError(text, { category: "engine", message: text }).error,
      ),
    );
    expect(out, `the planning refusal was elided: ${out}`).not.toContain("[...]");
    expect(out).toBe(`${text} Diagnostic ID: AIW-DIAG-${RUN_ID}-planning-1`);
    for (const key of KEYS) expect(out).toContain(key);
    expect(sanitizeFailureMessage(out)).toBe(out);
  });

  it("keeps the longest of them inside the bound with room to spare", () => {
    // The measurement the constant's comment quotes. 909 characters at this
    // ceiling, against a derived bound of 964. If this number moves, the comment
    // on MESSAGE_MAX_LENGTH is stale and the margin has to be re-decided rather
    // than quietly spent.
    const longest = WORST_CASES.reduce((worst, candidate) =>
      candidate.text.length > worst.text.length ? candidate : worst,
    );
    expect(longest.text.length, `longest is now ${longest.label}`).toBe(909);
  });
});
