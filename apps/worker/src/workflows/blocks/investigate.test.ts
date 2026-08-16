import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateStructured: vi.fn(),
  searchTicketSummaries: vi.fn(),
  searchSlackChannels: vi.fn(),
  /** The tenant configuration the block reads: the Jira project it may search
   *  and the Slack bot token. Mutable so a test can take either away. */
  env: {
    JIRA_PROJECT_KEY: "AWT" as string | undefined,
    CHAT_SDK_SLACK_TOKEN: "test-slack-token" as string | undefined,
  },
  /** Configured secrets the retrieval step redacts with. Fixed here so the test
   *  does not depend on the machine's environment. */
  secrets: [] as string[],
}));

vi.mock("../../db/client.js", () => ({ getDb: () => ({ kind: "db" }) }));
vi.mock("../../lib/llm.js", () => ({
  generateStructured: mocks.generateStructured,
}));
vi.mock("../../lib/adapters.js", () => ({
  createAdapters: () => ({
    issueTracker: { searchTicketSummaries: mocks.searchTicketSummaries },
  }),
}));
vi.mock("../../lib/slack-search.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/slack-search.js")>();
  // Only the network call is mocked; the failure classifier is the real one, so
  // the block's degradation reasons are the ones production would produce.
  return { ...actual, searchSlackChannels: mocks.searchSlackChannels };
});
vi.mock("../../../env.js", () => ({ env: mocks.env }));
vi.mock("../../run-observability/configured-secrets.js", () => ({
  configuredReplaySecrets: () => mocks.secrets,
}));

import {
  buildInvestigateJql,
  classifyJiraFailure,
  describeRetrievalGaps,
  execute,
  paramsSchema,
} from "./investigate.js";
import {
  expectOutputConformsToRegistry,
  makeCtx,
  makeNode,
  runControlErrorCases,
} from "./test-support.js";

const KEYWORDS_RESULT = {
  object: { keywords: ["login failure", "błąd logowania"] },
  text: "",
  usage: null,
};
const THEORY_RESULT = {
  object: {
    classification: "known_issue",
    theory: "Matches AWT-9.",
    evidenceRefs: ["jira:AWT-9"],
  },
  text: "",
  usage: null,
};
const JIRA_HITS = [
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
const SLACK_HITS = [
  {
    channel: "C1",
    ts: "1754000000.000100",
    text: "login is broken again",
    permalink: "https://slack.example/p/1",
    author: "U42",
  },
];

/** The normalized shapes the two providers above turn into. */
const JIRA_EVIDENCE = {
  ref: "jira:AWT-9",
  source: "jira",
  title: "AWT-9 Login button unresponsive",
  excerpt: "[In Progress] The login button does nothing on Safari.",
  author: "Ada Lovelace",
  origin: "AWT",
  timestamp: "2026-08-10T09:15:00.000Z",
  link: "https://jira.example.com/browse/AWT-9",
};
const SLACK_EVIDENCE = {
  ref: "slack:C1/1754000000.000100",
  source: "slack",
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
  mocks.searchTicketSummaries.mockResolvedValue(JIRA_HITS);
  mocks.searchSlackChannels.mockResolvedValue({
    matches: SLACK_HITS,
    skipped: [],
  });
}

describe("investigate paramsSchema", () => {
  it("accepts the full param set and rejects unknown keys", () => {
    const parsed = paramsSchema.safeParse({
      providers: ["jira"],
      slackChannels: ["C1"],
      slackLookbackDays: 14,
      jiraJqlTemplate: "project = ENG",
      maxResults: 5,
      model: "claude-haiku-4-5",
    });
    expect(parsed.success).toBe(true);
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(paramsSchema.safeParse({ maxResults: 0 }).success).toBe(false);
    expect(paramsSchema.safeParse({ slackLookbackDays: 0 }).success).toBe(false);
  });

  it("rejects a provider selection that is empty or names an unknown provider", () => {
    expect(paramsSchema.safeParse({ providers: [] }).success).toBe(false);
    expect(paramsSchema.safeParse({ providers: ["zendesk"] }).success).toBe(false);
    expect(paramsSchema.safeParse({ providers: "jira" }).success).toBe(false);
  });

  it("caps maxResults so one run cannot fan out arbitrarily", () => {
    expect(paramsSchema.safeParse({ maxResults: 10 }).success).toBe(true);
    expect(paramsSchema.safeParse({ maxResults: 11 }).success).toBe(false);
  });

  it("rejects a JQL template that could escape its project-scoped clause", () => {
    expect(
      paramsSchema.safeParse({
        jiraJqlTemplate: 'labels = support) OR (project = OTHER',
      }).success,
    ).toBe(false);
    expect(
      paramsSchema.safeParse({ jiraJqlTemplate: 'summary ~ "literal (value)"' }).success,
    ).toBe(true);
  });

  it("defaults only the provider selection, leaving the numbers to the executor", () => {
    const parsed = paramsSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.providers).toEqual(["jira", "slack"]);
      expect(parsed.data.slackLookbackDays).toBeUndefined();
      expect(parsed.data.maxResults).toBeUndefined();
    }
  });
});

describe("classifyJiraFailure", () => {
  it("separates a refused credential from an outage and a timeout", () => {
    expect(
      classifyJiraFailure(new Error("Jira API error: 403 Forbidden on /rest/api/3/search/jql")),
    ).toBe("permission");
    expect(
      classifyJiraFailure(new Error("Jira API error: 401 Unauthorized on /rest/api/3/search/jql")),
    ).toBe("permission");
    expect(
      classifyJiraFailure(new Error("Jira API error: 503 Service Unavailable on /x")),
    ).toBe("unavailable");
    expect(
      classifyJiraFailure(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
    ).toBe("timeout");
    expect(classifyJiraFailure(new TypeError("fetch failed"))).toBe("unavailable");
  });
});

describe("describeRetrievalGaps", () => {
  it("says nothing when everything configured was searched", () => {
    expect(describeRetrievalGaps([])).toBe("");
  });

  it("names each provider and channel with why it was not searched", () => {
    expect(
      describeRetrievalGaps([
        { provider: "jira", reason: "unavailable", scope: "" },
        { provider: "slack", reason: "permission", scope: "C_PRIV" },
        { provider: "slack", reason: "timeout", scope: "" },
      ]),
    ).toBe(
      "Not searched: Jira (unavailable); Slack channel C_PRIV (no access); Slack (timed out).",
    );
  });
});

describe("buildInvestigateJql", () => {
  it("scopes to the configured project and ORs the keyword clauses", () => {
    expect(buildInvestigateJql("AWT", ["login failure", "payment"])).toBe(
      '(project = "AWT") AND (text ~ "login failure" OR text ~ "payment")',
    );
  });

  it("keeps the project scope first when a template narrows the search", () => {
    expect(buildInvestigateJql("AWT", ["login"], "labels = support")).toBe(
      '(project = "AWT") AND (labels = support) AND (text ~ "login")',
    );
  });

  it("scopes the template alone when no keywords were extracted", () => {
    expect(buildInvestigateJql("AWT", [], "labels = support")).toBe(
      '(project = "AWT") AND (labels = support)',
    );
  });

  it("never produces an unscoped query, even with nothing else to add", () => {
    expect(buildInvestigateJql("AWT", [])).toBe('(project = "AWT")');
  });

  it("cannot be widened past the configured project by a template naming another", () => {
    // Both project clauses are ANDed, so this finds nothing rather than finding
    // OTHER's tickets: out of scope fails closed.
    const jql = buildInvestigateJql("AWT", ["login"], "project = OTHER OR project = AWT");
    expect(jql).toBe(
      '(project = "AWT") AND (project = OTHER OR project = AWT) AND (text ~ "login")',
    );
    expect(jql.startsWith('(project = "AWT") AND')).toBe(true);
  });

  it("drops an unbalanced template that tries to close the project scope", () => {
    expect(
      buildInvestigateJql(
        "AWT",
        ["login"],
        "labels = support) OR (project = OTHER",
      ),
    ).toBe('(project = "AWT") AND (text ~ "login")');
  });

  it("strips quotes and backslashes that would break out of a clause", () => {
    expect(buildInvestigateJql('AW"T', ['weird "quoted" \\keyword'])).toBe(
      '(project = "AW T") AND (text ~ "weird quoted keyword")',
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
    mocks.searchTicketSummaries.mockReset();
    mocks.searchSlackChannels.mockReset();
    mocks.env.CHAT_SDK_SLACK_TOKEN = "test-slack-token";
    mocks.env.JIRA_PROJECT_KEY = "AWT";
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
    expect(mocks.searchTicketSummaries).not.toHaveBeenCalled();
    expect(mocks.searchSlackChannels).not.toHaveBeenCalled();
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("runs keywords, retrieval and theory end to end", async () => {
    mockHappyPath();

    const result = await execute(
      makeNode("investigate", { slackChannels: ["C1"] }),
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

    expect(mocks.searchTicketSummaries).toHaveBeenCalledWith(
      '(project = "AWT") AND (text ~ "login failure" OR text ~ "błąd logowania")',
      10,
    );
    expect(mocks.searchSlackChannels).toHaveBeenCalledWith({
      token: "test-slack-token",
      channels: ["C1"],
      keywords: ["login failure", "błąd logowania"],
      lookbackDays: 30,
      maxResults: 10,
      now: expect.any(Date),
    });

    const theoryCall = mocks.generateStructured.mock.calls[1][0];
    expect(theoryCall.prompt).toContain("jira:AWT-9");
    expect(theoryCall.prompt).toContain("slack:C1/1754000000.000100");

    expect(result).toEqual({
      kind: "next",
      output: {
        status: "ok",
        classification: "known_issue",
        theory: "Matches AWT-9.",
        evidence: [JIRA_EVIDENCE, SLACK_EVIDENCE],
        partial: [],
        partialReasons: [],
      },
    });
    expectOutputConformsToRegistry("investigate", result.output!);
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
    mocks.searchSlackChannels.mockResolvedValue({ matches: [], skipped: [] });

    await execute(
      makeNode("investigate", { providers: ["slack"], slackChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    const keywordSchema = JSON.parse(mocks.generateStructured.mock.calls[0][0].schema);
    expect(keywordSchema.properties.keywords).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(keywordSchema.properties.keywords).not.toHaveProperty("maxItems");
    expect(mocks.searchSlackChannels).toHaveBeenCalledWith(
      expect.objectContaining({
        keywords: Array.from({ length: 10 }, (_, index) => `keyword-${index + 1}`),
      }),
    );
  });

  it("normalizes both providers onto the same evidence fields", async () => {
    mockHappyPath();

    const result = await execute(
      makeNode("investigate", { slackChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    // The point of normalization: one binding path works for either provider.
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
    mocks.searchTicketSummaries.mockResolvedValue([
      { ...JIRA_HITS[0]!, excerpt: "curl -H 'Authorization: s3cr3t-token' failed" },
    ]);
    mocks.searchSlackChannels.mockResolvedValue({ matches: [], skipped: [] });

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
    mocks.searchTicketSummaries.mockResolvedValue([
      { ...JIRA_HITS[0]!, status: "", excerpt: "y".repeat(900) },
    ]);
    mocks.searchSlackChannels.mockResolvedValue({ matches: [], skipped: [] });

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
        slackChannels: ["C1"],
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

  it("searches Jira only when the selection omits Slack", async () => {
    mockHappyPath();

    const result = await execute(
      makeNode("investigate", { providers: ["jira"], slackChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(mocks.searchTicketSummaries).toHaveBeenCalledTimes(1);
    expect(mocks.searchSlackChannels).not.toHaveBeenCalled();
    // A provider that was never asked is not a gap.
    expect(result.output!.partial).toEqual([]);
    expect(result.output!.partialReasons).toEqual([]);
    expect(result.output!.evidence).toEqual([JIRA_EVIDENCE]);
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("searches Slack only when the selection omits Jira", async () => {
    mockHappyPath();

    const result = await execute(
      makeNode("investigate", { providers: ["slack"], slackChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(mocks.searchTicketSummaries).not.toHaveBeenCalled();
    expect(mocks.searchSlackChannels).toHaveBeenCalledTimes(1);
    expect(result.output!.partial).toEqual([]);
    expect(result.output!.evidence).toEqual([SLACK_EVIDENCE]);
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
    mocks.searchTicketSummaries.mockResolvedValue([]);
    mocks.searchSlackChannels.mockResolvedValue({ matches: [], skipped: [] });

    const result = await execute(
      makeNode("investigate", { slackChannels: ["C1"] }),
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

  it("marks enabled Slack without configured channels as a permission gap", async () => {
    mockHappyPath();

    const result = await execute(makeNode("investigate"), {}, makeCtx());

    expect(mocks.searchSlackChannels).not.toHaveBeenCalled();
    expect(result.output!.partial).toEqual(["slack"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "slack", reason: "permission", scope: "" },
    ]);
    expect(result.output!.theory).toBe(
      "Matches AWT-9.\n\nNot searched: Slack (no access).",
    );
  });

  it("builds the JQL from the template when one is configured", async () => {
    mockHappyPath();

    await execute(
      makeNode("investigate", { jiraJqlTemplate: "labels = support" }),
      {},
      makeCtx(),
    );

    expect(mocks.searchTicketSummaries).toHaveBeenCalledWith(
      '(project = "AWT") AND (labels = support) AND (text ~ "login failure" OR text ~ "błąd logowania")',
      10,
    );
  });

  it("degrades to partial jira evidence when the tracker search fails, keeping the reason", async () => {
    mockHappyPath();
    mocks.searchTicketSummaries.mockReset();
    mocks.searchTicketSummaries.mockRejectedValue(
      new Error("Jira API error: 403 Forbidden on /rest/api/3/search/jql"),
    );

    const result = await execute(
      makeNode("investigate", { slackChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output!.partial).toEqual(["jira"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "jira", reason: "permission", scope: "" },
    ]);
    expect(result.output!.evidence).toEqual([SLACK_EVIDENCE]);
    expect(result.output!.classification).toBe("known_issue");
    expect(result.output!.theory).toBe(
      "Matches AWT-9.\n\nNot searched: Jira (no access).",
    );
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("tells a Jira outage apart from a Jira timeout", async () => {
    mockHappyPath();
    mocks.searchTicketSummaries.mockReset();
    mocks.searchTicketSummaries.mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "TimeoutError" }),
    );

    const result = await execute(
      makeNode("investigate", { providers: ["jira"] }),
      {},
      makeCtx(),
    );

    expect(result.output!.partialReasons).toEqual([
      { provider: "jira", reason: "timeout", scope: "" },
    ]);
  });

  it("degrades to partial slack evidence when the Slack search throws", async () => {
    mockHappyPath();
    mocks.searchSlackChannels.mockReset();
    mocks.searchSlackChannels.mockRejectedValue(new Error("slack down"));

    const result = await execute(
      makeNode("investigate", { slackChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(result.kind).toBe("next");
    expect(result.output!.partial).toEqual(["slack"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "slack", reason: "unavailable", scope: "" },
    ]);
    expect(result.output!.evidence).toEqual([JIRA_EVIDENCE]);
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("does not search Jira at all when the deployment has no configured project", async () => {
    mockHappyPath();
    mocks.env.JIRA_PROJECT_KEY = undefined;

    const result = await execute(
      makeNode("investigate", { slackChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    // Fail closed: no scope means no search, never a search across every project
    // the credential can reach.
    expect(mocks.searchTicketSummaries).not.toHaveBeenCalled();
    expect(result.output!.partial).toEqual(["jira"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "jira", reason: "permission", scope: "" },
    ]);
    expect(result.output!.evidence).toEqual([SLACK_EVIDENCE]);
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("treats a blank configured project the same as none", async () => {
    mockHappyPath();
    mocks.env.JIRA_PROJECT_KEY = "   ";

    const result = await execute(
      makeNode("investigate", { providers: ["jira"] }),
      {},
      makeCtx(),
    );

    expect(mocks.searchTicketSummaries).not.toHaveBeenCalled();
    expect(result.output!.partialReasons).toEqual([
      { provider: "jira", reason: "permission", scope: "" },
    ]);
  });

  it("keeps a template inside the configured project instead of letting it widen", async () => {
    mockHappyPath();

    await execute(
      makeNode("investigate", { jiraJqlTemplate: "project = OTHER" }),
      {},
      makeCtx(),
    );

    const [jql] = mocks.searchTicketSummaries.mock.calls[0];
    expect(jql).toBe(
      '(project = "AWT") AND (project = OTHER) AND (text ~ "login failure" OR text ~ "błąd logowania")',
    );
  });

  it("marks Slack a permission gap when no bot token is configured", async () => {
    mockHappyPath();
    mocks.env.CHAT_SDK_SLACK_TOKEN = undefined;

    const result = await execute(
      makeNode("investigate", { slackChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(mocks.searchSlackChannels).not.toHaveBeenCalled();
    expect(result.output!.partial).toEqual(["slack"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "slack", reason: "permission", scope: "" },
    ]);
  });

  it("reports a channel the bot cannot read as a per-channel gap, in the theory too", async () => {
    mockHappyPath();
    mocks.searchSlackChannels.mockReset();
    mocks.searchSlackChannels.mockResolvedValue({
      matches: SLACK_HITS,
      skipped: [{ channel: "C_PRIV", reason: "permission" }],
    });

    const result = await execute(
      makeNode("investigate", { slackChannels: ["C1", "C_PRIV"] }),
      {},
      makeCtx(),
    );

    expect(result.output!.theory).toBe(
      "Matches AWT-9.\n\nNot searched: Slack channel C_PRIV (no access).",
    );
    // The channel that did answer still contributed, but Slack is incomplete.
    expect(result.output!.evidence).toEqual([JIRA_EVIDENCE, SLACK_EVIDENCE]);
    expect(result.output!.partial).toEqual(["slack"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "slack", reason: "permission", scope: "C_PRIV" },
    ]);
    expectOutputConformsToRegistry("investigate", result.output!);
  });

  it("propagates a Slack permalink failure as a partial channel gap", async () => {
    mockHappyPath();
    mocks.searchSlackChannels.mockReset();
    mocks.searchSlackChannels.mockResolvedValue({
      matches: [],
      skipped: [{ channel: "C1", reason: "unavailable" }],
    });

    const result = await execute(
      makeNode("investigate", { slackChannels: ["C1"] }),
      {},
      makeCtx(),
    );

    expect(result.output!.evidence).toEqual([JIRA_EVIDENCE]);
    expect(result.output!.partial).toEqual(["slack"]);
    expect(result.output!.partialReasons).toEqual([
      { provider: "slack", reason: "unavailable", scope: "C1" },
    ]);
    expect(result.output!.theory).toBe(
      "Matches AWT-9.\n\nNot searched: Slack channel C1 (unavailable).",
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
    expect(mocks.searchTicketSummaries).not.toHaveBeenCalled();
    expect(mocks.searchSlackChannels).not.toHaveBeenCalled();
  });

  it("fails the block when the theory call fails", async () => {
    mocks.generateStructured
      .mockResolvedValueOnce(KEYWORDS_RESULT)
      .mockRejectedValueOnce(new Error("llm down"));
    mocks.searchTicketSummaries.mockResolvedValue(JIRA_HITS);

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
    mocks.searchTicketSummaries.mockResolvedValue(JIRA_HITS);

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
