import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  generateStructured: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    child: () => ({ warn: mocks.logWarn, info: mocks.logInfo }),
    warn: mocks.logWarn,
    info: mocks.logInfo,
  },
}));
vi.mock("../db/client.js", () => ({ getDb: () => mocks.db }));
vi.mock("../lib/llm.js", () => ({ generateStructured: mocks.generateStructured }));

import type { Db } from "../db/client.js";
import { agentMemoryDocuments } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { repoSubjectKey } from "../lib/subject-key.js";
import {
  parseRepoMemoryDocument,
  renderRepoMemoryDocument,
  stripRepoMemoryProvenance,
  type RepoMemoryDocKind,
  type RepoMemoryItem,
} from "../memory/repo-memory.js";
import { getMemoryDocument, upsertMemoryDocument } from "../memory/store.js";
import {
  distillRepoMemoryStep,
  loadRepoMemorySourcesStep,
} from "./repo-memory-steps.js";

const SUBJECT_KEY = "ticket:jira:AIW-300";
const TASK_ID = "AIW-300";
const TICKET_DOC_PATH = "blazebot/memory/AIW-300.md";
const REPO_PATH = "acme/api";
const REPO_SUBJECT_KEY = repoSubjectKey("github", REPO_PATH);
/** The label the step writes into the document header: the bare path, matching
 * the label repository instruction sections use in the same prompt. */
const DOC_SUBJECT = REPO_PATH;
/** Provider-qualified identifier the prompt shows and the model must echo. */
const REPO_KEY = `github:${REPO_PATH}`;
const USAGE = { inputTokens: 120, outputTokens: 40, cachedTokens: 8 };

const input = {
  runId: "run_1",
  subjectKey: SUBJECT_KEY,
  taskId: TASK_ID,
  repositories: [{ provider: "github" as const, repoPath: REPO_PATH }],
  changeSummary: "Rewired the worker memory steps.",
  model: "claude-test-model",
  timeoutMs: 1_000,
};

let db: Db;

function respond(object: unknown, usage: typeof USAGE | null = USAGE): void {
  mocks.generateStructured.mockResolvedValue({ object, text: "", usage });
}

function promptOf(): string {
  return mocks.generateStructured.mock.calls[0]?.[0]?.prompt ?? "";
}

async function storeTicketDocument(content: string): Promise<void> {
  await upsertMemoryDocument(db, {
    subjectKey: SUBJECT_KEY,
    docPath: TICKET_DOC_PATH,
    ticketKey: TASK_ID,
    content,
    sourceRunId: "run_0",
  });
}

/** `runId` stamps every bullet, so a case can store either a legacy document
 * with no provenance or one written by a known run. */
async function storeRepoDocument(
  kind: RepoMemoryDocKind,
  texts: string[],
  runId: string | null = null,
): Promise<void> {
  await upsertMemoryDocument(db, {
    subjectKey: REPO_SUBJECT_KEY,
    docPath: kind,
    ticketKey: null,
    content: renderRepoMemoryDocument({
      subject: DOC_SUBJECT,
      kind,
      items: texts.map((text) => ({ text, runId })),
    }),
    sourceRunId: "run_0",
  });
}

/** Writes verbatim under an arbitrary subject key, for the read path's blank,
 * oversized and cross-provider cases. */
async function storeDocument(
  subjectKey: string,
  kind: RepoMemoryDocKind,
  content: string,
): Promise<void> {
  await upsertMemoryDocument(db, {
    subjectKey,
    docPath: kind,
    ticketKey: null,
    content,
    sourceRunId: "run_0",
  });
}

/** Items, not their text: mapping to text here would make every assertion blind
 * to provenance, and provenance is what the eviction order runs on. */
async function readRepoItems(kind: RepoMemoryDocKind): Promise<RepoMemoryItem[] | null> {
  const stored = await getMemoryDocument(db, REPO_SUBJECT_KEY, kind);
  return stored ? parseRepoMemoryDocument(stored.content) : null;
}

async function repoRows() {
  return (await db.select().from(agentMemoryDocuments)).filter((row) =>
    row.subjectKey.startsWith("repo:"),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  mocks.db = db;
});

describe("distillRepoMemoryStep", () => {
  it("does nothing without a write-scoped repository", async () => {
    expect(await distillRepoMemoryStep({ ...input, repositories: [] })).toEqual({
      written: 0,
      usage: null,
      skipped: "no_repositories",
    });
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it("does nothing when the run left no material", async () => {
    expect(await distillRepoMemoryStep({ ...input, changeSummary: "  " })).toEqual({
      written: 0,
      usage: null,
      skipped: "no_material",
    });
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(await repoRows()).toHaveLength(0);
  });

  it("distills the ticket memory document and the change summary into both documents", async () => {
    await storeTicketDocument("# AIW-300\nThe typecheck script lives in apps/worker.");
    await storeRepoDocument("facts", ["Package manager is pnpm"]);
    respond({
      repositories: [
        {
          repository: REPO_KEY,
          facts: ["Run `pnpm -C apps/worker typecheck` before pushing"],
          lessons: ["vitest run in the repo root -> no tests matched -> run it from apps/worker"],
        },
      ],
    });

    expect(await distillRepoMemoryStep(input)).toEqual({
      written: 2,
      usage: USAGE,
      skipped: null,
    });
    // The untouched item keeps the provenance it was stored with; only what this
    // run asserted carries this run's id.
    expect(await readRepoItems("facts")).toEqual([
      { text: "Package manager is pnpm", runId: null },
      { text: "Run `pnpm -C apps/worker typecheck` before pushing", runId: "run_1" },
    ]);
    expect(await readRepoItems("lessons")).toEqual([
      {
        text: "vitest run in the repo root -> no tests matched -> run it from apps/worker",
        runId: "run_1",
      },
    ]);
    // The material the model saw carries both sources plus what is already stored.
    const prompt = promptOf();
    expect(prompt).toContain("The typecheck script lives in apps/worker.");
    expect(prompt).toContain("Rewired the worker memory steps.");
    expect(prompt).toContain("- Package manager is pnpm");
    expect(prompt).toContain(`### repository ${REPO_KEY}`);
    // The summary comes first so an oversized memory document loses its tail.
    expect(prompt.indexOf("## change summary")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("## change summary")).toBeLessThan(
      prompt.indexOf("## run material"),
    );
  });

  it("titles the stored document with the bare repository path", async () => {
    respond({ repositories: [{ repository: REPO_KEY, facts: ["Uses turborepo"], lessons: [] }] });

    expect((await distillRepoMemoryStep(input)).written).toBe(1);
    // Stage 3b injects this body next to repository instruction sections, which
    // label the same repository with its bare path.
    expect((await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts"))?.content).toContain(
      `# Repo facts: ${REPO_PATH}\n`,
    );
  });

  it("keeps the same path on two providers apart", async () => {
    const gitlabSubjectKey = repoSubjectKey("gitlab", REPO_PATH);
    respond({
      repositories: [
        { repository: REPO_KEY, facts: ["Checks run on GitHub Actions"], lessons: [] },
        {
          repository: `gitlab:${REPO_PATH}`,
          facts: ["Checks run on GitLab CI"],
          lessons: [],
        },
      ],
    });

    expect(
      (
        await distillRepoMemoryStep({
          ...input,
          repositories: [
            { provider: "github", repoPath: REPO_PATH },
            { provider: "gitlab", repoPath: REPO_PATH },
          ],
        })
      ).written,
    ).toBe(2);
    expect(await readRepoItems("facts")).toEqual([
      { text: "Checks run on GitHub Actions", runId: "run_1" },
    ]);
    const gitlab = await getMemoryDocument(db, gitlabSubjectKey, "facts");
    expect(parseRepoMemoryDocument(gitlab?.content ?? "")).toEqual([
      { text: "Checks run on GitLab CI", runId: "run_1" },
    ]);
  });

  it("stores repo documents with no owning ticket", async () => {
    respond({ repositories: [{ repository: REPO_KEY, facts: ["Uses turborepo"], lessons: [] }] });

    expect((await distillRepoMemoryStep(input)).written).toBe(1);
    const rows = await repoRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ticketKey).toBeNull();
    expect(rows[0]?.docPath).toBe("facts");
    expect(rows[0]?.sourceRunId).toBe("run_1");
  });

  it("rewrites the document when the model only confirms what it already knows", async () => {
    await storeRepoDocument("facts", ["Package manager is pnpm"]);
    respond({
      repositories: [{ repository: REPO_KEY, facts: ["package manager is pnpm."], lessons: [] }],
    });

    // A confirming run produces an identical text list, so comparing text alone
    // would skip this write and freeze the eviction order at whatever last
    // changed the text. One extra upsert per confirming run is the price.
    expect(await distillRepoMemoryStep(input)).toEqual({
      written: 1,
      usage: USAGE,
      skipped: null,
    });
    const stored = await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts");
    expect(stored?.sourceRunId).toBe("run_1");
    // Not duplicated, and stored under the spelling that got there first, but
    // now stamped with the run that reasserted it.
    expect(parseRepoMemoryDocument(stored?.content ?? "")).toEqual([
      { text: "Package manager is pnpm", runId: "run_1" },
    ]);
  });

  it("trims the model to the per-run caps", async () => {
    respond({
      repositories: [
        {
          repository: REPO_KEY,
          facts: Array.from({ length: 12 }, (_, index) => `fact ${index}`),
          lessons: Array.from({ length: 9 }, (_, index) => `lesson ${index}`),
        },
      ],
    });

    expect((await distillRepoMemoryStep(input)).written).toBe(2);
    expect(await readRepoItems("facts")).toEqual(
      Array.from({ length: 8 }, (_, index) => ({ text: `fact ${index}`, runId: "run_1" })),
    );
    expect(await readRepoItems("lessons")).toEqual(
      Array.from({ length: 5 }, (_, index) => ({ text: `lesson ${index}`, runId: "run_1" })),
    );
  });

  it("caps a single entry at 200 characters so it can never evict the document", async () => {
    const oversized = `x${"y".repeat(400)}`;
    await storeRepoDocument("facts", ["Package manager is pnpm"]);
    respond({ repositories: [{ repository: REPO_KEY, facts: [oversized], lessons: [] }] });

    expect((await distillRepoMemoryStep(input)).written).toBe(1);
    const items = (await readRepoItems("facts")) ?? [];
    // The stored entry is the head of the model's, and what was already there
    // survives: an item too large to fit would take the whole list with it.
    expect(items).toEqual([
      { text: "Package manager is pnpm", runId: null },
      { text: oversized.slice(0, 200), runId: "run_1" },
    ]);
    expect(items[1]?.text).toHaveLength(200);
  });

  it("lists already-known items in the prompt as their text", async () => {
    await storeRepoDocument("facts", ["Package manager is pnpm"], "wrun_old");
    respond({ repositories: [] });

    expect((await distillRepoMemoryStep(input)).skipped).toBe("no_candidates");
    const prompt = promptOf();
    expect(prompt).toContain("- Package manager is pnpm");
    // The known list holds items now, so interpolating one whole would send the
    // model "[object Object]" and it would restate every stored fact.
    expect(prompt).not.toContain("[object Object]");
    // Provenance is bookkeeping: the model is shown the text and nothing else.
    expect(prompt).not.toContain("wrun_old");
  });

  it("bounds the material it sends and keeps the change summary inside the cap", async () => {
    await storeTicketDocument(`${"note. ".repeat(6_000)}TAIL_SENTINEL`);
    respond({ repositories: [] });

    expect((await distillRepoMemoryStep(input)).skipped).toBe("no_candidates");
    const prompt = promptOf();
    expect(prompt).toContain("Rewired the worker memory steps.");
    expect(prompt).toContain("## run material");
    // 24 KiB of material plus the short repository section, so the oversized
    // ticket document is cut and the summary ahead of it is not.
    expect(prompt).not.toContain("TAIL_SENTINEL");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(24 * 1024 + 1_024);
  });

  it("ignores a repository the model invented", async () => {
    respond({
      repositories: [
        { repository: "github:other/service", facts: ["not our repository"], lessons: [] },
      ],
    });

    expect(await distillRepoMemoryStep(input)).toEqual({
      written: 0,
      usage: USAGE,
      skipped: "no_candidates",
    });
    expect(await repoRows()).toHaveLength(0);
  });

  it("tolerates a malformed model object", async () => {
    respond({ repositories: "not an array" });
    expect((await distillRepoMemoryStep(input)).skipped).toBe("no_candidates");

    mocks.generateStructured.mockClear();
    respond({
      repositories: [
        { repository: 7, facts: ["dropped"], lessons: [] },
        { repository: REPO_KEY, facts: [null, 5, "  kept  fact  "], lessons: "nope" },
      ],
    });

    expect((await distillRepoMemoryStep(input)).written).toBe(1);
    expect(await readRepoItems("facts")).toEqual([{ text: "kept fact", runId: "run_1" }]);
    expect(await readRepoItems("lessons")).toBeNull();
  });

  it("reports a provider failure without storing anything", async () => {
    mocks.generateStructured.mockRejectedValue(new Error("provider exploded"));

    expect(await distillRepoMemoryStep(input)).toEqual({
      written: 0,
      usage: null,
      skipped: "llm_failed",
    });
    expect(await repoRows()).toHaveLength(0);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.anything(),
      "repo_memory_distill_llm_failed",
    );
  });

  it("never throws when the store is unreachable", async () => {
    mocks.db = {
      select: () => {
        throw new Error("db down");
      },
    };

    expect(await distillRepoMemoryStep(input)).toEqual({
      written: 0,
      usage: null,
      skipped: "store_failed",
    });
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.anything(),
      "repo_memory_distill_failed",
    );
  });

  it("keeps the tokens it paid for when the write fails after the call", async () => {
    mocks.db = {
      select: db.select.bind(db),
      insert: () => {
        throw new Error("write down");
      },
    };
    respond({ repositories: [{ repository: REPO_KEY, facts: ["Uses turborepo"], lessons: [] }] });

    expect(await distillRepoMemoryStep(input)).toEqual({
      written: 0,
      usage: USAGE,
      skipped: "store_failed",
    });
  });
});

describe("loadRepoMemorySourcesStep", () => {
  const repositories = [{ provider: "github" as const, repoPath: REPO_PATH }];
  const OTHER_REPO_PATH = "acme/web";
  /** Mirrors MAX_INJECTED_MEMORY_BYTES, which the step keeps to itself. */
  const BUDGET = 32 * 1024;

  it("returns nothing without a repository", async () => {
    expect(await loadRepoMemorySourcesStep({ repositories: [] })).toEqual([]);
  });

  it("returns nothing when the repository has no stored documents", async () => {
    expect(await loadRepoMemorySourcesStep({ repositories })).toEqual([]);
  });

  it("strips provenance before a document reaches the prompt", async () => {
    await storeRepoDocument(
      "facts",
      ["Package manager is pnpm", "Built with vite"],
      "wrun_abc",
    );

    const sources = await loadRepoMemorySourcesStep({ repositories });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.content).not.toContain("run:");
    expect(sources[0]?.content).toContain("- Package manager is pnpm\n");
    expect(sources[0]?.content).toContain("- Built with vite\n");
    // Stripped on the way out only: the store still holds the provenance the
    // eviction order depends on.
    expect((await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts"))?.content).toContain(
      "<!-- run:wrun_abc -->",
    );
  });

  it("groups every repository's facts ahead of any repository's lessons", async () => {
    // Lessons written first, so the emitted order can only come from the loop
    // nesting rather than from write order.
    await storeRepoDocument("lessons", ["root vitest -> no tests matched -> run it in apps/worker"]);
    await storeRepoDocument("facts", ["Package manager is pnpm"]);
    for (const kind of ["lessons", "facts"] as const) {
      await storeDocument(
        repoSubjectKey("github", OTHER_REPO_PATH),
        kind,
        renderRepoMemoryDocument({
          subject: OTHER_REPO_PATH,
          kind,
          items: [{ text: `${kind} for web`, runId: null }],
        }),
      );
    }

    const sources = await loadRepoMemorySourcesStep({
      repositories: [
        { provider: "github", repoPath: REPO_PATH },
        { provider: "github", repoPath: OTHER_REPO_PATH },
      ],
    });
    // Facts for every repository first, manifest order within each kind: one
    // repository's lessons must not starve another repository's facts. The
    // labels are bare paths, never "github:acme/api", because repository
    // instruction sections label the same repository that way in this prompt.
    expect(sources.map((source) => `${source.repository}/${source.docPath}`)).toEqual([
      `${REPO_PATH}/facts`,
      `${OTHER_REPO_PATH}/facts`,
      `${REPO_PATH}/lessons`,
      `${OTHER_REPO_PATH}/lessons`,
    ]);
    expect(sources[0]?.content).toContain("- Package manager is pnpm");
    expect(sources[2]?.content).toContain(
      "- root vitest -> no tests matched -> run it in apps/worker",
    );
    // The store has no content hash column, so the compiler computes it.
    expect(sources[0]?.hash).toBeUndefined();
  });

  it("emits repositories in the input order", async () => {
    await storeRepoDocument("facts", ["Package manager is pnpm"]);
    await storeDocument(
      repoSubjectKey("github", OTHER_REPO_PATH),
      "facts",
      renderRepoMemoryDocument({
        subject: OTHER_REPO_PATH,
        kind: "facts",
        items: [{ text: "Built with vite", runId: null }],
      }),
    );

    const sources = await loadRepoMemorySourcesStep({
      repositories: [
        { provider: "github", repoPath: OTHER_REPO_PATH },
        { provider: "github", repoPath: REPO_PATH },
      ],
    });
    expect(sources.map((source) => source.repository)).toEqual([
      OTHER_REPO_PATH,
      REPO_PATH,
    ]);
  });

  it("skips a stored document with no items in it", async () => {
    await storeDocument(REPO_SUBJECT_KEY, "facts", "   \n\n  ");
    // Header plus marker and no bullets: not blank, but it would still compile
    // into a memory section with no content.
    await storeDocument(
      repoSubjectKey("github", OTHER_REPO_PATH),
      "facts",
      renderRepoMemoryDocument({ subject: OTHER_REPO_PATH, kind: "facts", items: [] }),
    );
    await storeRepoDocument("lessons", ["flaky suite -> reran -> pinned the seed"]);

    const sources = await loadRepoMemorySourcesStep({
      repositories: [
        { provider: "github", repoPath: REPO_PATH },
        { provider: "github", repoPath: OTHER_REPO_PATH },
      ],
    });
    expect(sources.map((source) => `${source.repository}/${source.docPath}`)).toEqual([
      `${REPO_PATH}/lessons`,
    ]);
  });

  it("charges the injection budget for injected bytes, not stored bytes", async () => {
    // Both rows carry provenance, so stored and injected bytes differ by 45 bytes
    // an item, and the pair is sized to fit only when what is measured is what the
    // prompt actually receives. A real run id is 31 characters; the short ids the
    // other cases use would hide a difference this small.
    const RUN_ID = "wrun_01jqz8v3h7k2m5n9p4r6s8t0xy";
    const texts = Array.from({ length: 40 }, (_, index) => `entry ${index} `.padEnd(400, "w"));
    await storeRepoDocument("facts", texts, RUN_ID);
    await storeRepoDocument("lessons", texts, RUN_ID);

    const bytes = (value: string) => Buffer.byteLength(value, "utf8");
    const storedFacts = (await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts"))?.content ?? "";
    const storedLessons =
      (await getMemoryDocument(db, REPO_SUBJECT_KEY, "lessons"))?.content ?? "";
    const injectedFacts = bytes(stripRepoMemoryProvenance(storedFacts));
    const injectedLessons = bytes(stripRepoMemoryProvenance(storedLessons));
    // The bracket the case rests on: measuring stored bytes at either end of the
    // accounting, the threshold or the accumulator, drops the second document.
    expect(injectedFacts + injectedLessons).toBeLessThanOrEqual(BUDGET);
    expect(bytes(storedFacts) + injectedLessons).toBeGreaterThan(BUDGET);
    expect(injectedFacts + bytes(storedLessons)).toBeGreaterThan(BUDGET);

    const sources = await loadRepoMemorySourcesStep({ repositories });
    expect(sources.map((source) => source.docPath)).toEqual(["facts", "lessons"]);
    expect(bytes(sources[0]?.content ?? "")).toBe(injectedFacts);
    expect(mocks.logWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      "repo_memory_injection_budget_exceeded",
    );
  });

  it("drops whole documents once the injection budget is spent and logs what was lost", async () => {
    // Oversized against today's 12 KiB write cap on purpose: the read path also
    // has to bound rows written under an older, larger cap. 20 + 20 > 32.
    const big = `# facts\n- ${"z".repeat(20 * 1024)}\n`;
    await storeDocument(REPO_SUBJECT_KEY, "facts", big);
    await storeDocument(repoSubjectKey("github", OTHER_REPO_PATH), "facts", big);
    // Small enough for the 12 KiB left over, and still dropped: once the budget
    // is spent nothing further is injected.
    await storeDocument(REPO_SUBJECT_KEY, "lessons", "# lessons\n- Built with vite\n");

    const sources = await loadRepoMemorySourcesStep({
      repositories: [
        { provider: "github", repoPath: REPO_PATH },
        { provider: "github", repoPath: OTHER_REPO_PATH },
      ],
    });
    // Whole documents only, so the 20 KiB that did fit is emitted untouched.
    expect(sources).toHaveLength(1);
    expect(sources[0]?.docPath).toBe("facts");
    expect(sources[0]?.repository).toBe(REPO_PATH);
    expect(sources[0]?.content).toBe(big);
    // A dropped document is never silent, and the diagnostic keeps the provider
    // so the same path on two providers cannot collapse into one name.
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        dropped: 2,
        repositories: [`github:${OTHER_REPO_PATH}`, `github:${REPO_PATH}`],
      }),
      "repo_memory_injection_budget_exceeded",
    );
  });

  it("keeps the same path on two providers apart in the drop warning", async () => {
    const big = `# facts\n- ${"z".repeat(20 * 1024)}\n`;
    await storeDocument(REPO_SUBJECT_KEY, "facts", big);
    await storeDocument(repoSubjectKey("gitlab", REPO_PATH), "facts", big);
    await storeDocument(REPO_SUBJECT_KEY, "lessons", big);

    await loadRepoMemorySourcesStep({
      repositories: [
        { provider: "github", repoPath: REPO_PATH },
        { provider: "gitlab", repoPath: REPO_PATH },
      ],
    });
    // Both dropped documents share the bare path, so deduping on it would have
    // reported one repository and hidden half the loss.
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        dropped: 2,
        repositories: [`gitlab:${REPO_PATH}`, `github:${REPO_PATH}`],
      }),
      "repo_memory_injection_budget_exceeded",
    );
  });

  it("keeps the same path on two providers apart", async () => {
    await storeRepoDocument("facts", ["Checks run on GitHub Actions"]);
    await storeDocument(
      repoSubjectKey("gitlab", REPO_PATH),
      "facts",
      renderRepoMemoryDocument({
        subject: REPO_PATH,
        kind: "facts",
        items: [{ text: "Checks run on GitLab CI", runId: null }],
      }),
    );

    const sources = await loadRepoMemorySourcesStep({
      repositories: [
        { provider: "github", repoPath: REPO_PATH },
        { provider: "gitlab", repoPath: REPO_PATH },
      ],
    });
    expect(sources).toHaveLength(2);
    // Only the subject key each was read from differs; the label does not.
    expect(sources.map((source) => source.repository)).toEqual([REPO_PATH, REPO_PATH]);
    expect(sources[0]?.content).toContain("- Checks run on GitHub Actions");
    expect(sources[1]?.content).toContain("- Checks run on GitLab CI");
  });

  it("never throws when the store is unreachable", async () => {
    mocks.db = {
      select: () => {
        throw new Error("db down");
      },
    };

    expect(await loadRepoMemorySourcesStep({ repositories })).toEqual([]);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.anything(),
      "repo_memory_load_failed",
    );
  });
});
