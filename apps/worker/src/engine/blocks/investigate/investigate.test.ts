import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateStructured: vi.fn(),
  findTickets: vi.fn(),
  searchMessages: vi.fn(),
  /** Configured secrets the retrieval step redacts with. Fixed here so the test
   *  does not depend on the machine's environment. */
  secrets: [] as string[],
}));

vi.mock("../../../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../../llm.js", () => ({
  generateStructured: mocks.generateStructured,
}));
vi.mock("../../../engine/support/adapters.js", () => ({
  createAdapters: () => ({
    issueTracker: { findTickets: mocks.findTickets },
    messaging: { searchMessages: mocks.searchMessages },
  }),
}));
vi.mock("../../../run-observability/configured-secrets.js", () => ({
  configuredReplaySecrets: () => mocks.secrets,
}));

import {
  classifyTrackerFailure,
  describeRetrievalGaps,
  execute,
} from "./execute.js";
import { manifest } from "./manifest.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  makeNode,
  runControlErrorCases,
} from "../support/test-support.js";

const KEYWORDS_RESULT = {
  object: { keywords: ["login failure", "błąd logowania"] },
  text: "",
  usage: null,
};
const THEORY_RESULT = {
  object: {
    classification: "known_issue",
    theory: "Matches AWT-9.",
    evidenceRefs: ["issue_tracker:AWT-9"],
  },
  text: "",
  usage: null,
};
const TRACKER_HITS = [
  {
    key: "AWT-9",
    summary: "Login button unresponsive",
    status: "In Progress",
    url: "https://jira.example.com/browse/AWT-9",
    excerpt: "The login button does nothing on Safari.",
    reporter: "Ada Lovelace",
    project: "AWT",
    updatedAt: "2026-08-10T09:15:00.000Z",
  },
];
const CHAT_HITS = [
  {
    channel: "C1",
    id: "1754000000.000100",
    text: "login is broken again",
    url: "https://slack.example/p/1",
    author: "U42",
    postedAt: "2025-07-31T22:13:20.000Z",
  },
];

/** The normalized shapes the two sources above turn into. */
const TRACKER_EVIDENCE = {
  ref: "issue_tracker:AWT-9",
  source: "issue_tracker",
  title: "AWT-9 Login button unresponsive",
  excerpt: "[In Progress] The login button does nothing on Safari.",
  author: "Ada Lovelace",
  origin: "AWT",
  timestamp: "2026-08-10T09:15:00.000Z",
  link: "https://jira.example.com/browse/AWT-9",
};
const CHAT_EVIDENCE = {
  ref: "chat:C1/1754000000.000100",
  source: "chat",
  title: "login is broken again",
  excerpt: "login is broken again",
  author: "U42",
  origin: "C1",
  timestamp: "2025-07-31T22:13:20.000Z",
  link: "https://slack.example/p/1",
};

function mockHappyPath() {
  mocks.generateStructured
    .mockResolvedValueOnce(KEYWORDS_RESULT)
    .mockResolvedValueOnce(THEORY_RESULT);
  mocks.findTickets.mockResolvedValue(TRACKER_HITS);
  mocks.searchMessages.mockResolvedValue({
    ok: true,
    matches: CHAT_HITS,
    skipped: [],
  });
}

describe("investigate paramsSchema", () => {
  it("accepts the full param set and rejects unknown keys", () => {
    const parsed = manifest.paramsSchema.safeParse({
      sources: ["issue_tracker"],
      chatChannels: ["C1"],
      chatLookbackDays: 14,
      issueTrackerQueryTemplate: "project = ENG",
      maxResults: 5,
      model: "claude-haiku-4-5",
    });
    expect(parsed.success).toBe(true);
    expect(manifest.paramsSchema.safeParse({}).success).toBe(true);
    expect(manifest.paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(manifest.paramsSchema.safeParse({ maxResults: 0 }).success).toBe(false);
    expect(manifest.paramsSchema.safeParse({ chatLookbackDays: 0 }).success).toBe(false);
  });

  it("rejects a source selection that is empty or names an unknown source", () => {
    expect(manifest.paramsSchema.safeParse({ sources: [] }).success).toBe(false);
    expect(manifest.paramsSchema.safeParse({ sources: ["zendesk"] }).success).toBe(false);
    expect(manifest.paramsSchema.safeParse({ sources: "issue_tracker" }).success).toBe(false);
  });

  it("caps maxResults so one run cannot fan out arbitrarily", () => {
    expect(manifest.paramsSchema.safeParse({ maxResults: 10 }).success).toBe(true);
    expect(manifest.paramsSchema.safeParse({ maxResults: 11 }).success).toBe(false);
  });

  it("rejects a query template that could escape its scoped clause", () => {
    expect(
      manifest.paramsSchema.safeParse({
        issueTrackerQueryTemplate: 'labels = support) OR (project = OTHER',
      }).success,
    ).toBe(false);
    expect(
      manifest.paramsSchema.safeParse({
        issueTrackerQueryTemplate: 'summary ~ "literal (value)"',
      }).success,
    ).toBe(true);
  });

  it("defaults only the source selection, leaving the numbers to the executor", () => {
    const parsed = manifest.paramsSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sources).toEqual(["issue_tracker", "chat"]);
      expect(parsed.data.chatLookbackDays).toBeUndefined();
      expect(parsed.data.maxResults).toBeUndefined();
    }
  });
});

describe("classifyTrackerFailure", () => {
  it("separates a refused credential from an outage and a timeout", () => {
    expect(
      classifyTrackerFailure(new Error("Jira API error: 403 Forbidden on /rest/api/3/search/jql")),
    ).toBe("permission");
    expect(
      classifyTrackerFailure(new Error("Jira API error: 401 Unauthorized on /rest/api/3/search/jql")),
    ).toBe("permission");
    expect(
      classifyTrackerFailure(new Error("Jira API error: 503 Service Unavailable on /x")),
    ).toBe("unavailable");
    expect(
      classifyTrackerFailure(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
    ).toBe("timeout");
    expect(classifyTrackerFailure(new TypeError("fetch failed"))).toBe("unavailable");
  });
});

describe("describeRetrievalGaps", () => {
  it("says nothing when everything configured was searched", () => {
    expect(describeRetrievalGaps([])).toBe("");
  });

  it("names each source and channel with why it was not searched", () => {
    expect(
      describeRetrievalGaps([
        { provider: "issue_tracker", reason: "unavailable", scope: "" },
        { provider: "chat", reason: "permission", scope: "C_PRIV" },
        { provider: "chat", reason: "timeout", scope: "" },
      ]),
    ).toBe(
      "Not searched: the issue tracker (unavailable); chat channel C_PRIV (no access); chat (timed out).",
    );
  });
});

describe("investigate execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset, not clear: clearAllMocks leaves queued mockResolvedValueOnce values
    // behind, so a test that stops before the theory call would hand its unused
    // answer to the next test's keyword call.
    mocks.generateStructured.mockReset();
    mocks.findTickets.mockReset();
    mocks.searchMessages.mockReset();
    mocks.secrets = [];
  });

  it("short-circuits a ticket without summary and description with zero LLM and retrieval calls", async () => {
    const ctx = makeCtx({
      ticket: {
        id: "1",
        identifier: "AWT-1",
        title: "  ",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        labels: [],
        trackerStatus: "AI",
        attachments: [],
      },
    });

    const result = await execute(makeNode("investigate"), {}, ctx);

    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        classification: "insufficient_data",
        theory:
          "Ticket has neither a summary nor a description; there is nothing to investigate.",
        evidence: [],
        partial: [],
        partialReasons: [],
      },
    });
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(mocks.findTickets).not.toHaveBeenCalled();
    expect(mocks.searchMessages).not.toHaveBeenCalled();
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("runs keywords, retrieval and theory end to end", async () => {
    mockHappyPath();

    const result = await execute(
      makeNode("investigate", { chatChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(mocks.generateStructured).toHaveBeenCalledTimes(2);

    const keywordsCall = mocks.generateStructured.mock.calls[0][0];
    expect(keywordsCall).toMatchObject({
      model: "claude-haiku-4-5",
      provider: "claude",
    });
    expect(keywordsCall.prompt).toContain("Ticket title");
    expect(keywordsCall.prompt).toContain("Ticket description");
    expect(keywordsCall.prompt).toMatch(/English/);
    expect(keywordsCall.prompt).toMatch(/ticket's (own )?language/i);

    expect(mocks.findTickets).toHaveBeenCalledWith({
      keywords: ["login failure", "błąd logowania"],
      limit: 10,
    });
    expect(mocks.searchMessages).toHaveBeenCalledWith({
      channels: ["C1"],
      keywords: ["login failure", "błąd logowania"],
      lookbackDays: 30,
      maxResults: 10,
    });

    const theoryCall = mocks.generateStructured.mock.calls[1][0];
    expect(theoryCall.prompt).toContain("issue_tracker:AWT-9");
    expect(theoryCall.prompt).toContain("chat:C1/1754000000.000100");

    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        classification: "known_issue",
        theory: "Matches AWT-9.",
        evidence: [TRACKER_EVIDENCE, CHAT_EVIDENCE],
        partial: [],
        partialReasons: [],
      },
    });
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("passes the author's template through as providerQuery, without composing a query of its own", async () => {
    mockHappyPath();

    await execute(
      makeNode("investigate", { issueTrackerQueryTemplate: "labels = support" }),
      {},
      makeCtx(),
    );

    expect(mocks.findTickets).toHaveBeenCalledWith({
      keywords: ["login failure", "błąd logowania"],
      limit: 10,
      providerQuery: "labels = support",
    });
  });

  it("omits maxItems from the keyword schema and caps normalized keywords at runtime", async () => {
    const keywords = [
      "  keyword-1  ",
      "",
      "   ",
      ...Array.from({ length: 11 }, (_, index) => `keyword-${index + 2}`),
    ];
    mocks.generateStructured
      .mockResolvedValueOnce({ object: { keywords }, text: "", usage: null })
      .mockResolvedValueOnce(THEORY_RESULT);
    mocks.searchMessages.mockResolvedValue({ ok: true, matches: [], skipped: [] });

    await execute(
      makeNode("investigate", { sources: ["chat"], chatChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    const keywordSchema = JSON.parse(mocks.generateStructured.mock.calls[0][0].schema);
    expect(keywordSchema.properties.keywords).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(keywordSchema.properties.keywords).not.toHaveProperty("maxItems");
    expect(mocks.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        keywords: Array.from({ length: 10 }, (_, index) => `keyword-${index + 1}`),
      }),
    );
  });

  it("normalizes both sources onto the same evidence fields", async () => {
    mockHappyPath();

    const result = await execute(
      makeNode("investigate", { chatChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    // The point of normalization: one binding path works for either source.
    for (const item of result.output!.evidence as Record<string, unknown>[]) {
      expect(Object.keys(item).sort()).toEqual([
        "author",
        "excerpt",
        "link",
        "origin",
        "ref",
        "source",
        "timestamp",
        "title",
      ]);
      expect(String(item.link)).toMatch(/^https:\/\//);
    }
  });

  it("redacts configured secrets before evidence reaches the prompt or the output", async () => {
    mocks.secrets = ["s3cr3t-token"];
    mocks.generateStructured
      .mockResolvedValueOnce(KEYWORDS_RESULT)
      .mockResolvedValueOnce(THEORY_RESULT);
    mocks.findTickets.mockResolvedValue([
      { ...TRACKER_HITS[0]!, excerpt: "curl -H 'Authorization: s3cr3t-token' failed" },
    ]);
    mocks.searchMessages.mockResolvedValue({ ok: true, matches: [], skipped: [] });

    const result = await execute(makeNode("investigate"), {}, makeCtx());

    const excerpt = String(
      (result.output!.evidence as Record<string, unknown>[])[0]!.excerpt,
    );
    expect(excerpt).not.toContain("s3cr3t-token");
    expect(mocks.generateStructured.mock.calls[1][0].prompt).not.toContain(
      "s3cr3t-token",
    );
  });

  it("truncates a long excerpt instead of putting a whole body in the prompt", async () => {
    mocks.generateStructured
      .mockResolvedValueOnce(KEYWORDS_RESULT)
      .mockResolvedValueOnce(THEORY_RESULT);
    mocks.findTickets.mockResolvedValue([
      { ...TRACKER_HITS[0]!, status: "", excerpt: "y".repeat(900) },
    ]);
    mocks.searchMessages.mockResolvedValue({ ok: true, matches: [], skipped: [] });

    const result = await execute(makeNode("investigate"), {}, makeCtx());

    const excerpt = String(
      (result.output!.evidence as Record<string, unknown>[])[0]!.excerpt,
    );
    expect(excerpt).toHaveLength(501);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("honours an explicit model param for both LLM calls", async () => {
    mockHappyPath();

    await execute(
      makeNode("investigate", {
        chatChannels: ["C1"],
        model: "claude-sonnet-4-5",
      }),
      {},
      makeCtx(),
    );

    for (const call of mocks.generateStructured.mock.calls) {
      expect(call[0]).toMatchObject({ model: "claude-sonnet-4-5" });
      expect(call[0].provider).toBeUndefined();
    }
  });

  it("searches the issue tracker only when the selection omits chat", async () => {
    mockHappyPath();

    const result = await execute(
      makeNode("investigate", { sources: ["issue_tracker"], chatChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(mocks.findTickets).toHaveBeenCalledTimes(1);
    expect(mocks.searchMessages).not.toHaveBeenCalled();
    // A source that was never asked is not a gap.
    expect(result.output!.partial).toEqual([]);
    expect(result.output!.partialReasons).toEqual([]);
    expect(result.output!.evidence).toEqual([TRACKER_EVIDENCE]);
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("searches chat only when the selection omits the issue tracker", async () => {
    mockHappyPath();

    const result = await execute(
      makeNode("investigate", { sources: ["chat"], chatChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(mocks.findTickets).not.toHaveBeenCalled();
    expect(mocks.searchMessages).toHaveBeenCalledTimes(1);
    expect(result.output!.partial).toEqual([]);
    expect(result.output!.evidence).toEqual([CHAT_EVIDENCE]);
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("reports an empty search as a clean no-results outcome, not a failure", async () => {
    mocks.generateStructured
      .mockResolvedValueOnce(KEYWORDS_RESULT)
      .mockResolvedValueOnce({
        object: {
          classification: "insufficient_data",
          theory: "Nothing similar exists.",
          evidenceRefs: [],
        },
        text: "",
        usage: null,
      });
    mocks.findTickets.mockResolvedValue([]);
    mocks.searchMessages.mockResolvedValue({ ok: true, matches: [], skipped: [] });

    const result = await execute(
      makeNode("investigate", { chatChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output).toEqual({
      status: "ok",
      classification: "insufficient_data",
      theory: "Nothing similar exists.",
      evidence: [],
      partial: [],
      partialReasons: [],
    });
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("marks enabled chat without configured channels as a permission gap", async () => {
    mockHappyPath();

    const result = await execute(makeNode("investigate"), {}, makeCtx());

    expect(mocks.searchMessages).not.toHaveBeenCalled();
    expect(result.output!.partial).toEqual(["chat"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "chat", reason: "permission", scope: "" },
    ]);
    expect(result.output!.theory).toBe(
      "Matches AWT-9.\n\nNot searched: chat (no access).",
    );
  });

  it("degrades to partial tracker evidence when the tracker search fails, keeping the reason", async () => {
    mockHappyPath();
    mocks.findTickets.mockReset();
    mocks.findTickets.mockRejectedValue(
      new Error("Jira API error: 403 Forbidden on /rest/api/3/search/jql"),
    );

    const result = await execute(
      makeNode("investigate", { chatChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output!.partial).toEqual(["issue_tracker"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "issue_tracker", reason: "permission", scope: "" },
    ]);
    expect(result.output!.evidence).toEqual([CHAT_EVIDENCE]);
    expect(result.output!.classification).toBe("known_issue");
    expect(result.output!.theory).toBe(
      "Matches AWT-9.\n\nNot searched: the issue tracker (no access).",
    );
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("tells a tracker outage apart from a tracker timeout", async () => {
    mockHappyPath();
    mocks.findTickets.mockReset();
    mocks.findTickets.mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "TimeoutError" }),
    );

    const result = await execute(
      makeNode("investigate", { sources: ["issue_tracker"] }),
      {},
      makeCtx(),
    );

    expect(result.output!.partialReasons).toEqual([
      { provider: "issue_tracker", reason: "timeout", scope: "" },
    ]);
  });

  it("degrades to partial chat evidence when the chat search throws", async () => {
    mockHappyPath();
    mocks.searchMessages.mockReset();
    mocks.searchMessages.mockRejectedValue(new Error("chat down"));

    const result = await execute(
      makeNode("investigate", { chatChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output!.partial).toEqual(["chat"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "chat", reason: "unavailable", scope: "" },
    ]);
    expect(result.output!.evidence).toEqual([TRACKER_EVIDENCE]);
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("falls back to the pre-rename provider selection and param names for a recorded plan replaying the old words", async () => {
    mockHappyPath();

    const result = await execute(
      makeNode("investigate", {
        providers: ["jira"],
        slackChannels: ["C1"],
      }),
      {},
      makeCtx(),
    );

    expect(mocks.findTickets).toHaveBeenCalledTimes(1);
    expect(mocks.searchMessages).not.toHaveBeenCalled();
    expect(result.output!.evidence).toEqual([TRACKER_EVIDENCE]);
  });

  it("enables both sources for a recorded plan carrying the old provider words with no selection narrowed", async () => {
    mockHappyPath();

    const result = await execute(
      makeNode("investigate", { providers: ["jira", "slack"], slackChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(mocks.findTickets).toHaveBeenCalledTimes(1);
    expect(mocks.searchMessages).toHaveBeenCalledTimes(1);
    expect(result.output!.evidence).toEqual([TRACKER_EVIDENCE, CHAT_EVIDENCE]);
  });

  it("says no provider is connected rather than blaming the channel's permissions", async () => {
    // A deployment with no messaging provider is not a deployment whose bot was
    // refused a channel. Reporting "no access" here sent an admin to check
    // Slack scopes for a workspace nobody had connected.
    mockHappyPath();
    mocks.searchMessages.mockReset();
    mocks.searchMessages.mockResolvedValue({ ok: false, reason: "not_connected" });

    const result = await execute(
      makeNode("investigate", { chatChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(mocks.searchMessages).toHaveBeenCalled();
    expect(result.output!.partial).toEqual(["chat"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "chat", reason: "not_connected", scope: "" },
    ]);
    // What the person approving the theory actually reads.
    expect(result.output!.theory).toContain(
      "Not searched: chat (no messaging provider is connected).",
    );
  });

  it("reports a channel the bot cannot read as a per-channel gap, in the theory too", async () => {
    mockHappyPath();
    mocks.searchMessages.mockReset();
    mocks.searchMessages.mockResolvedValue({
      ok: true,
      matches: CHAT_HITS,
      skipped: [{ channel: "C_PRIV", reason: "permission" }],
    });

    const result = await execute(
      makeNode("investigate", { chatChannels: ["C1", "C_PRIV"] }),
      {},
      makeCtx(),
    );

    expect(result.output!.theory).toBe(
      "Matches AWT-9.\n\nNot searched: chat channel C_PRIV (no access).",
    );
    // The channel that did answer still contributed, but chat is incomplete.
    expect(result.output!.evidence).toEqual([TRACKER_EVIDENCE, CHAT_EVIDENCE]);
    expect(result.output!.partial).toEqual(["chat"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "chat", reason: "permission", scope: "C_PRIV" },
    ]);
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("propagates a chat permalink failure as a partial channel gap", async () => {
    mockHappyPath();
    mocks.searchMessages.mockReset();
    mocks.searchMessages.mockResolvedValue({
      ok: true,
      matches: [],
      skipped: [{ channel: "C1", reason: "unavailable" }],
    });

    const result = await execute(
      makeNode("investigate", { chatChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(result.output!.evidence).toEqual([TRACKER_EVIDENCE]);
    expect(result.output!.partial).toEqual(["chat"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "chat", reason: "unavailable", scope: "C1" },
    ]);
    expect(result.output!.theory).toBe(
      "Matches AWT-9.\n\nNot searched: chat channel C1 (unavailable).",
    );
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("fails the block when the keywords call fails, without touching retrieval", async () => {
    mocks.generateStructured.mockRejectedValue(new Error("llm down"));

    const result = await execute(makeNode("investigate"), {}, makeCtx());

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toBe("llm down");
    }
    expect(mocks.findTickets).not.toHaveBeenCalled();
    expect(mocks.searchMessages).not.toHaveBeenCalled();
  });

  it("fails the block when the theory call fails", async () => {
    mocks.generateStructured
      .mockResolvedValueOnce(KEYWORDS_RESULT)
      .mockRejectedValueOnce(new Error("llm down"));
    mocks.findTickets.mockResolvedValue(TRACKER_HITS);

    const result = await execute(makeNode("investigate"), {}, makeCtx());

    expect(result.kind).toBe("execution_error");
    if (result.kind === "execution_error") {
      expect(result.error.detail).toBe("llm down");
    }
  });

  it("fails the block when the theory output does not match the schema", async () => {
    mocks.generateStructured
      .mockResolvedValueOnce(KEYWORDS_RESULT)
      .mockResolvedValueOnce({ object: { nope: true }, text: "", usage: null });
    mocks.findTickets.mockResolvedValue(TRACKER_HITS);

    const result = await execute(makeNode("investigate"), {}, makeCtx());

    expect(result.kind).toBe("execution_error");
  });

  it.each(runControlErrorCases())(
    "rethrows %s instead of mapping it to a block failure",
    async (_label, controlError) => {
      mocks.generateStructured.mockRejectedValue(controlError);

      await expect(execute(makeNode("investigate"), {}, makeCtx())).rejects.toBe(
        controlError,
      );
    },
  );
});
