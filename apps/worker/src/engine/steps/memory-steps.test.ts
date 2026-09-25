import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  db: null as unknown,
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  /** Makes this deployment's secret set unreadable, which a recall answers
   *  as `unavailable`: the ordinary way hydration fails to see the notebook. */
  secretsUnreadable: false,
  /** The deployment's memory integrations as its rows answer them: nothing
   *  connected unless a case says otherwise. */
  usable: [] as unknown[],
  states: new Map<string, unknown>(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: { get: mocks.getSandbox },
}));
vi.mock("../../infra/logger.js", () => ({
  logger: {
    child: () => ({ warn: mocks.logWarn, info: mocks.logInfo }),
    warn: mocks.logWarn,
    info: mocks.logInfo,
  },
}));
vi.mock("../../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({}),
}));
vi.mock("../../db/client.js", () => ({ getDb: () => mocks.db }));
// A deployment with nothing connected: what it knows is its environment's
// secrets. These cases break the store on purpose, and the known set is read
// from the same database, so it is stated here rather than read from a fake
// that only answers the calls the store makes.
vi.mock("../../services/integrations/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/integrations/runtime.js")>();
  const { environmentSecretValues } = await import("../../run-observability/configured-secrets.js");
  return {
    ...actual,
    // Nothing connected unless a case connects Mem0, stated for the same
    // reason: with a memory integration in the registry, resolving who serves
    // memory reads the integration rows, and these cases swap the database for
    // a fake that answers only the store's own calls.
    resolveUsableIntegrations: async () => ({
      readable: true as const,
      usable: mocks.usable,
      states: mocks.states,
      connectionFailures: new Map(),
    }),
    knownSecretValues: async () => {
      if (mocks.secretsUnreadable) {
        const { IntegrationSettingsUnreadableError } = await import(
          "../../services/integrations/secret-values.js"
        );
        throw new IntegrationSettingsUnreadableError("so the secrets they hold could not be redacted", new Error("db blinked"));
      }
      return environmentSecretValues();
    },
  };
});

import type { Db } from "../../db/client.js";
import { agentMemoryDocuments } from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import {
  MAX_MEMORY_DOCUMENT_BYTES,
  getMemoryDocument,
  upsertMemoryDocument,
} from "../../memory/store.js";
import { MEMORY_NOTEBOOK_MAX_BYTES } from "@integrations/sdk";
import { MEMORY_CUT_MARKER } from "../../memory/content.js";
import type { WorkspaceManifest } from "../../sandbox/repo-workspace.js";
import { fakeActiveMemory, fakeMemoryAddress } from "../../test-support/fake-active-memory.js";
import {
  hydrateWorkspaceMemoryStep,
  persistWorkspaceMemoryStep,
} from "./memory-steps.js";

const SUBJECT_KEY = "ticket:jira:AIW-200";
const TASK_ID = "AIW-200";
const DOC_PATH = "ai-workflow/memory/AIW-200.md";
const LEGACY_DOC_PATH = "blazebot/memory/AIW-200.md";
/** The agent's cwd, which is where it reads and writes the document. */
const ROOT_PATH = "/vercel/sandbox/ai-workflow/memory/AIW-200.md";
const LEGACY_ROOT_PATH = "/vercel/sandbox/blazebot/memory/AIW-200.md";
const PROMOTED_REPO_DIR = "/vercel/sandbox/repos/github__acme__api";
const TRUNCATION_MARKER = "<!-- truncated by blazebot memory store -->";

const repository = {
  provider: "github" as const,
  repoPath: "acme/api",
  slug: "acme__api",
  defaultBranch: "main",
  branchName: "blazebot/aiw-200",
  selectedRationale: "primary",
  access: "write" as const,
};

/** Standard layout: the primary repository is checked out at the sandbox root. */
const rootManifest: WorkspaceManifest = {
  version: 2,
  repositories: [{ ...repository, localPath: "/vercel/sandbox" }],
};

/** Discovery-promoted layout: every repository lives under repos/<slug>, so the
 * memory document sits outside all of them. */
const promotedManifest: WorkspaceManifest = {
  version: 2,
  repositories: [
    { ...repository, slug: "github__acme__api", localPath: PROMOTED_REPO_DIR },
  ],
};

const target = {
  sandboxId: "sbx-1",
  subjectKey: SUBJECT_KEY,
  ticketKey: TASK_ID,
  taskId: TASK_ID,
  workspaceManifest: rootManifest,
  runId: "run_1",
};

let db: Db;

function commandResult(exitCode: number, stdout = "") {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(""),
  };
}

function fakeSandbox(options: {
  files?: Record<string, string>;
  lsFiles?: string;
  lsFilesExitCode?: number;
  readFileError?: Error;
  /** Modification time in seconds per path, answered to `stat -c "%Y %n"`. */
  mtimes?: Record<string, number>;
} = {}) {
  const runCommand = vi.fn(async (command: string, args: string[]) => {
    if (command === "git" && args.includes("ls-files")) {
      return commandResult(options.lsFilesExitCode ?? 0, options.lsFiles ?? "");
    }
    if (command === "stat") {
      const paths = args.slice(args.indexOf("--") + 1);
      const lines = paths
        .filter((path) => options.mtimes?.[path] !== undefined)
        .map((path) => `${options.mtimes![path]} ${path}`);
      return commandResult(lines.length === paths.length ? 0 : 1, lines.join("\n"));
    }
    return commandResult(0);
  });
  const writeFiles = vi.fn().mockResolvedValue(undefined);
  const readFile = vi.fn(async ({ path }: { path: string }) => {
    if (options.readFileError) throw options.readFileError;
    const content = options.files?.[path];
    return content === undefined ? null : Readable.from([Buffer.from(content)]);
  });
  const sandbox = { runCommand, writeFiles, readFile };
  mocks.getSandbox.mockResolvedValue(sandbox);
  return sandbox;
}

async function storeDocument(content: string, docPath = DOC_PATH): Promise<void> {
  await upsertMemoryDocument(db, {
    subjectKey: SUBJECT_KEY,
    docPath,
    ticketKey: TASK_ID,
    content,
    sourceRunId: "run_0",
  });
}

async function countRows(): Promise<number> {
  return (await db.select().from(agentMemoryDocuments)).length;
}

function lsFilesCalls(sandbox: { runCommand: ReturnType<typeof vi.fn> }): unknown[] {
  return sandbox.runCommand.mock.calls.filter(
    ([command, args]) => command === "git" && (args as string[]).includes("ls-files"),
  );
}

/**
 * Mem0 as the deployment's rows describe it, with a fake engine behind it that
 * holds a notebook for this ticket (as production's did before notebooks
 * stopped going there) and records every call it is asked.
 */
function mem0Is(status: "connected" | "failing" | "disabled") {
  const mem0 = fakeActiveMemory({
    [fakeMemoryAddress(SUBJECT_KEY, { kind: "notebook", name: TASK_ID })]: {
      entries: ["# the copy Mem0 holds"],
      rendering: "# the copy Mem0 holds",
    },
  });
  mocks.usable =
    status === "connected"
      ? [
          {
            manifest: { id: "mem0", name: "Mem0", capabilities: ["memory"] },
            runtime: { capabilities: { memory: () => mem0.memory } },
            ctx: {},
            redaction: { text: (text: string) => text },
          },
        ]
      : [];
  mocks.states = new Map([
    [
      "mem0",
      {
        integrationId: "mem0",
        status,
        connection: status === "disabled" ? "connected" : status,
        enabled: status !== "disabled",
        usable: status === "connected",
        failure:
          status === "failing"
            ? { reason: "credential_rejected", message: "Mem0 refused the API key" }
            : null,
      },
    ],
  ]);
  return mem0;
}

/** A database every read and write of the built-in store fails against. */
function unreachableDb() {
  const fail = () => {
    throw new Error("db unreachable");
  };
  return { select: fail, insert: fail, update: fail, delete: fail };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.secretsUnreadable = false;
  mocks.usable = [];
  mocks.states = new Map();
  db = await createTestDb();
  mocks.db = db;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a notebook write that may have landed", () => {
  it("is never repeated by the step runner", () => {
    // A retried step would send the same observe again after an answer that
    // may have been stored: core never repeats a memory write.
    expect(hydrateWorkspaceMemoryStep.maxRetries).toBe(0);
    expect(persistWorkspaceMemoryStep.maxRetries).toBe(0);
  });
});

describe("a notebook the run never saw", () => {
  it("is kept at teardown rather than replaced by a file that started without it", async () => {
    // Hydration could not read memory, so the agent started with an empty
    // notebook and wrote this run's notes into it. Storing that file would
    // replace every earlier run's history with one run's notes.
    await storeDocument("# history\n- three runs of notes");
    fakeSandbox({ lsFiles: "" });
    mocks.secretsUnreadable = true;
    const hydrated = await hydrateWorkspaceMemoryStep(target);
    expect(hydrated).toMatchObject({ written: false, recalled: false });

    // Memory is back by teardown; the agent's file is there.
    mocks.secretsUnreadable = false;
    fakeSandbox({ files: { [ROOT_PATH]: "# this run\n- one new note" } });
    const captured = await persistWorkspaceMemoryStep({
      ...target,
      notebookRecalled: hydrated.recalled,
    });

    expect(captured).toEqual({
      persisted: false,
      withheld: expect.stringContaining("the stored notebook was kept"),
    });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
      "# history\n- three runs of notes",
    );
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        store: "builtin",
        detail: expect.stringContaining("started without the notebook"),
      }),
      "memory_document_persist_withheld",
    );
  });

  it("is not written over when memory still cannot say whether one is stored", async () => {
    await storeDocument("# history");
    fakeSandbox({ files: { [ROOT_PATH]: "# this run" } });
    mocks.secretsUnreadable = true;

    const captured = await persistWorkspaceMemoryStep({ ...target, notebookRecalled: false });

    expect(captured).toEqual({
      persisted: false,
      withheld: expect.stringContaining("still could not say"),
    });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe("# history");
  });

  it("is stored when nothing was there to replace", async () => {
    // The positive control: a first run whose hydration failed still keeps
    // what the agent wrote, because there was no history to lose.
    fakeSandbox({ files: { [ROOT_PATH]: "# this run\n- first notes" } });

    const captured = await persistWorkspaceMemoryStep({ ...target, notebookRecalled: false });

    expect(captured).toEqual({ persisted: true });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
      "# this run\n- first notes",
    );
  });
});

/**
 * A notebook is a document a run writes into the workspace and reads back
 * byte for byte, so it stays in the built-in store whichever provider serves
 * facts and lessons. The Agent memory switch never reaches these steps: with
 * it off, prepare still hydrates and teardown still persists
 * (`prepare-workspace.test.ts`, `agent-memory-teardown.characterization.test.ts`),
 * which is exactly what the cases below then do.
 */
describe("which store keeps the notebook", () => {
  it.each([
    ["Mem0 is connected and serves facts and lessons", "connected"],
    ["Mem0 is switched off, so the built-in store serves everything", "disabled"],
    ["Mem0 is switched on and failing, so facts and lessons go without memory", "failing"],
  ] as const)("hydrates from and persists to the built-in store when %s, and never asks Mem0", async (_, status) => {
    const mem0 = mem0Is(status);
    await storeDocument("# history");
    const hydrating = fakeSandbox();

    const hydrated = await hydrateWorkspaceMemoryStep(target);
    expect(hydrated).toEqual({ source: "db", trackedInRepo: false, written: true, recalled: true });
    expect(hydrating.writeFiles).toHaveBeenCalledWith([
      { path: ROOT_PATH, content: Buffer.from("# history") },
    ]);

    fakeSandbox({ files: { [ROOT_PATH]: "# history\n- this run" } });
    const captured = await persistWorkspaceMemoryStep({
      ...target,
      notebookRecalled: hydrated.recalled,
    });

    expect(captured).toEqual({ persisted: true });
    expect(await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH)).toMatchObject({
      content: "# history\n- this run",
      sourceRunId: "run_1",
    });
    expect(mem0.recalls).toEqual([]);
    expect(mem0.observations).toEqual([]);
  });

  it("reports recalled:false when the built-in store cannot be read, never reads Mem0 instead, and teardown keeps the stored notebook", async () => {
    // Mistake that turns this red: falling back to the connected engine for a
    // notebook the built-in store could not answer, which hands the agent a
    // stale copy and lets teardown write over the real one.
    const mem0 = mem0Is("connected");
    await storeDocument("# history\n- three runs of notes");
    mocks.db = unreachableDb();
    const hydrating = fakeSandbox();

    const hydrated = await hydrateWorkspaceMemoryStep(target);

    expect(hydrated).toEqual({
      source: "none",
      trackedInRepo: false,
      written: false,
      recalled: false,
      unavailable: expect.stringContaining("db unreachable"),
    });
    expect(hydrated.unavailable).toContain("built-in store");
    expect(hydrating.writeFiles).not.toHaveBeenCalled();
    // The log line names the store that refused, which is not Mem0.
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ store: "builtin", code: "unavailable" }),
      "memory_provider_unavailable",
    );

    // The database is back by teardown; the agent wrote a notebook from scratch.
    mocks.db = db;
    fakeSandbox({ files: { [ROOT_PATH]: "# this run\n- one new note" } });
    const captured = await persistWorkspaceMemoryStep({
      ...target,
      notebookRecalled: hydrated.recalled,
    });

    expect(captured).toEqual({
      persisted: false,
      withheld: expect.stringContaining("the stored notebook was kept"),
    });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
      "# history\n- three runs of notes",
    );
    expect(mem0.recalls).toEqual([]);
    expect(mem0.observations).toEqual([]);
  });

  it("withholds at teardown when the built-in store still cannot be read, and writes nothing to Mem0 instead", async () => {
    const mem0 = mem0Is("connected");
    mocks.db = unreachableDb();
    fakeSandbox({ files: { [ROOT_PATH]: "# this run" } });

    const captured = await persistWorkspaceMemoryStep({ ...target, notebookRecalled: false });

    expect(captured).toEqual({
      persisted: false,
      withheld: expect.stringContaining("still could not say"),
    });
    expect(mem0.recalls).toEqual([]);
    expect(mem0.observations).toEqual([]);
  });
});

describe("hydrateWorkspaceMemoryStep", () => {
  it("writes the stored document to the agent cwd", async () => {
    await storeDocument("# stored notes\nzażółć");
    const sandbox = fakeSandbox();

    expect(await hydrateWorkspaceMemoryStep(target)).toEqual({
      source: "db",
      trackedInRepo: false,
      written: true,
      recalled: true,
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith("mkdir", [
      "-p",
      "/vercel/sandbox/ai-workflow/memory",
    ]);
    expect(sandbox.writeFiles).toHaveBeenCalledWith([
      { path: ROOT_PATH, content: Buffer.from("# stored notes\nzażółć") },
    ]);
  });

  it("writes a recalled notebook longer than the notebook limit cut, and says where", async () => {
    // M2 for the notebook: whatever a provider returns, the agent's file is at
    // most the SDK's notebook limit, and a cut one ends with a line the agent
    // reads. Written straight into the table, the way a row from an older cap
    // or an engine that holds more looks, because the store refuses to write
    // one this size itself.
    const paragraph = `${"notes about the plan ".repeat(40)}\n`;
    const content = paragraph.repeat(Math.ceil((300 * 1024) / paragraph.length));
    await db.insert(agentMemoryDocuments).values({
      subjectKey: SUBJECT_KEY,
      docPath: DOC_PATH,
      ticketKey: TASK_ID,
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      sourceRunId: "run_0",
    });
    const sandbox = fakeSandbox();

    expect(await hydrateWorkspaceMemoryStep(target)).toMatchObject({ written: true });
    const files = (sandbox.writeFiles.mock.calls[0]?.[0] ?? []) as Array<{ content: Buffer }>;
    const written = files[0]?.content;
    expect(written?.byteLength).toBeLessThanOrEqual(MEMORY_NOTEBOOK_MAX_BYTES);
    expect(written?.toString("utf8").endsWith(`\n${MEMORY_CUT_MARKER}`)).toBe(true);
    expect(written?.toString("utf8").startsWith(paragraph)).toBe(true);
  });

  it("hydrates a document stored under the legacy key when the new key is absent", async () => {
    // Only the legacy blazebot/memory key holds the document; the new key is empty.
    await storeDocument("# legacy stored", LEGACY_DOC_PATH);
    const sandbox = fakeSandbox();

    expect(await hydrateWorkspaceMemoryStep(target)).toEqual({
      source: "db",
      trackedInRepo: false,
      written: true,
      recalled: true,
    });
    // Migrated on read: written to the NEW path the current prompt points at.
    expect(sandbox.runCommand).toHaveBeenCalledWith("mkdir", [
      "-p",
      "/vercel/sandbox/ai-workflow/memory",
    ]);
    expect(sandbox.writeFiles).toHaveBeenCalledWith([
      { path: ROOT_PATH, content: Buffer.from("# legacy stored") },
    ]);
  });

  it("creates the nested directory a PR-trigger document needs", async () => {
    const prTaskId = "pr:github:acme/app#7";
    const prDocPath = `ai-workflow/memory/${prTaskId}.md`;
    await storeDocument("# pr notes", prDocPath);
    const sandbox = fakeSandbox();

    expect(
      await hydrateWorkspaceMemoryStep({ ...target, taskId: prTaskId, ticketKey: null }),
    ).toEqual({ source: "db", trackedInRepo: false, written: true, recalled: true });
    expect(sandbox.runCommand).toHaveBeenCalledWith("mkdir", [
      "-p",
      "/vercel/sandbox/ai-workflow/memory/pr:github:acme",
    ]);
    expect(sandbox.writeFiles).toHaveBeenCalledWith([
      { path: `/vercel/sandbox/${prDocPath}`, content: Buffer.from("# pr notes") },
    ]);
  });

  it("leaves a memory file that the root repository already tracks untouched", async () => {
    await storeDocument("# stored notes");
    const sandbox = fakeSandbox({ lsFiles: `${DOC_PATH}\n` });

    expect(await hydrateWorkspaceMemoryStep(target)).toEqual({
      source: "db",
      trackedInRepo: true,
      written: false,
      recalled: true,
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "ls-files",
      "--",
      DOC_PATH,
    ]);
    // Overwriting a tracked file would leave a tracked modification that the
    // publication cleanliness check rejects, so the checkout stays as it is.
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
    expect(sandbox.runCommand).not.toHaveBeenCalledWith("mkdir", expect.anything());
    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.anything(),
      "memory_hydration_skipped_tracked",
    );
  });

  it("fails closed when the tracking probe cannot answer", async () => {
    await storeDocument("# stored notes");
    const sandbox = fakeSandbox({ lsFilesExitCode: 128 });

    expect(await hydrateWorkspaceMemoryStep(target)).toEqual({
      source: "none",
      trackedInRepo: false,
      written: false,
      recalled: false,
    });
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.anything(),
      "memory_document_tracked_probe_failed",
    );
  });

  it("skips the tracking probe when no repository sits at the agent cwd", async () => {
    await storeDocument("# stored notes");
    const sandbox = fakeSandbox();

    expect(
      await hydrateWorkspaceMemoryStep({
        ...target,
        workspaceManifest: promotedManifest,
      }),
    ).toEqual({ source: "db", trackedInRepo: false, written: true, recalled: true });
    expect(lsFilesCalls(sandbox)).toHaveLength(0);
    expect(sandbox.writeFiles).toHaveBeenCalledWith([
      { path: ROOT_PATH, content: Buffer.from("# stored notes") },
    ]);
  });

  it("seeds the store from the file at the agent cwd and leaves it in place", async () => {
    const sandbox = fakeSandbox({ files: { [ROOT_PATH]: "# legacy notes" } });

    expect(await hydrateWorkspaceMemoryStep(target)).toEqual({
      source: "repo",
      trackedInRepo: false,
      written: false,
      recalled: true,
    });
    const stored = await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH);
    expect(stored?.content).toBe("# legacy notes");
    expect(stored?.sourceRunId).toBe("run_1");
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it("reports a seed the store refused, naming the store", async () => {
    const reads = db.select.bind(db);
    mocks.db = {
      select: reads,
      insert: () => {
        throw new Error("db refused the write");
      },
    };
    fakeSandbox({ files: { [ROOT_PATH]: "# committed notes" } });

    expect(await hydrateWorkspaceMemoryStep(target)).toEqual({
      source: "none",
      trackedInRepo: false,
      written: false,
      unavailable: expect.stringContaining("db refused the write"),
      recalled: true,
    });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ store: "builtin", code: "unavailable" }),
      "memory_document_seed_refused",
    );
  });

  it("seeds from a legacy committed file at the agent cwd, keyed to the new path", async () => {
    // No new-path copy anywhere; only the legacy blazebot/memory file exists.
    const sandbox = fakeSandbox({ files: { [LEGACY_ROOT_PATH]: "# legacy committed" } });

    expect(await hydrateWorkspaceMemoryStep(target)).toEqual({
      source: "repo",
      trackedInRepo: false,
      written: false,
      recalled: true,
    });
    // Re-keyed to the new path so persist and future runs read it there.
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
      "# legacy committed",
    );
    expect(await getMemoryDocument(db, SUBJECT_KEY, LEGACY_DOC_PATH)).toBeNull();
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it("seeds from the promoted checkout when the agent cwd has no copy", async () => {
    const sandbox = fakeSandbox({
      files: { [`${PROMOTED_REPO_DIR}/${DOC_PATH}`]: "# committed notes" },
    });

    expect(
      await hydrateWorkspaceMemoryStep({
        ...target,
        workspaceManifest: promotedManifest,
      }),
    ).toEqual({ source: "repo", trackedInRepo: false, written: false, recalled: true });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
      "# committed notes",
    );
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
  });

  it("does nothing when neither the store nor the workspace has the document", async () => {
    const sandbox = fakeSandbox();

    expect(await hydrateWorkspaceMemoryStep(target)).toEqual({
      source: "none",
      trackedInRepo: false,
      written: false,
      recalled: true,
    });
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
    expect(await countRows()).toBe(0);
  });

  it("never fails the run when the sandbox is unreachable", async () => {
    mocks.getSandbox.mockRejectedValue(new Error("sandbox gone"));

    expect(await hydrateWorkspaceMemoryStep(target)).toEqual({
      source: "none",
      trackedInRepo: false,
      written: false,
      recalled: false,
    });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.anything(),
      "memory_document_hydrate_failed",
    );
  });
});

describe("persistWorkspaceMemoryStep", () => {
  it("stores the file with the run that produced it", async () => {
    fakeSandbox({ files: { [ROOT_PATH]: "# notes\nlearned something" } });

    expect(await persistWorkspaceMemoryStep(target)).toEqual({ persisted: true });
    const stored = await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH);
    expect(stored?.content).toBe("# notes\nlearned something");
    expect(stored?.sourceRunId).toBe("run_1");
  });

  it("persists a legacy-path workspace file under the new store key", async () => {
    // A run started under the pre-migration prompt wrote only the legacy path;
    // its last increment must still reach the store, keyed to the new path.
    fakeSandbox({ files: { [LEGACY_ROOT_PATH]: "# legacy increment" } });

    expect(await persistWorkspaceMemoryStep(target)).toEqual({ persisted: true });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
      "# legacy increment",
    );
    expect(await getMemoryDocument(db, SUBJECT_KEY, LEGACY_DOC_PATH)).toBeNull();
  });

  it("reads the agent cwd in the promoted layout too", async () => {
    const sandbox = fakeSandbox({ files: { [ROOT_PATH]: "# notes" } });

    expect(
      await persistWorkspaceMemoryStep({
        ...target,
        workspaceManifest: promotedManifest,
      }),
    ).toEqual({ persisted: true });
    expect(sandbox.readFile).toHaveBeenCalledWith({ path: ROOT_PATH });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe("# notes");
  });

  it("strips NUL characters that Postgres text cannot hold", async () => {
    fakeSandbox({ files: { [ROOT_PATH]: "before\u0000after" } });

    expect(await persistWorkspaceMemoryStep(target)).toEqual({ persisted: true });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
      "beforeafter",
    );
  });

  it("redacts configured secrets and keeps everything else verbatim", async () => {
    vi.stubEnv("MEMORY_TEST_API_KEY", "unicorn-plaintext-credential");
    const body = [
      "Deployed on 2026-07-14 after ops@example.com approved it.",
      "Run 123e4567-e89b-12d3-a456-426614174000 used unicorn-plaintext-credential.",
    ].join("\n");
    fakeSandbox({ files: { [ROOT_PATH]: body } });

    expect(await persistWorkspaceMemoryStep(target)).toEqual({ persisted: true });
    const content = (await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content ?? "";
    expect(content).not.toContain("unicorn-plaintext-credential");
    expect(content).toContain("[REDACTED:configured_secret]");
    // The agent reads this document back, so nothing but the secret may change.
    expect(content).toBe(
      body.replace("unicorn-plaintext-credential", "[REDACTED:configured_secret]"),
    );
    expect(content).toContain("2026-07-14");
    expect(content).toContain("ops@example.com");
    expect(content).toContain("123e4567-e89b-12d3-a456-426614174000");
  });

  it("truncates an oversized document with a marker inside the cap", async () => {
    fakeSandbox({
      files: { [ROOT_PATH]: `${"x".repeat(MAX_MEMORY_DOCUMENT_BYTES)}tail` },
    });

    expect(await persistWorkspaceMemoryStep(target)).toEqual({ persisted: true });
    const stored = await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH);
    expect(stored?.content.endsWith(`\n${TRUNCATION_MARKER}`)).toBe(true);
    expect(stored?.bytes).toBeLessThanOrEqual(MAX_MEMORY_DOCUMENT_BYTES);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.anything(),
      "memory_document_truncated",
    );
  });

  it("keeps a multi-byte character whole when truncating", async () => {
    // Two-byte characters past the cap, offset by one leading byte so every
    // boundary lands inside a character: a byte-exact cut would store a
    // replacement character, both at read time and at truncation time.
    const filler = `a${"ż".repeat(MAX_MEMORY_DOCUMENT_BYTES)}`;
    fakeSandbox({ files: { [ROOT_PATH]: filler } });

    expect(await persistWorkspaceMemoryStep(target)).toEqual({ persisted: true });
    const stored = await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH);
    expect(stored?.content).not.toContain("�");
    expect(stored?.bytes).toBeLessThanOrEqual(MAX_MEMORY_DOCUMENT_BYTES);
  });

  it("stores nothing for a missing or empty document, and says so", async () => {
    fakeSandbox({ files: { [ROOT_PATH]: "   \n" } });
    expect(await persistWorkspaceMemoryStep(target)).toEqual({
      persisted: false,
      absent: expect.stringContaining("the agent left no notebook for AIW-200"),
    });

    fakeSandbox();
    expect(await persistWorkspaceMemoryStep(target)).toEqual({
      persisted: false,
      absent: expect.stringContaining("the agent left no notebook for AIW-200"),
    });
    expect(await countRows()).toBe(0);
  });

  it("stores a notebook the agent wrote inside the promoted checkout", async () => {
    // Production, AWP-269 to AWP-272: repository selection promoted the
    // discovery sandbox, so the only checkout was repos/<slug>. The agent
    // worked from inside it and wrote the notebook relative to that cwd.
    const inCheckout = `${PROMOTED_REPO_DIR}/${DOC_PATH}`;
    fakeSandbox({ files: { [inCheckout]: "# notes\n- written from inside the checkout" } });

    expect(
      await persistWorkspaceMemoryStep({ ...target, workspaceManifest: promotedManifest }),
    ).toEqual({ persisted: true });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
      "# notes\n- written from inside the checkout",
    );
    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ notebookPath: inCheckout }),
      "memory_document_persisted",
    );
  });

  it("stores the agent's update in the checkout over the older copy hydration left at the root", async () => {
    // Hydration writes the stored notebook at the root; the agent read it,
    // moved into the checkout and wrote its update there. The root copy is
    // what the run started from, so storing it would drop this run's notes.
    const inCheckout = `${PROMOTED_REPO_DIR}/${DOC_PATH}`;
    fakeSandbox({
      files: { [ROOT_PATH]: "# history", [inCheckout]: "# history\n- this run" },
      mtimes: { [ROOT_PATH]: 1_790_000_000, [inCheckout]: 1_790_000_600 },
    });

    expect(
      await persistWorkspaceMemoryStep({ ...target, workspaceManifest: promotedManifest }),
    ).toEqual({ persisted: true });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
      "# history\n- this run",
    );
  });

  it("keeps the root copy when it is the newer one", async () => {
    // The control for the case above: newest wins, not the checkout.
    const inCheckout = `${PROMOTED_REPO_DIR}/${DOC_PATH}`;
    fakeSandbox({
      files: { [ROOT_PATH]: "# newer at root", [inCheckout]: "# older in checkout" },
      mtimes: { [ROOT_PATH]: 1_790_000_600, [inCheckout]: 1_790_000_000 },
    });

    await persistWorkspaceMemoryStep({ ...target, workspaceManifest: promotedManifest });
    expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
      "# newer at root",
    );
  });

  describe("the human decisions the platform writes at the root", () => {
    // `writeHumanDecisionsMemory` upserts this section into the root copy
    // only; an agent working inside the checkout saves its notebook there.
    const inCheckout = `${PROMOTED_REPO_DIR}/${DOC_PATH}`;
    const ONE_ROUND = [
      "<!-- human-decisions:start -->",
      "## Human decisions (from the dashboard)",
      "",
      "### Round 1 (answered by Ada)",
      "1. Which flavour should the widget ship in?",
      "",
      "Answer: vanilla",
      "<!-- human-decisions:end -->",
    ].join("\n");
    const TWO_ROUNDS = [
      "<!-- human-decisions:start -->",
      "## Human decisions (from the dashboard)",
      "",
      "### Round 1 (answered by Ada)",
      "1. Which flavour should the widget ship in?",
      "",
      "Answer: vanilla",
      "",
      "### Round 2 (answered by Grace)",
      "1. Should it ship behind a flag?",
      "",
      "Answer: yes, off by default",
      "<!-- human-decisions:end -->",
    ].join("\n");

    it("are carried into the agent's newer checkout copy that lacks them", async () => {
      fakeSandbox({
        files: {
          [ROOT_PATH]: `# history\n\n${ONE_ROUND}\n`,
          [inCheckout]: "# history\n- this run\n",
        },
        mtimes: { [ROOT_PATH]: 1_790_000_000, [inCheckout]: 1_790_000_600 },
      });

      expect(
        await persistWorkspaceMemoryStep({ ...target, workspaceManifest: promotedManifest }),
      ).toEqual({ persisted: true });
      expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
        `# history\n- this run\n\n${ONE_ROUND}\n`,
      );
    });

    it("replace an older section the agent's copy carried, where it carried it", async () => {
      // The agent copied the notebook before a second round was answered.
      fakeSandbox({
        files: {
          [ROOT_PATH]: `# history\n\n${TWO_ROUNDS}\n`,
          [inCheckout]: `# history\n\n${ONE_ROUND}\n\n## Notes\n- this run\n`,
        },
        mtimes: { [ROOT_PATH]: 1_790_000_000, [inCheckout]: 1_790_000_600 },
      });

      await persistWorkspaceMemoryStep({ ...target, workspaceManifest: promotedManifest });
      expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
        `# history\n\n${TWO_ROUNDS}\n\n## Notes\n- this run\n`,
      );
    });

    it("stay whole when the agent's notebook fills the limit, and the agent's notes are cut instead", async () => {
      // Appended past the limit, the section would be what the store cuts off
      // the end. Mistake that turns this red: appending without making room.
      const line = `${"n".repeat(99)}\n`;
      const notes = line.repeat(Math.ceil(MEMORY_NOTEBOOK_MAX_BYTES / line.length) + 10);
      fakeSandbox({
        files: { [ROOT_PATH]: `# history\n\n${TWO_ROUNDS}\n`, [inCheckout]: notes },
        mtimes: { [ROOT_PATH]: 1_790_000_000, [inCheckout]: 1_790_000_600 },
      });

      expect(
        await persistWorkspaceMemoryStep({ ...target, workspaceManifest: promotedManifest }),
      ).toEqual({ persisted: true });
      const stored = (await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content ?? "";
      expect(stored.endsWith(`\n${MEMORY_CUT_MARKER}\n\n${TWO_ROUNDS}\n`)).toBe(true);
      expect(stored.startsWith(line)).toBe(true);
      expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(MEMORY_NOTEBOOK_MAX_BYTES);
      expect(stored).not.toContain(TRUNCATION_MARKER);
    });

    it("keep the agent's notes after an older section when the limit falls inside that section", async () => {
      // The agent's copy fits the limit with its one-round section; with the
      // current, longer section in its place it does not. Cut first and
      // upserted after, the cut lands in the old section, and the upsert takes
      // its lone start marker for a section whose end was lost: everything
      // after it is replaced, the notes that followed and the line saying the
      // notes were cut. Mistake that turns this red: fitting the agent's copy
      // before taking its old section out.
      const current = TWO_ROUNDS.replace(
        "Answer: yes, off by default",
        `Answer: yes, off by default. ${"w".repeat(10_000)}`,
      );
      const room = MEMORY_NOTEBOOK_MAX_BYTES - Buffer.byteLength(current, "utf8") - 3;
      const line = `${"n".repeat(99)}\n`;
      const before = line.repeat(Math.floor((room - 500) / line.length));
      const oldSection = ONE_ROUND.replace("Answer: vanilla", `Answer: ${"v".repeat(800)}`);
      const after = `## Notes after the decisions\n- keep this note\n${line.repeat(40)}`;
      const agentCopy = `${before}\n${oldSection}\n\n${after}`;
      // The premise: the copy is read whole, and the limit falls inside its section.
      expect(Buffer.byteLength(agentCopy, "utf8")).toBeLessThanOrEqual(MEMORY_NOTEBOOK_MAX_BYTES);
      expect(before.length).toBeLessThan(room - 100);
      expect(before.length + oldSection.length).toBeGreaterThan(room);
      fakeSandbox({
        files: { [ROOT_PATH]: `# history\n\n${current}\n`, [inCheckout]: agentCopy },
        mtimes: { [ROOT_PATH]: 1_790_000_000, [inCheckout]: 1_790_000_600 },
      });

      await persistWorkspaceMemoryStep({ ...target, workspaceManifest: promotedManifest });

      const stored = (await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content ?? "";
      expect(stored.startsWith(before)).toBe(true);
      expect(stored).toContain("## Notes after the decisions\n- keep this note\n");
      expect(stored.endsWith(`\n${MEMORY_CUT_MARKER}\n\n${current}\n`)).toBe(true);
      expect(stored.split("<!-- human-decisions:start -->")).toHaveLength(2);
      expect(stored).not.toContain("v".repeat(100));
      expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(MEMORY_NOTEBOOK_MAX_BYTES);
    });

    /** A section of exactly `bytes`, which only a clarification history of
     *  hundreds of kilobytes reaches. */
    function sectionOf(bytes: number): string {
      const head = [
        "<!-- human-decisions:start -->",
        "## Human decisions (from the dashboard)",
        "",
        "### Round 1 (answered by Ada)",
        "1. How long may an answer be?",
        "",
        "Answer: ",
      ].join("\n");
      const tail = "\n<!-- human-decisions:end -->";
      return `${head}${"a".repeat(bytes - Buffer.byteLength(head + tail, "utf8"))}${tail}`;
    }

    it("stay whole when they leave less room than a cut can use, and the notebook says the agent's notes were left out", async () => {
      const section = sectionOf(MEMORY_NOTEBOOK_MAX_BYTES - 600);
      fakeSandbox({
        files: { [ROOT_PATH]: `${section}\n`, [inCheckout]: `# notes\n${"- a note\n".repeat(120)}` },
        mtimes: { [ROOT_PATH]: 1_790_000_000, [inCheckout]: 1_790_000_600 },
      });

      await persistWorkspaceMemoryStep({ ...target, workspaceManifest: promotedManifest });

      expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(
        `${MEMORY_CUT_MARKER}\n\n${section}\n`,
      );
    });

    it("are the whole notebook when they fill the limit by themselves, rather than a section the store cuts", async () => {
      // A section read whole out of the root copy fits the limit; the blank
      // line and the newline around it may not. Stored past the limit, the
      // store would cut the end marker off and the next upsert would take the
      // rest of the notebook for the section.
      const section = sectionOf(MEMORY_NOTEBOOK_MAX_BYTES - 1);
      fakeSandbox({
        files: { [ROOT_PATH]: section, [inCheckout]: "# notes\n- this run\n" },
        mtimes: { [ROOT_PATH]: 1_790_000_000, [inCheckout]: 1_790_000_600 },
      });

      await persistWorkspaceMemoryStep({ ...target, workspaceManifest: promotedManifest });

      expect((await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH))?.content).toBe(section);
    });
  });

  it("warns with every path it checked when the agent left no notebook", async () => {
    fakeSandbox();

    const captured = await persistWorkspaceMemoryStep({
      ...target,
      workspaceManifest: promotedManifest,
    });

    const checkedPaths = [
      ROOT_PATH,
      `${PROMOTED_REPO_DIR}/${DOC_PATH}`,
      LEGACY_ROOT_PATH,
      `${PROMOTED_REPO_DIR}/${LEGACY_DOC_PATH}`,
    ];
    expect(captured.persisted).toBe(false);
    for (const path of checkedPaths) expect(captured.absent).toContain(path);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      { checkedPaths },
      "memory_document_absent",
    );
    expect(await countRows()).toBe(0);
  });

  it("never throws when the read fails", async () => {
    fakeSandbox({ readFileError: new Error("stream broke") });

    expect(await persistWorkspaceMemoryStep(target)).toEqual({ persisted: false });
    expect(await countRows()).toBe(0);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.anything(),
      "memory_document_persist_failed",
    );
  });

  it("never throws when the store rejects the write", async () => {
    mocks.db = {
      insert: () => {
        throw new Error("db down");
      },
    };
    fakeSandbox({ files: { [ROOT_PATH]: "# notes" } });

    expect(await persistWorkspaceMemoryStep(target)).toEqual({
      persisted: false,
      // S13: a capture the provider could not take is reported rather than
      // looking exactly like a run whose notebook was empty.
      unavailable: expect.stringContaining("db down"),
    });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ store: "builtin", detail: expect.stringContaining("db down") }),
      "memory_provider_unavailable",
    );
  });
});
