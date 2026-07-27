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
  type RepoMemoryDocKind,
} from "../memory/repo-memory.js";
import { getMemoryDocument, upsertMemoryDocument } from "../memory/store.js";
import { distillRepoMemoryStep } from "./repo-memory-steps.js";

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

async function storeRepoDocument(
  kind: RepoMemoryDocKind,
  items: string[],
): Promise<void> {
  await upsertMemoryDocument(db, {
    subjectKey: REPO_SUBJECT_KEY,
    docPath: kind,
    ticketKey: null,
    content: renderRepoMemoryDocument({ subject: DOC_SUBJECT, kind, items }),
    sourceRunId: "run_0",
  });
}

async function readRepoItems(kind: RepoMemoryDocKind): Promise<string[] | null> {
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
    expect(await readRepoItems("facts")).toEqual([
      "Package manager is pnpm",
      "Run `pnpm -C apps/worker typecheck` before pushing",
    ]);
    expect(await readRepoItems("lessons")).toEqual([
      "vitest run in the repo root -> no tests matched -> run it from apps/worker",
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
    expect(await readRepoItems("facts")).toEqual(["Checks run on GitHub Actions"]);
    const gitlab = await getMemoryDocument(db, gitlabSubjectKey, "facts");
    expect(parseRepoMemoryDocument(gitlab?.content ?? "")).toEqual([
      "Checks run on GitLab CI",
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

  it("keeps the stored document untouched when the model repeats what it already knows", async () => {
    await storeRepoDocument("facts", ["Package manager is pnpm"]);
    respond({
      repositories: [{ repository: REPO_KEY, facts: ["package manager is pnpm."], lessons: [] }],
    });

    expect(await distillRepoMemoryStep(input)).toEqual({
      written: 0,
      usage: USAGE,
      skipped: "no_candidates",
    });
    const stored = await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts");
    expect(stored?.sourceRunId).toBe("run_0");
    expect(parseRepoMemoryDocument(stored?.content ?? "")).toEqual([
      "Package manager is pnpm",
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
      Array.from({ length: 8 }, (_, index) => `fact ${index}`),
    );
    expect(await readRepoItems("lessons")).toEqual(
      Array.from({ length: 5 }, (_, index) => `lesson ${index}`),
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
    expect(items).toEqual(["Package manager is pnpm", oversized.slice(0, 200)]);
    expect(items[1]).toHaveLength(200);
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
    expect(await readRepoItems("facts")).toEqual(["kept fact"]);
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
