import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubAdapter } from "./github.js";
import { GitLabAdapter } from "./gitlab.js";
import type { ReviewThreadFeed, ReviewThreadSource, VCSAdapter } from "./types.js";
import {
  REVIEW_LEDGER_MAX_WORK_ITEMS,
  REVIEW_LEDGER_MAX_CONTEXT_THREADS,
} from "./types.js";
import { reviewLedgerMarker } from "../../lib/vcs-bot-identity.js";

vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * One scenario, described once, rendered into each provider's own payload shape
 * and asserted with one set of expectations.
 *
 * The point is the seam, not the coverage. `listReviewThreads` is the only way
 * review feedback reaches the agent, and each adapter builds its feed from a
 * different provider object: GitHub reads a `reviewThreads` connection whose
 * nodes carry `isResolved`, GitLab reads discussions and takes `resolved` off
 * the first note. Two implementations of one contract drift silently, because
 * each adapter's own test file only ever proves that adapter against itself.
 *
 * What is NOT asserted here is as deliberate as what is. `resolvable` is
 * provider-shaped on purpose: GitLab reports every discussion as resolvable
 * because posting the ledger's reply is what turns an `individual_note` into a
 * resolvable thread (`gitlab.ts` at `listReviewThreads`), while GitHub can only
 * resolve line-anchored threads. Asserting equality there would pin a bug into
 * place rather than catch one.
 */

const BOT = "aiw-bot";
const PR = 7;

interface NoteSpec {
  author: string;
  body: string;
  at: string; // ISO 8601
  providerBot?: boolean; // the provider's own flag for a bot account
}

interface ThreadSpec {
  key: string;
  file: string;
  line: number;
  resolved?: boolean;
  notes: NoteSpec[];
}

interface ExpectedThread {
  key: string;
  alias: string;
  source: ReviewThreadSource;
  awaitingHuman: boolean;
}

interface Expectation {
  threads: ExpectedThread[];
  truncated: number;
  contextTruncated: number;
}

const ledgerReply = (key: string, text: string) => `${reviewLedgerMarker(key)}\n\n${text}`;

// --- provider renderers -----------------------------------------------------
// Both take the same ThreadSpec list. A scenario that cannot be expressed for
// one provider is itself the finding, so neither renderer takes an escape hatch.

const githubThreadId = (key: string) => `PRRT_${key}`;
const gitlabThreadId = (key: string) => `disc-${key}`;

function renderGitHub(threads: ThreadSpec[]) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: threads.map((thread) => ({
            id: githubThreadId(thread.key),
            isResolved: thread.resolved === true,
            path: thread.file,
            line: thread.line,
            comments: {
              nodes: thread.notes.map((note, index) => ({
                id: `${thread.key}-c${index}`,
                databaseId: index + 1,
                body: note.body,
                createdAt: note.at,
                isMinimized: false,
                viewerDidAuthor: note.author === BOT,
                author: {
                  login: note.author,
                  __typename: note.providerBot === true ? "Bot" : "User",
                },
              })),
            },
          })),
        },
      },
    },
  };
}

function renderGitLab(threads: ThreadSpec[]) {
  return threads.map((thread) => ({
    id: gitlabThreadId(thread.key),
    notes: thread.notes.map((note, index) => ({
      id: `${thread.key}-n${index}`,
      body: note.body,
      created_at: note.at,
      system: false,
      // GitLab carries the flag on the notes; the adapter reads the first one.
      resolved: index === 0 ? thread.resolved === true : false,
      author: { username: note.author, bot: note.providerBot === true },
      ...(index === 0
        ? { position: { new_path: thread.file, new_line: thread.line } }
        : {}),
    })),
  }));
}

// --- provider harnesses -----------------------------------------------------

const mockOctokit = {
  graphql: vi.fn(),
  paginate: vi.fn(),
  issues: { listComments: vi.fn() },
  pulls: { listReviews: vi.fn(), listCommentsForReview: vi.fn() },
};

vi.mock("../../lib/github-auth.js", () => ({
  buildOctokit: vi.fn(() => mockOctokit),
}));

const mockDiscussions = { all: vi.fn() };

vi.mock("@gitbeaker/rest", () => ({
  Gitlab: vi.fn(() => ({ MergeRequestDiscussions: mockDiscussions })),
}));

const mockFetch = vi.fn();

interface Provider {
  name: string;
  threadId(key: string): string;
  load(threads: ThreadSpec[]): VCSAdapter;
}

const providers: Provider[] = [
  {
    name: "github",
    threadId: githubThreadId,
    load(threads) {
      const page = renderGitHub(threads);
      mockOctokit.graphql.mockImplementation((query: string) =>
        Promise.resolve(
          query.includes("ledgerReviewThreads") ? page : { viewer: { login: BOT } },
        ),
      );
      // No issue comments and no reviews: the general-comment path contributes
      // nothing, so the scenario observes the line-anchored threads alone.
      mockOctokit.paginate.mockResolvedValue([]);
      return new GitHubAdapter({
        auth: { appId: 1, privateKeyBase64: "a2V5", installationId: 2 },
        owner: "test-org",
        repo: "test-repo",
        baseBranch: "main",
      }) as unknown as VCSAdapter;
    },
  },
  {
    name: "gitlab",
    threadId: gitlabThreadId,
    load(threads) {
      mockDiscussions.all.mockResolvedValue(renderGitLab(threads));
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: vi.fn().mockResolvedValue({ username: BOT }),
        text: vi.fn().mockResolvedValue(JSON.stringify({ username: BOT })),
      });
      vi.stubGlobal("fetch", mockFetch);
      return new GitLabAdapter({
        token: "glpat-xxxxxxxxxxxx",
        projectId: "blazity/demo-app",
        baseBranch: "main",
      }) as unknown as VCSAdapter;
    },
  },
];

function assertFeed(provider: Provider, feed: ReviewThreadFeed, expected: Expectation) {
  expect(
    feed.threads.map((thread) => thread.threadId),
    `${provider.name}: wrong threads, or wrong order`,
  ).toEqual(expected.threads.map((thread) => provider.threadId(thread.key)));
  expect(feed.threads.map((thread) => thread.alias)).toEqual(
    expected.threads.map((thread) => thread.alias),
  );
  expect(
    feed.threads.map((thread) => thread.source),
    `${provider.name}: author classification differs`,
  ).toEqual(expected.threads.map((thread) => thread.source));
  expect(
    feed.threads.map((thread) => thread.awaitingHuman),
    `${provider.name}: wrong idea of who holds the ball`,
  ).toEqual(expected.threads.map((thread) => thread.awaitingHuman));
  expect(feed.truncated, `${provider.name}: dropped work items miscounted`).toBe(
    expected.truncated,
  );
  expect(
    feed.contextTruncated,
    `${provider.name}: dropped context threads miscounted`,
  ).toBe(expected.contextTruncated);
}

function conformance(name: string, threads: ThreadSpec[], expected: Expectation) {
  describe(name, () => {
    for (const provider of providers) {
      it(`${provider.name} agrees`, async () => {
        const adapter = provider.load(threads);
        assertFeed(provider, await adapter.listReviewThreads(PR), expected);
      });
    }
  });
}

// --- scenarios --------------------------------------------------------------

const human = (at: string, body = "please fix this"): NoteSpec => ({
  author: "reviewer",
  body,
  at,
});

describe("review thread feed, one contract across providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOctokit.graphql.mockReset();
    mockOctokit.paginate.mockReset();
    mockDiscussions.all.mockReset();
    mockFetch.mockReset();
  });

  conformance(
    "a resolved thread is settled business and never reaches the agent",
    [
      { key: "a", file: "src/a.ts", line: 10, resolved: true, notes: [human("2026-01-01T00:00:00Z")] },
      { key: "b", file: "src/b.ts", line: 20, notes: [human("2026-01-02T00:00:00Z")] },
    ],
    {
      threads: [{ key: "b", alias: "T1", source: "human", awaitingHuman: false }],
      truncated: 0,
      contextTruncated: 0,
    },
  );

  conformance(
    "threads are ordered oldest first and aliased without gaps",
    [
      { key: "mid", file: "src/b.ts", line: 2, notes: [human("2026-01-02T00:00:00Z")] },
      { key: "new", file: "src/c.ts", line: 3, notes: [human("2026-01-03T00:00:00Z")] },
      { key: "old", file: "src/a.ts", line: 1, notes: [human("2026-01-01T00:00:00Z")] },
    ],
    {
      threads: [
        { key: "old", alias: "T1", source: "human", awaitingHuman: false },
        { key: "mid", alias: "T2", source: "human", awaitingHuman: false },
        { key: "new", alias: "T3", source: "human", awaitingHuman: false },
      ],
      truncated: 0,
      contextTruncated: 0,
    },
  );

  conformance(
    "a thread our reply parked drops behind the work items, however old it is",
    [
      {
        key: "parked",
        file: "src/a.ts",
        line: 1,
        notes: [human("2026-01-01T00:00:00Z"), { author: BOT, body: ledgerReply("parked", "done"), at: "2026-01-01T01:00:00Z" }],
      },
      { key: "open", file: "src/b.ts", line: 2, notes: [human("2026-01-05T00:00:00Z")] },
    ],
    {
      threads: [
        { key: "open", alias: "T1", source: "human", awaitingHuman: false },
        { key: "parked", alias: "T2", source: "human", awaitingHuman: true },
      ],
      truncated: 0,
      contextTruncated: 0,
    },
  );

  conformance(
    "a reviewer answering our reply takes the thread back as work",
    [
      {
        key: "reopened",
        file: "src/a.ts",
        line: 1,
        notes: [
          human("2026-01-01T00:00:00Z"),
          { author: BOT, body: ledgerReply("reopened", "done"), at: "2026-01-01T01:00:00Z" },
          human("2026-01-01T02:00:00Z", "no, still wrong"),
        ],
      },
    ],
    {
      threads: [{ key: "reopened", alias: "T1", source: "human", awaitingHuman: false }],
      truncated: 0,
      contextTruncated: 0,
    },
  );

  conformance(
    "a third-party reviewer bot is background, never a work item",
    [
      {
        key: "rabbit",
        file: "src/a.ts",
        line: 1,
        notes: [{ author: "coderabbitai", body: "nit: rename this", at: "2026-01-01T00:00:00Z", providerBot: true }],
      },
      { key: "person", file: "src/b.ts", line: 2, notes: [human("2026-01-02T00:00:00Z")] },
    ],
    {
      threads: [
        { key: "person", alias: "T1", source: "human", awaitingHuman: false },
        { key: "rabbit", alias: "T2", source: "third_party", awaitingHuman: false },
      ],
      truncated: 0,
      contextTruncated: 0,
    },
  );

  const overCap: ThreadSpec[] = Array.from(
    { length: REVIEW_LEDGER_MAX_WORK_ITEMS + 2 },
    (_, index) => ({
      key: `w${String(index).padStart(2, "0")}`,
      file: `src/f${index}.ts`,
      line: index + 1,
      notes: [human(`2026-01-01T00:${String(index).padStart(2, "0")}:00Z`)],
    }),
  );

  conformance(
    "work items past the cap are counted, not silently dropped",
    overCap,
    {
      threads: overCap.slice(0, REVIEW_LEDGER_MAX_WORK_ITEMS).map((thread, index) => ({
        key: thread.key,
        alias: `T${index + 1}`,
        source: "human" as const,
        awaitingHuman: false,
      })),
      truncated: 2,
      contextTruncated: 0,
    },
  );

  describe("notes reach the agent whole", () => {
    const threads: ThreadSpec[] = [
      {
        key: "only",
        file: "src/a.ts",
        line: 42,
        notes: [
          human("2026-01-01T00:00:00Z", "this allocates on every render"),
          { author: BOT, body: ledgerReply("only", "memoised it"), at: "2026-01-01T01:00:00Z" },
          human("2026-01-01T02:00:00Z", "thanks"),
        ],
      },
    ];

    for (const provider of providers) {
      it(`${provider.name} agrees`, async () => {
        const adapter = provider.load(threads);
        const feed = await adapter.listReviewThreads(PR);
        const thread = feed.threads[0];

        expect(thread?.filePath).toBe("src/a.ts");
        expect(thread?.line).toBe(42);
        expect(thread?.notes.map((note) => note.author)).toEqual([
          "reviewer",
          BOT,
          "reviewer",
        ]);
        expect(thread?.notes.map((note) => note.body)).toEqual(
          threads[0]!.notes.map((note) => note.body),
        );
        expect(thread?.notes.map((note) => note.createdAt)).toEqual(
          threads[0]!.notes.map((note) => note.at),
        );
        // Only our own marked reply counts: a reviewer quoting the marker back
        // would otherwise read as the bot having spoken.
        expect(thread?.notes.map((note) => note.isLedgerReply)).toEqual([
          false,
          true,
          false,
        ]);
      });
    }
  });

  describe("the snapshot is taken before the read, never after", () => {
    for (const provider of providers) {
      it(`${provider.name} agrees`, async () => {
        const adapter = provider.load([
          { key: "a", file: "src/a.ts", line: 1, notes: [human("2026-01-01T00:00:00Z")] },
        ]);
        const before = Date.now();
        const feed = await adapter.listReviewThreads(PR);
        const after = Date.now();

        const snapshot = Date.parse(feed.snapshotAt);
        expect(Number.isNaN(snapshot)).toBe(false);
        // A comment landing mid-read must look newer than the snapshot, so the
        // stamp may not drift past the end of the read.
        expect(snapshot).toBeGreaterThanOrEqual(before);
        expect(snapshot).toBeLessThanOrEqual(after);
      });
    }
  });

  it("the context cap both adapters enforce is the one the contract names", () => {
    expect(REVIEW_LEDGER_MAX_CONTEXT_THREADS).toBe(20);
    expect(REVIEW_LEDGER_MAX_WORK_ITEMS).toBe(20);
  });
});
