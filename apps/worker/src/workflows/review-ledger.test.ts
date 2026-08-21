import { describe, expect, it } from "vitest";
import type {
  ReviewLedgerState,
  ReviewThread,
  ReviewThreadDisposition,
  ReviewThreadFeed,
} from "../adapters/vcs/types.js";
import {
  buildCorrectionNote,
  buildReviewLedgerGuardSummary,
  buildGateFailureReason,
  buildRunFailureNote,
  planSettlements,
  resolveReviewGate,
  selectWorkItems,
  verifyDispositions,
} from "./review-ledger.js";

const thread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  threadId: "th-1",
  alias: "T1",
  source: "human",
  resolvable: true,
  awaitingHuman: false,
  notes: [
    {
      author: "reviewer",
      body: "Please rename this helper.",
      createdAt: "2026-08-21T10:00:00.000Z",
      isLedgerReply: false,
    },
  ],
  ...overrides,
});

const feed = (threads: ReviewThread[]): ReviewThreadFeed => ({
  threads,
  truncated: 0,
  snapshotAt: "2026-08-21T10:05:00.000Z",
});

describe("selectWorkItems", () => {
  it("keeps threads that wait on us and drops awaitingHuman and third party ones", () => {
    const items = selectWorkItems(
      feed([
        thread({ threadId: "th-1", alias: "T1" }),
        thread({ threadId: "th-2", alias: "T2", awaitingHuman: true }),
        thread({ threadId: "th-3", alias: "T3", source: "third_party" }),
        thread({ threadId: "th-4", alias: "T4", source: "bot" }),
      ]),
    );
    expect(items.map((item) => item.alias)).toEqual(["T1", "T4"]);
  });
});

const files = (map: Record<string, string>) => async (filePath: string) =>
  map[filePath] ?? null;

const verify = (input: {
  workItems: ReviewThread[];
  dispositions: ReviewThreadDisposition[];
  files?: Record<string, string>;
}) =>
  verifyDispositions({
    workItems: input.workItems,
    dispositions: input.dispositions,
    readFile: files(input.files ?? {}),
  });

describe("verifyDispositions", () => {
  it("rejects a work item the agent said nothing about", async () => {
    const result = await verify({
      workItems: [thread({ alias: "T1" }), thread({ threadId: "th-2", alias: "T2" })],
      dispositions: [{ alias: "T1", disposition: "actionable" }],
    });
    expect(result.accepted).toEqual([
      { alias: "T1", threadId: "th-1", disposition: "actionable" },
    ]);
    expect(result.rejected).toEqual([{ alias: "T2", reason: "no disposition" }]);
  });

  it("rejects a disposition for an alias that is not a work item", async () => {
    const result = await verify({
      workItems: [thread({ alias: "T1" })],
      dispositions: [
        { alias: "T1", disposition: "actionable" },
        { alias: "T9", disposition: "actionable" },
      ],
    });
    expect(result.accepted).toEqual([
      { alias: "T1", threadId: "th-1", disposition: "actionable" },
    ]);
    expect(result.rejected).toEqual([{ alias: "T9", reason: "unknown alias" }]);
  });

  it("rejects every disposition of an alias the agent answered twice", async () => {
    const result = await verify({
      workItems: [thread({ alias: "T1" })],
      dispositions: [
        { alias: "T1", disposition: "actionable" },
        { alias: "T1", disposition: "out_of_scope", reply: "Not this ticket." },
      ],
    });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ alias: "T1", reason: "duplicate disposition" }]);
  });

  it("accepts already_addressed when the quote survives whitespace normalization", async () => {
    const result = await verify({
      workItems: [thread({ alias: "T1" })],
      dispositions: [
        {
          alias: "T1",
          disposition: "already_addressed",
          evidence: {
            filePath: "src/a.ts",
            quote: "const requestTimeout   =\n  30_000;",
          },
        },
      ],
      files: {
        "src/a.ts": "export function run() {\n  const requestTimeout = 30_000;\n}\n",
      },
    });
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });

  it("rejects already_addressed whose quote is nowhere in the file", async () => {
    const result = await verify({
      workItems: [thread({ alias: "T1" })],
      dispositions: [
        {
          alias: "T1",
          disposition: "already_addressed",
          evidence: { filePath: "src/a.ts", quote: "const requestTimeout = 30_000;" },
        },
      ],
      files: { "src/a.ts": "export function run() {}\n" },
    });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ alias: "T1", reason: "quote not found in file" }]);
  });

  it("rejects already_addressed without evidence and with an unreadable file", async () => {
    const noEvidence = await verify({
      workItems: [thread({ alias: "T1" })],
      dispositions: [{ alias: "T1", disposition: "already_addressed" }],
    });
    expect(noEvidence.rejected).toEqual([{ alias: "T1", reason: "evidence required" }]);

    const blankQuote = await verify({
      workItems: [thread({ alias: "T1" })],
      dispositions: [
        {
          alias: "T1",
          disposition: "already_addressed",
          evidence: { filePath: "src/a.ts", quote: "   " },
        },
      ],
      files: { "src/a.ts": "anything" },
    });
    expect(blankQuote.rejected).toEqual([{ alias: "T1", reason: "evidence required" }]);

    const missingFile = await verify({
      workItems: [thread({ alias: "T1" })],
      dispositions: [
        {
          alias: "T1",
          disposition: "already_addressed",
          evidence: {
            filePath: "src/gone.ts",
            quote: "const requestTimeout = 30_000;",
          },
        },
      ],
      files: {},
    });
    expect(missingFile.rejected).toEqual([
      { alias: "T1", reason: "evidence file not found" },
    ]);
  });

  it("holds an inline thread's evidence to its own file and line window", async () => {
    const inline = thread({ alias: "T1", filePath: "src/a.ts", line: 100 });
    const body = Array.from(
      { length: 200 },
      (_, index) => `const marker${index + 1} = renderRow(${index + 1});`,
    ).join("\n");
    const quoteAt = (line: number) => `const marker${line} = renderRow(${line});`;

    const otherFile = await verify({
      workItems: [inline],
      dispositions: [
        {
          alias: "T1",
          disposition: "already_addressed",
          evidence: { filePath: "src/b.ts", quote: quoteAt(100) },
        },
      ],
      files: { "src/a.ts": body, "src/b.ts": body },
    });
    expect(otherFile.accepted).toEqual([]);
    expect(otherFile.rejected).toEqual([
      { alias: "T1", reason: "evidence must come from the thread's file" },
    ]);

    const rejectedLine = async (line: number) =>
      (
        await verify({
          workItems: [inline],
          dispositions: [
            {
              alias: "T1",
              disposition: "already_addressed",
              evidence: { filePath: "src/a.ts", quote: quoteAt(line) },
            },
          ],
          files: { "src/a.ts": body },
        })
      ).rejected;

    // Window is [line - 40, line + 40], so 140 is the last line that counts.
    expect(await rejectedLine(141)).toEqual([
      { alias: "T1", reason: "quote outside the thread's line window" },
    ]);
    expect(await rejectedLine(180)).toEqual([
      { alias: "T1", reason: "quote outside the thread's line window" },
    ]);
    expect(await rejectedLine(140)).toEqual([]);
    expect(await rejectedLine(60)).toEqual([]);
  });

  it("never lets a bot thread be marked already_addressed", async () => {
    const result = await verify({
      workItems: [thread({ alias: "T1", source: "bot" })],
      dispositions: [
        {
          alias: "T1",
          disposition: "already_addressed",
          evidence: { filePath: "src/a.ts", quote: "const requestTimeout = 30_000;" },
        },
      ],
      files: { "src/a.ts": "const requestTimeout = 30_000;" },
    });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { alias: "T1", reason: "bot threads cannot be marked already_addressed" },
    ]);
  });

  it("requires a reply on question and out_of_scope but not on actionable", async () => {
    const result = await verify({
      workItems: [
        thread({ threadId: "th-1", alias: "T1" }),
        thread({ threadId: "th-2", alias: "T2" }),
        thread({ threadId: "th-3", alias: "T3" }),
      ],
      dispositions: [
        { alias: "T1", disposition: "question" },
        { alias: "T2", disposition: "out_of_scope", reply: "  " },
        { alias: "T3", disposition: "actionable" },
      ],
    });
    expect(result.accepted).toEqual([
      { alias: "T3", threadId: "th-3", disposition: "actionable" },
    ]);
    expect(result.rejected).toEqual([
      { alias: "T1", reason: "reply required" },
      { alias: "T2", reason: "reply required" },
    ]);
  });
});

const gate = (input: {
  workItems?: ReviewThread[];
  accepted?: ReviewThreadDisposition[];
  rejected?: { alias: string; reason: string }[];
  researchDeclaresWrites?: boolean;
  retryUsed?: boolean;
}) =>
  resolveReviewGate({
    workItems: input.workItems ?? [thread({ alias: "T1" })],
    verification: {
      accepted: input.accepted ?? [],
      rejected: input.rejected ?? [],
    },
    researchDeclaresWrites: input.researchDeclaresWrites ?? false,
    retryUsed: input.retryUsed ?? false,
  });

describe("resolveReviewGate", () => {
  it("stays out of the way when there are no work items", () => {
    expect(gate({ workItems: [] })).toBeNull();
  });

  it("proceeds when the agent owes work on a thread", () => {
    expect(gate({ accepted: [{ alias: "T1", disposition: "actionable" }] })).toBe(
      "proceed",
    );
  });

  it("blocks the run as no_change when every thread is settled without writes", () => {
    expect(
      gate({
        accepted: [
          {
            alias: "T1",
            disposition: "already_addressed",
            evidence: { filePath: "src/a.ts", quote: "const timeout = 30;" },
          },
          { alias: "T2", disposition: "question", reply: "Which endpoint?" },
        ],
      }),
    ).toBe("no_change");
  });

  it("lets the agent write for reasons outside the threads", () => {
    expect(
      gate({
        accepted: [{ alias: "T1", disposition: "question", reply: "Which endpoint?" }],
        researchDeclaresWrites: true,
      }),
    ).toBe("proceed");
  });

  it("retries once on rejections and then fails", () => {
    const rejected = [{ alias: "T1", reason: "quote not found in file" }];
    expect(gate({ rejected })).toBe("retry");
    expect(gate({ rejected, retryUsed: true })).toBe("fail");
    expect(
      gate({
        rejected,
        accepted: [{ alias: "T2", disposition: "actionable" }],
        retryUsed: true,
      }),
    ).toBe("fail");
  });
});

describe("buildCorrectionNote", () => {
  it("lists every rejection and restates what already_addressed means", () => {
    expect(
      buildCorrectionNote([
        { alias: "T1", reason: "no disposition" },
        { alias: "T3", reason: "quote not found in file" },
      ]),
    ).toBe(
      [
        "Review thread dispositions were rejected",
        "",
        "- T1: no disposition",
        "- T3: quote not found in file",
        "",
        "Every alias listed above needs a new disposition. `already_addressed` means the change exists on the branch now and you can quote it literally from the thread's file, otherwise use `actionable`.",
      ].join("\n"),
    );
  });
});

describe("buildGateFailureReason", () => {
  it("names every alias and its rule on one line", () => {
    expect(
      buildGateFailureReason([
        { alias: "T1", reason: "no disposition" },
        { alias: "T3", reason: "quote not found in file" },
      ]),
    ).toBe(
      "review ledger: dispositions rejected twice for T1 (no disposition), T3 (quote not found in file)",
    );
  });
});

describe("buildRunFailureNote", () => {
  it("says what failed and which threads stay open", () => {
    expect(
      buildRunFailureNote({
        runId: "wrun_01",
        reason: "pre-PR checks did not pass",
        unsettledAliases: ["T1", "T3"],
      }),
    ).toBe(
      "AI Workflow run `wrun_01` failed before it could address review feedback: pre-PR checks did not pass. Threads left open: T1, T3.",
    );
  });

  it("drops the thread sentence when nothing is left open", () => {
    expect(
      buildRunFailureNote({
        runId: "wrun_01",
        reason: "pre-PR checks did not pass",
        unsettledAliases: [],
      }),
    ).toBe(
      "AI Workflow run `wrun_01` failed before it could address review feedback: pre-PR checks did not pass.",
    );
  });
});

// Literal marker text as produced by reviewLedgerMarker("th-1"), spelled out
// so a change to the helper shows up as a failing test here.
const MARKER_T1 = "<!-- ai-workflow:ledger:th-1 --> <!-- ai-workflow:bot -->";

const settle = (input: {
  threads?: ReviewThread[];
  accepted: ReviewThreadDisposition[];
  headSha?: string | null;
  evidencePresent?: (d: ReviewThreadDisposition) => boolean;
}) =>
  planSettlements({
    feed: feed(input.threads ?? [thread({ threadId: "th-1", alias: "T1" })]),
    accepted: input.accepted,
    headSha: input.headSha ?? null,
    evidencePresent: input.evidencePresent ?? ((d) => Boolean(d.evidence)),
  });

describe("planSettlements", () => {
  it("resolves an actionable thread once there is a pushed commit", () => {
    const plans = settle({
      accepted: [
        { alias: "T1", disposition: "actionable", reply: "Renamed the helper." },
      ],
      headSha: "abc1234",
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.thread.threadId).toBe("th-1");
    expect(plans[0]!.resolve).toBe(true);
    expect(plans[0]!.body).toBe(
      ["Addressed in `abc1234`.", "Renamed the helper.", "", MARKER_T1].join("\n"),
    );
  });

  it("skips an actionable thread when nothing was pushed", () => {
    expect(
      settle({
        accepted: [{ alias: "T1", disposition: "actionable" }],
        headSha: null,
      }),
    ).toEqual([]);
  });

  it("quotes the evidence for already_addressed and never resolves it", () => {
    const plans = settle({
      accepted: [
        {
          alias: "T1",
          disposition: "already_addressed",
          evidence: { filePath: "src/a.ts", quote: "const timeout = 30;" },
        },
      ],
      headSha: "abc1234",
    });
    expect(plans[0]!.resolve).toBe(false);
    expect(plans[0]!.body).toBe(
      [
        "Already addressed in `src/a.ts`:",
        "",
        "> const timeout = 30;",
        "",
        MARKER_T1,
      ].join("\n"),
    );
  });

  it("falls back to asking for another look when the evidence is gone", () => {
    const disposition: ReviewThreadDisposition = {
      alias: "T1",
      disposition: "already_addressed",
      evidence: { filePath: "src/a.ts", quote: "const timeout = 30;" },
    };
    const withSha = settle({
      accepted: [disposition],
      headSha: "abc1234",
      evidencePresent: () => false,
    });
    expect(withSha[0]!.body).toBe(
      [
        "The quote I verified from `src/a.ts` is no longer present at `abc1234`; please take another look.",
        "",
        MARKER_T1,
      ].join("\n"),
    );

    const withoutSha = settle({
      accepted: [disposition],
      headSha: null,
      evidencePresent: () => false,
    });
    expect(withoutSha[0]!.body).toBe(
      [
        "This appears to be covered already; please take another look.",
        "",
        MARKER_T1,
      ].join("\n"),
    );
    expect(withoutSha[0]!.resolve).toBe(false);
  });

  it("replies with the agent's own words on question and out_of_scope", () => {
    const plans = settle({
      threads: [
        thread({ threadId: "th-1", alias: "T1" }),
        thread({ threadId: "th-2", alias: "T2" }),
      ],
      accepted: [
        { alias: "T1", disposition: "question", reply: "Which endpoint do you mean?" },
        { alias: "T2", disposition: "out_of_scope", reply: "Filed as a separate ticket." },
      ],
      headSha: "abc1234",
    });
    expect(plans.map((plan) => plan.resolve)).toEqual([false, false]);
    expect(plans[0]!.body).toBe(
      ["Which endpoint do you mean?", "", MARKER_T1].join("\n"),
    );
    expect(plans[1]!.body).toContain("<!-- ai-workflow:ledger:th-2 -->");
  });

  it("ignores an accepted alias the feed no longer knows", () => {
    expect(
      settle({
        accepted: [{ alias: "T9", disposition: "actionable" }],
        headSha: "abc1234",
      }),
    ).toEqual([]);
  });
});

describe("generated copy", () => {
  it("keeps every generated string free of en and em dashes", () => {
    const copy = [
      buildCorrectionNote([{ alias: "T1", reason: "quote not found in file" }]),
      buildGateFailureReason([{ alias: "T1", reason: "no disposition" }]),
      buildRunFailureNote({
        runId: "wrun_01",
        reason: "pre-PR checks did not pass",
        unsettledAliases: ["T1"],
      }),
      ...settle({
        accepted: [{ alias: "T1", disposition: "actionable" }],
        headSha: "abc1234",
      }).map((plan) => plan.body),
    ].join("\n");
    // U+2013 en dash and U+2014 em dash, matched by escape so this file does
    // not spell them out either.
    expect(copy).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("verifyDispositions unicode handling", () => {
  // Escapes, not raw characters, so the difference between the file and the
  // evidence quote is visible in the source instead of depending on the editor.
  const cases: { name: string; file: string; quote: string }[] = [
    {
      name: "curly quotes in the file, ASCII quotes in the evidence",
      file: "const label = \u201cDon\u2019t retry the webhook here\u201d;",
      quote: "const label = \"Don't retry the webhook here\";",
    },
    {
      name: "NFD in the file, NFC in the evidence",
      file: "const label = \"cafe\u0301 receipts stay cached\";",
      quote: "const label = \"caf\u00e9 receipts stay cached\";",
    },
    {
      name: "zero width space inside a file token",
      file: "const width = wrapper.\u200boffsetWidth + padding;",
      quote: "const width = wrapper.offsetWidth + padding;",
    },
  ];

  for (const entry of cases) {
    it(`accepts honest evidence with ${entry.name}`, async () => {
      const result = await verify({
        workItems: [thread({ alias: "T1" })],
        dispositions: [
          {
            alias: "T1",
            disposition: "already_addressed",
            evidence: { filePath: "src/a.ts", quote: entry.quote },
          },
        ],
        files: { "src/a.ts": entry.file },
      });
      expect(result.rejected).toEqual([]);
      expect(result.accepted).toHaveLength(1);
    });
  }
});

describe("verifyDispositions evidence quality", () => {
  const quality = async (filePath: string, quote: string, file: string) =>
    (
      await verify({
        workItems: [thread({ alias: "T1" })],
        dispositions: [
          {
            alias: "T1",
            disposition: "already_addressed",
            evidence: { filePath, quote },
          },
        ],
        files: { [filePath]: file },
      })
    ).rejected;

  it("rejects a quote that proves nothing on its own", async () => {
    expect(await quality("src/a.ts", "}", "function run() {\n}\n")).toEqual([
      { alias: "T1", reason: "quote too short to verify" },
    ]);
    expect(
      await quality("docs/runbook.md", "## Deployment", "## Deployment\n\nRun it.\n"),
    ).toEqual([{ alias: "T1", reason: "quote too short to verify" }]);
    expect(
      await quality(
        "src/a.ts",
        "veryLongFunctionNameThatGoesOnAndOn(argument);",
        "veryLongFunctionNameThatGoesOnAndOn(argument);\n",
      ),
    ).toEqual([{ alias: "T1", reason: "quote too short to verify" }]);
  });

  it("rejects a markdown heading but keeps a code comment that starts with a hash", async () => {
    const heading = "## Deployment steps for the worker";
    for (const filePath of ["docs/runbook.md", "docs/runbook.mdx", "docs/r.markdown"]) {
      expect(await quality(filePath, heading, `${heading}\n\nRun the deploy.\n`)).toEqual([
        { alias: "T1", reason: "quote is only a heading" },
      ]);
    }

    const comment = "# retry the webhook once per hour";
    expect(await quality("scripts/retry.py", comment, `${comment}\nretry()\n`)).toEqual([]);

    const prose = "The worker retries the webhook once per hour.";
    expect(
      await quality("docs/runbook.md", prose, `## Retries\n\n${prose}\n`),
    ).toEqual([]);
  });
});

describe("verifyDispositions thread binding", () => {
  it("stamps the matched threadId on every accepted disposition", async () => {
    const result = await verify({
      workItems: [thread({ threadId: "th-abc", alias: "T1" })],
      dispositions: [
        { alias: "T1", disposition: "question", reply: "Which endpoint do you mean?" },
      ],
    });
    expect(result.accepted).toEqual([
      {
        alias: "T1",
        threadId: "th-abc",
        disposition: "question",
        reply: "Which endpoint do you mean?",
      },
    ]);
  });
});

describe("planSettlements thread binding", () => {
  it("follows threadId when a re-read feed rebound the aliases", () => {
    const plans = settle({
      threads: [
        thread({ threadId: "th-2", alias: "T1" }),
        thread({ threadId: "th-1", alias: "T2" }),
      ],
      accepted: [{ alias: "T1", threadId: "th-1", disposition: "actionable" }],
      headSha: "abc1234",
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]!.thread.threadId).toBe("th-1");
    expect(plans[0]!.body).toContain(MARKER_T1);
  });

  it("never posts into a third party thread", () => {
    expect(
      settle({
        threads: [thread({ threadId: "th-9", alias: "T1", source: "third_party" })],
        accepted: [{ alias: "T1", threadId: "th-9", disposition: "actionable" }],
        headSha: "abc1234",
      }),
    ).toEqual([]);
  });
});

describe("buildReviewLedgerGuardSummary", () => {
  const state = (overrides: Partial<ReviewLedgerState> = {}): ReviewLedgerState => ({
    feed: {
      threads: [
        thread({ threadId: "th-1", alias: "T1", filePath: "src/a.ts", line: 42 }),
        thread({ threadId: "th-2", alias: "T2" }),
        thread({ threadId: "th-3", alias: "T3", source: "third_party" }),
      ],
      truncated: 2,
      snapshotAt: "2026-08-21T10:05:00.000Z",
    },
    dispositions: [],
    verification: {
      accepted: [
        { alias: "T1", threadId: "th-1", disposition: "actionable" },
        {
          alias: "T2",
          threadId: "th-2",
          disposition: "question",
          reply: "Which endpoint do you mean?",
        },
      ],
      rejected: [],
    },
    researchDeclaresWrites: false,
    ...overrides,
  });

  it("refuses to summarize an unverified ledger", () => {
    expect(buildReviewLedgerGuardSummary(state({ verification: null }))).toBeNull();
  });

  it("reduces the ledger to the scalars the publish guard needs", () => {
    expect(buildReviewLedgerGuardSummary(state())).toEqual({
      workItems: [
        { alias: "T1", threadId: "th-1", filePath: "src/a.ts", line: 42 },
        { alias: "T2", threadId: "th-2" },
      ],
      acceptedAliases: ["T1", "T2"],
      actionableAliases: ["T1"],
      rejectedCount: 0,
      truncated: 2,
      declaredWrites: false,
    });
  });

  it("assumes the model wanted to write when the wiring did not say", () => {
    expect(
      buildReviewLedgerGuardSummary(state({ researchDeclaresWrites: undefined }))
        ?.declaredWrites,
    ).toBe(true);
  });
});
