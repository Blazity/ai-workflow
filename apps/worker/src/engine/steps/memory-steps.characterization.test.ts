/**
 * CHARACTERIZATION: the ticket notebook's life in one run, as it is today.
 * Prepare hydrates the stored notebook into the sandbox root, the workflow
 * upserts the "Human decisions" section into that copy, and teardown stores
 * the newest copy it finds back, carrying the root copy's human decisions.
 * Since stage 1b the notebook lives in the built-in store whoever serves facts
 * and lessons; stage 6a pins the provider per run and rewrites the test named
 * after it.
 *
 * The three real steps run in sequence against one fake sandbox that keeps
 * its files and their modification times, and against the built-in store on
 * pglite, so what is asserted is what a later run would read back.
 */
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  db: null as unknown,
  activeMemory: vi.fn(),
  /** What the deployment's integration rows answer; nothing connected unless a case says so. */
  usable: [] as unknown[],
  states: new Map<string, unknown>(),
}));

vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.getSandbox } }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../../infra/logger.js", () => {
  const log = { warn: vi.fn(), info: vi.fn() };
  return { logger: { ...log, child: () => log } };
});
vi.mock("../../db/client.js", () => ({ getDb: () => mocks.db }));
vi.mock("../../services/integrations/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/integrations/runtime.js")>()),
  resolveUsableIntegrations: async () => ({
    readable: true as const,
    usable: mocks.usable,
    states: mocks.states,
    connectionFailures: new Map(),
  }),
  knownSecretValues: async () => [],
}));
// The real resolution, observed: which arguments each step resolves memory with.
vi.mock("../support/memory-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../support/memory-runtime.js")>();
  mocks.activeMemory.mockImplementation(actual.activeMemory);
  return { ...actual, activeMemory: mocks.activeMemory };
});

import type { Db } from "../../db/client.js";
import { agentMemoryDocuments } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import { getMemoryDocument, upsertMemoryDocument } from "../../memory/store.js";
import type { WorkspaceManifest } from "../../sandbox/repo-workspace.js";
import { fakeActiveMemory, fakeMemoryAddress } from "../../test-support/fake-active-memory.js";
import { hydrateWorkspaceMemoryStep, persistWorkspaceMemoryStep } from "./memory-steps.js";
import { writeHumanDecisionsMemory } from "./write-human-decisions-memory.js";

const SUBJECT_KEY = "ticket:jira:AIW-500";
const TASK_ID = "AIW-500";
const STORE_PATH = "ai-workflow/memory/AIW-500.md";
const ROOT_COPY = "/vercel/sandbox/ai-workflow/memory/AIW-500.md";
const CHECKOUT_DIR = "/vercel/sandbox/repos/github__acme__api";
const CHECKOUT_COPY = `${CHECKOUT_DIR}/ai-workflow/memory/AIW-500.md`;
const MANIFEST_PATH = "/vercel/sandbox/aiw-repos.json";

const STORED = "# Session Memory: AIW-500\n\n## Notes\n- the webhook needs a raw body parser\n";
const DECISIONS = [
  {
    questions: ["Which flavour should the widget ship in?"],
    answer: "vanilla",
    answeredBy: "Ada",
    answeredAt: "2026-09-20T10:00:00Z",
  },
];
/** The section as a person reads it in the stored notebook, written out by hand. */
const SECTION = [
  "<!-- human-decisions:start -->",
  "## Human decisions (from the dashboard)",
  "",
  "Recorded automatically from the clarification Q&A. Do not edit or remove.",
  "",
  "### Round 1 (answered by Ada, 2026-09-20T10:00:00Z)",
  "1. Which flavour should the widget ship in?",
  "",
  "Answer: vanilla",
  "<!-- human-decisions:end -->",
].join("\n");

const repository = {
  provider: "github" as const,
  repoPath: "acme/api",
  defaultBranch: "main",
  branchName: "ai/aiw-500",
  selectedRationale: "primary",
  access: "write" as const,
};
const rootManifest: WorkspaceManifest = {
  version: 2,
  repositories: [{ ...repository, slug: "acme__api", localPath: "/vercel/sandbox" }],
};
const promotedManifest: WorkspaceManifest = {
  version: 2,
  repositories: [{ ...repository, slug: "github__acme__api", localPath: CHECKOUT_DIR }],
};

let db: Db;

function commandResult(exitCode: number, stdout = "") {
  return { exitCode, stdout: async () => stdout, stderr: async () => "" };
}

/**
 * A sandbox that keeps what is written into it. Nothing is tracked by git,
 * every write advances a clock, and `stat` answers those times, which is what
 * teardown uses to pick the newest copy.
 */
function sandboxHolding(manifest: WorkspaceManifest) {
  const files = new Map<string, string>([[MANIFEST_PATH, JSON.stringify(manifest)]]);
  const mtimes = new Map<string, number>();
  let clock = 1_000;
  const touch = (path: string) => mtimes.set(path, (clock += 10));
  mocks.getSandbox.mockResolvedValue({
    runCommand: async (command: string, args: string[]) => {
      if (command === "cat") {
        const content = files.get(args[0] ?? "");
        return content === undefined ? commandResult(1) : commandResult(0, content);
      }
      if (command === "stat") {
        const paths = args.slice(args.indexOf("--") + 1).filter((path) => mtimes.has(path));
        return commandResult(0, paths.map((path) => `${mtimes.get(path)} ${path}`).join("\n"));
      }
      // git ls-files (nothing tracked) and mkdir.
      return commandResult(0, "");
    },
    writeFiles: async (entries: Array<{ path: string; content: Buffer }>) => {
      for (const entry of entries) {
        files.set(entry.path, entry.content.toString("utf8"));
        touch(entry.path);
      }
    },
    readFile: async ({ path }: { path: string }) => {
      const content = files.get(path);
      return content === undefined ? null : Readable.from([Buffer.from(content)]);
    },
  });
  return {
    files,
    /** The agent saving the notebook where its shell happens to be. */
    agentWrites(path: string, content: string) {
      files.set(path, content);
      touch(path);
    },
  };
}

function target(manifest: WorkspaceManifest) {
  return {
    sandboxId: "sbx-1",
    subjectKey: SUBJECT_KEY,
    ticketKey: TASK_ID,
    taskId: TASK_ID,
    workspaceManifest: manifest,
    runId: "run_7",
  };
}

async function storeNotebook(content: string): Promise<void> {
  await upsertMemoryDocument(db, {
    subjectKey: SUBJECT_KEY,
    docPath: STORE_PATH,
    ticketKey: TASK_ID,
    content,
    sourceRunId: "run_6",
  });
}

async function storedNotebook() {
  return getMemoryDocument(db, SUBJECT_KEY, STORE_PATH);
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  mocks.db = db;
  mocks.usable = [];
  mocks.states = new Map();
});

describe("hydrate, then human decisions, then persist", () => {
  it("hydrates the stored notebook at the sandbox root, upserts the human decisions into that copy, and stores the result back", async () => {
    // Mistake that turns this red: writing the decisions somewhere teardown
    // does not read, replacing the notebook instead of upserting into it, or
    // storing the copy prepare wrote rather than the one the run changed.
    await storeNotebook(STORED);
    const sandbox = sandboxHolding(rootManifest);

    const hydrated = await hydrateWorkspaceMemoryStep(target(rootManifest));
    expect(hydrated).toEqual({ source: "db", trackedInRepo: false, written: true, recalled: true });
    expect(sandbox.files.get(ROOT_COPY)).toBe(STORED);

    await writeHumanDecisionsMemory("sbx-1", TASK_ID, DECISIONS);
    const merged = `${STORED.trimEnd()}\n\n${SECTION}\n`;
    expect(sandbox.files.get(ROOT_COPY)).toBe(merged);

    const persisted = await persistWorkspaceMemoryStep({
      ...target(rootManifest),
      notebookRecalled: hydrated.recalled,
    });
    expect(persisted).toEqual({ persisted: true });
    expect(await storedNotebook()).toMatchObject({ content: merged, sourceRunId: "run_7" });
  });

  it("with nothing stored, the human decisions create the notebook at the root and teardown stores it", async () => {
    const sandbox = sandboxHolding(rootManifest);

    const hydrated = await hydrateWorkspaceMemoryStep(target(rootManifest));
    expect(hydrated).toEqual({ source: "none", trackedInRepo: false, written: false, recalled: true });

    await writeHumanDecisionsMemory("sbx-1", TASK_ID, DECISIONS);
    const created = `# Session Memory: AIW-500\n\n${SECTION}\n`;
    expect(sandbox.files.get(ROOT_COPY)).toBe(created);

    await persistWorkspaceMemoryStep({ ...target(rootManifest), notebookRecalled: hydrated.recalled });
    expect((await storedNotebook())?.content).toBe(created);
  });

  it("in the promoted layout, stores the agent's newer checkout copy together with the human decisions written at the root (A1)", async () => {
    // Hydrate and the decisions both write the root copy only; the agent,
    // working inside repos/<slug>, saves its notebook there without the
    // section. Mistake that turns this red: storing the newest copy as it is,
    // which drops what a person decided, or the root copy, which drops what
    // the agent learned.
    await storeNotebook(STORED);
    const sandbox = sandboxHolding(promotedManifest);

    const hydrated = await hydrateWorkspaceMemoryStep(target(promotedManifest));
    await writeHumanDecisionsMemory("sbx-1", TASK_ID, DECISIONS);
    expect(sandbox.files.get(ROOT_COPY)).toContain("<!-- human-decisions:start -->");
    const agentCopy = `${STORED}- the handler now verifies the signature first\n`;
    sandbox.agentWrites(CHECKOUT_COPY, agentCopy);

    await persistWorkspaceMemoryStep({ ...target(promotedManifest), notebookRecalled: hydrated.recalled });

    expect((await storedNotebook())?.content).toBe(`${agentCopy.trimEnd()}\n\n${SECTION}\n`);
  });
});

describe("which store the notebook goes to", () => {
  it("hydrate and persist use the built-in store with Mem0 connected, and Mem0 is never asked about the notebook", async () => {
    // Mistake that turns this red: resolving the notebook's store like facts
    // and lessons, which hands Mem0 a document it may rewrite or merge.
    const mem0 = fakeActiveMemory({
      [fakeMemoryAddress(SUBJECT_KEY, { kind: "notebook", name: TASK_ID })]: {
        entries: [STORED],
        rendering: STORED,
      },
    });
    mocks.usable = [
      {
        manifest: { id: "mem0", name: "Mem0", capabilities: ["memory"] },
        runtime: { capabilities: { memory: () => mem0.memory } },
        ctx: {},
        redaction: { text: (text: string) => text },
      },
    ];
    mocks.states = new Map([
      ["mem0", { integrationId: "mem0", status: "connected", connection: "connected", enabled: true, usable: true, failure: null }],
    ]);
    // Mem0 holds a notebook for this ticket too (the ones written before this
    // stage), and nothing reads it: the built-in copy is the notebook.
    const builtinOnly = "# Session Memory: AIW-500\n\nonly in the built-in store\n";
    await storeNotebook(builtinOnly);
    const sandbox = sandboxHolding(rootManifest);

    const hydrated = await hydrateWorkspaceMemoryStep(target(rootManifest));
    expect(hydrated).toEqual({ source: "db", trackedInRepo: false, written: true, recalled: true });
    expect(sandbox.files.get(ROOT_COPY)).toBe(builtinOnly);
    sandbox.agentWrites(ROOT_COPY, `${builtinOnly}- a new note\n`);
    const persisted = await persistWorkspaceMemoryStep({
      ...target(rootManifest),
      notebookRecalled: hydrated.recalled,
    });

    expect(persisted).toEqual({ persisted: true });
    expect(mem0.recalls).toEqual([]);
    expect(mem0.observations).toEqual([]);
    expect(await storedNotebook()).toMatchObject({
      content: `${builtinOnly}- a new note\n`,
      sourceRunId: "run_7",
    });
    expect(await db.select().from(agentMemoryDocuments)).toHaveLength(1);
  });

  it("changes in 6a: hydrate and persist each resolve memory for themselves, with no run pins", async () => {
    sandboxHolding(rootManifest);

    await hydrateWorkspaceMemoryStep(target(rootManifest));
    await writeHumanDecisionsMemory("sbx-1", TASK_ID, DECISIONS);
    await persistWorkspaceMemoryStep({ ...target(rootManifest), notebookRecalled: true });

    expect(mocks.activeMemory.mock.calls).toEqual([[], []]);
  });
});
