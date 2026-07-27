import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  db: null as unknown,
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: { get: mocks.getSandbox },
}));
vi.mock("../lib/logger.js", () => ({
  logger: {
    child: () => ({ warn: mocks.logWarn, info: mocks.logInfo }),
    warn: mocks.logWarn,
    info: mocks.logInfo,
  },
}));
vi.mock("../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({}),
}));
vi.mock("../db/client.js", () => ({ getDb: () => mocks.db }));

import type { Db } from "../db/client.js";
import { agentMemoryDocuments } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import {
  MAX_MEMORY_DOCUMENT_BYTES,
  getMemoryDocument,
  upsertMemoryDocument,
} from "../memory/store.js";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import {
  hydrateWorkspaceMemoryStep,
  persistWorkspaceMemoryStep,
} from "./memory-steps.js";

const SUBJECT_KEY = "ticket:jira:AIW-200";
const TASK_ID = "AIW-200";
const DOC_PATH = "blazebot/memory/AIW-200.md";
/** The agent's cwd, which is where it reads and writes the document. */
const ROOT_PATH = "/vercel/sandbox/blazebot/memory/AIW-200.md";
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
} = {}) {
  const runCommand = vi.fn(async (command: string, args: string[]) => {
    if (command === "git" && args.includes("ls-files")) {
      return commandResult(options.lsFilesExitCode ?? 0, options.lsFiles ?? "");
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

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  mocks.db = db;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hydrateWorkspaceMemoryStep", () => {
  it("writes the stored document to the agent cwd", async () => {
    await storeDocument("# stored notes\nzażółć");
    const sandbox = fakeSandbox();

    expect(await hydrateWorkspaceMemoryStep(target)).toEqual({
      source: "db",
      trackedInRepo: false,
      written: true,
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith("mkdir", [
      "-p",
      "/vercel/sandbox/blazebot/memory",
    ]);
    expect(sandbox.writeFiles).toHaveBeenCalledWith([
      { path: ROOT_PATH, content: Buffer.from("# stored notes\nzażółć") },
    ]);
  });

  it("creates the nested directory a PR-trigger document needs", async () => {
    const prTaskId = "pr:github:acme/app#7";
    const prDocPath = `blazebot/memory/${prTaskId}.md`;
    await storeDocument("# pr notes", prDocPath);
    const sandbox = fakeSandbox();

    expect(
      await hydrateWorkspaceMemoryStep({ ...target, taskId: prTaskId, ticketKey: null }),
    ).toEqual({ source: "db", trackedInRepo: false, written: true });
    expect(sandbox.runCommand).toHaveBeenCalledWith("mkdir", [
      "-p",
      "/vercel/sandbox/blazebot/memory/pr:github:acme",
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
    ).toEqual({ source: "db", trackedInRepo: false, written: true });
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
    });
    const stored = await getMemoryDocument(db, SUBJECT_KEY, DOC_PATH);
    expect(stored?.content).toBe("# legacy notes");
    expect(stored?.sourceRunId).toBe("run_1");
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
    ).toEqual({ source: "repo", trackedInRepo: false, written: false });
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

  it("skips a missing or empty document", async () => {
    fakeSandbox({ files: { [ROOT_PATH]: "   \n" } });
    expect(await persistWorkspaceMemoryStep(target)).toEqual({ persisted: false });

    fakeSandbox();
    expect(await persistWorkspaceMemoryStep(target)).toEqual({ persisted: false });
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

    expect(await persistWorkspaceMemoryStep(target)).toEqual({ persisted: false });
  });
});
