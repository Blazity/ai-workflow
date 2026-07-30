import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  db: null as unknown,
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  /** Every upsert that reached the store, in order, so a case can assert the
   * version each write compared and swapped on. */
  upsertInputs: [] as Array<{
    docPath: string;
    sourceRunId: string;
    expectedVersion?: number;
  }>,
  /** Runs immediately before an upsert reaches the store. That is exactly the
   * window a racing writer has: the step has already read its version, so a
   * write landing here is one the step cannot have seen. */
  beforeUpsert: null as null | (() => Promise<void>),
  /** Makes the secret source unavailable, which is the one way redaction fails
   * and `prepareMemoryContent` answers null. */
  redactionThrows: false,
}));

vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.getSandbox } }));
vi.mock("../lib/logger.js", () => ({
  logger: {
    child: () => ({ warn: mocks.logWarn, info: mocks.logInfo }),
    warn: mocks.logWarn,
    info: mocks.logInfo,
  },
}));
vi.mock("../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../db/client.js", () => ({ getDb: () => mocks.db }));
// Passthrough by default. `prepareMemoryContent` wraps its whole redaction call,
// this one included, so failing it here is what drives the null-result branch.
vi.mock("../run-observability/configured-secrets.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../run-observability/configured-secrets.js")>();
  return {
    ...actual,
    configuredReplaySecrets: (
      ...args: Parameters<typeof actual.configuredReplaySecrets>
    ) => {
      if (mocks.redactionThrows) throw new Error("secret source unavailable");
      return actual.configuredReplaySecrets(...args);
    },
  };
});
// Passthrough by default: the compare-and-swap cases need the real store, and
// only borrow the moment just before each statement runs.
vi.mock("../memory/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../memory/store.js")>();
  return {
    ...actual,
    upsertMemoryDocument: async (
      target: Parameters<typeof actual.upsertMemoryDocument>[0],
      documentInput: Parameters<typeof actual.upsertMemoryDocument>[1],
    ) => {
      mocks.upsertInputs.push({
        docPath: documentInput.docPath,
        sourceRunId: documentInput.sourceRunId,
        expectedVersion: documentInput.expectedVersion,
      });
      if (mocks.beforeUpsert) await mocks.beforeUpsert();
      return actual.upsertMemoryDocument(target, documentInput);
    },
  };
});

import type { Db } from "../db/client.js";
import { agentMemoryDocuments } from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { repoSubjectKey } from "../lib/subject-key.js";
import {
  parseRepoMemoryDocument,
  renderRepoMemoryDocument,
  type RepoMemoryItem,
} from "../memory/repo-memory.js";
import { getMemoryDocument, upsertMemoryDocument } from "../memory/store.js";
import { WORKSPACE_MANIFEST_PATH } from "../sandbox/repo-workspace.js";
import { seedRepoMemoryStep } from "./repo-seed-steps.js";

const RUN_ID = "run_1";
const REPO_PATH = "acme/api";
const REPO_SUBJECT_KEY = repoSubjectKey("github", REPO_PATH);
const LOCAL_PATH = "/vercel/sandbox";
const DEFAULT_BRANCH = "main";
/** The label the step writes into the document header: the bare path, matching
 * the label repository instruction sections use in the same prompt. */
const DOC_SUBJECT = REPO_PATH;

const input = {
  sandboxId: "sbx-1",
  runId: RUN_ID,
  repositories: [
    { provider: "github" as const, repoPath: REPO_PATH, localPath: LOCAL_PATH },
  ],
};

let db: Db;

/**
 * The manifest the sandbox manager writes into every workspace, and the step's
 * only evidence of which ref the checkout is on. `branchName` equal to
 * `defaultBranch` is a default-branch checkout; anything else is a run working
 * on a branch, a pr_trigger checkout of a pull request head above all.
 */
function workspaceManifest(
  repositories: ReadonlyArray<{
    provider: "github" | "gitlab";
    repoPath: string;
    localPath: string;
    branchName?: string;
  }>,
): Record<string, string> {
  return {
    [WORKSPACE_MANIFEST_PATH]: JSON.stringify({
      version: 2,
      repositories: repositories.map((repository) => ({
        provider: repository.provider,
        repoPath: repository.repoPath,
        slug: "slug",
        localPath: repository.localPath,
        defaultBranch: DEFAULT_BRANCH,
        branchName: repository.branchName ?? DEFAULT_BRANCH,
        access: "write",
        selectedRationale: "",
      })),
    }),
  };
}

/** Only the paths listed exist; everything else answers null, which is how the
 * real sandbox reports a missing file. A case that does not spell out a manifest
 * of its own gets the primary repository checked out on its default branch, so
 * every case has an answer to "which ref is this". */
function fakeSandbox(
  files: Record<string, string>,
  options: { readFileError?: Error } = {},
) {
  const withManifest = {
    ...workspaceManifest([
      { provider: "github", repoPath: REPO_PATH, localPath: LOCAL_PATH },
    ]),
    ...files,
  };
  const readFile = vi.fn(async ({ path }: { path: string }) => {
    if (options.readFileError) throw options.readFileError;
    const content = withManifest[path];
    return content === undefined ? null : Readable.from([Buffer.from(content)]);
  });
  const sandbox = { readFile };
  mocks.getSandbox.mockResolvedValue(sandbox);
  return sandbox;
}

function packageJson(body: unknown): Record<string, string> {
  return { [`${LOCAL_PATH}/package.json`]: JSON.stringify(body) };
}

/** Stores a facts document from whole items, so a case can pin provenance and
 * the eviction mark rather than only the text, and can address a repository
 * other than the primary one. */
async function storeItems(
  items: readonly RepoMemoryItem[],
  target: { subjectKey: string; subject: string } = {
    subjectKey: REPO_SUBJECT_KEY,
    subject: DOC_SUBJECT,
  },
): Promise<void> {
  await upsertMemoryDocument(db, {
    subjectKey: target.subjectKey,
    docPath: "facts",
    ticketKey: null,
    content: renderRepoMemoryDocument({ subject: target.subject, kind: "facts", items }),
    sourceRunId: "run_0",
  });
}

async function storeFacts(texts: string[], runId: string | null = null): Promise<void> {
  await storeItems(texts.map((text) => ({ text, runId })));
}

/** Items, not their text: mapping to text here would make every assertion blind
 * to provenance, and provenance is what the eviction order runs on. */
async function readFacts(): Promise<RepoMemoryItem[] | null> {
  const stored = await getMemoryDocument(db, REPO_SUBJECT_KEY, "facts");
  return stored ? parseRepoMemoryDocument(stored.content) : null;
}

async function factTexts(): Promise<string[]> {
  return ((await readFacts()) ?? []).map((item) => item.text);
}

async function repoRows() {
  return (await db.select().from(agentMemoryDocuments)).filter((row) =>
    row.subjectKey.startsWith("repo:"),
  );
}

/**
 * A concurrent writer finishing between this step's read and its write: a blind
 * last-writer-wins upsert, which is what bumps the stored version out from under
 * the step. The hook is cleared for the duration so a racing write issued from
 * inside the hook cannot re-enter it.
 */
async function competingWrite(texts: string[], runId: string): Promise<void> {
  const hook = mocks.beforeUpsert;
  mocks.beforeUpsert = null;
  try {
    await upsertMemoryDocument(db, {
      subjectKey: REPO_SUBJECT_KEY,
      docPath: "facts",
      ticketKey: null,
      content: renderRepoMemoryDocument({
        subject: DOC_SUBJECT,
        kind: "facts",
        items: texts.map((text) => ({ text, runId })),
      }),
      sourceRunId: runId,
    });
  } finally {
    mocks.beforeUpsert = hook;
  }
}

/** Only the writes the step issued: the fixtures and the racing writer use other
 * run ids, and their upserts go through the same recorder. */
function stepUpserts(): typeof mocks.upsertInputs {
  return mocks.upsertInputs.filter((entry) => entry.sourceRunId === RUN_ID);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.upsertInputs = [];
  mocks.beforeUpsert = null;
  mocks.redactionThrows = false;
  db = await createTestDb();
  mocks.db = db;
});

describe("seedRepoMemoryStep", () => {
  it("does nothing without a repository", async () => {
    expect(await seedRepoMemoryStep({ ...input, repositories: [] })).toEqual({
      seeded: 0,
      pruned: 0,
    });
    expect(mocks.getSandbox).not.toHaveBeenCalled();
  });

  it("derives the manager, its scripts and the workspace marker", async () => {
    fakeSandbox({
      ...packageJson({
        scripts: {
          build: "turbo build",
          test: "vitest run",
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          check: "turbo check",
          format: "prettier --write .",
          // Not one of the six keys, so it must not produce a fact: a script
          // name out of the file may never reach stored text.
          "deploy:prod": "vercel deploy",
        },
      }),
      [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'",
      [`${LOCAL_PATH}/pnpm-workspace.yaml`]: "packages:\n  - apps/*",
    });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 1, pruned: 0 });
    // Every derived fact carries the eviction mark. Nothing else can restate one
    // once it is gone, so cap pressure has to reach model-authored prose first.
    expect(await readFacts()).toEqual([
      { text: "Package manager is pnpm.", runId: RUN_ID, pinned: true },
      { text: "Run the build with: pnpm build", runId: RUN_ID, pinned: true },
      { text: "Run tests with: pnpm test", runId: RUN_ID, pinned: true },
      { text: "Run lint with: pnpm lint", runId: RUN_ID, pinned: true },
      { text: "Run typecheck with: pnpm typecheck", runId: RUN_ID, pinned: true },
      { text: "Run check with: pnpm check", runId: RUN_ID, pinned: true },
      { text: "Run format with: pnpm format", runId: RUN_ID, pinned: true },
      { text: "This repository is a workspace monorepo.", runId: RUN_ID, pinned: true },
    ]);
    // Only the facts document, under the repo subject key. A lessons document is
    // never derived: a lesson is what a run learned, and nothing has run yet.
    const rows = await repoRows();
    expect(rows.map((row) => [row.subjectKey, row.docPath, row.ticketKey])).toEqual([
      [REPO_SUBJECT_KEY, "facts", null],
    ]);
    expect(stepUpserts()).toEqual([
      { docPath: "facts", sourceRunId: RUN_ID, expectedVersion: 0 },
    ]);
  });

  it("emits only the scripts the manifest declares", async () => {
    fakeSandbox({
      ...packageJson({ scripts: { test: "vitest run", lint: "eslint ." } }),
      [`${LOCAL_PATH}/package-lock.json`]: "{}",
    });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 1, pruned: 0 });
    expect(await factTexts()).toEqual([
      "Package manager is npm.",
      "Run tests with: npm test",
      "Run lint with: npm lint",
    ]);
  });

  it("lets the packageManager field win over the lockfile", async () => {
    fakeSandbox({
      ...packageJson({ packageManager: "yarn@4.1.0", scripts: { test: "jest" } }),
      // A lockfile can outlive the manager that wrote it, so the field the
      // repository declares is the one that decides.
      [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'",
    });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 1, pruned: 0 });
    expect(await factTexts()).toEqual([
      "Package manager is yarn.",
      "Run tests with: yarn test",
    ]);
  });

  it("falls back to the lockfile when packageManager names something unknown", async () => {
    fakeSandbox({
      ...packageJson({ packageManager: "corepack@0.31.0", scripts: { test: "jest" } }),
      [`${LOCAL_PATH}/bun.lockb`]: "binary",
    });

    // An unrecognised word must never be spliced into a command, so it counts as
    // no declaration at all rather than as a manager name.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 1, pruned: 0 });
    expect(await factTexts()).toEqual([
      "Package manager is bun.",
      "Run tests with: bun test",
    ]);
  });

  it("writes nothing when no manager can be detected", async () => {
    fakeSandbox(packageJson({ scripts: { test: "vitest run", build: "tsc" } }));

    // A script fact without a manager is a guess about how to invoke it, and the
    // workspace marker is the only fact that does not depend on one.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(await repoRows()).toHaveLength(0);
  });

  it("still records a workspace monorepo with no manager", async () => {
    fakeSandbox(packageJson({ workspaces: ["apps/*"], scripts: { test: "vitest run" } }));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 1, pruned: 0 });
    expect(await factTexts()).toEqual(["This repository is a workspace monorepo."]);
  });

  it("ignores an empty workspaces array", async () => {
    fakeSandbox({
      ...packageJson({ workspaces: [], scripts: { test: "vitest run" } }),
      [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'",
    });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 1, pruned: 0 });
    expect(await factTexts()).toEqual([
      "Package manager is pnpm.",
      "Run tests with: pnpm test",
    ]);
  });

  it("writes nothing for a malformed package.json and does not throw", async () => {
    fakeSandbox({
      [`${LOCAL_PATH}/package.json`]: "{ not json",
      [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'",
    });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(await repoRows()).toHaveLength(0);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api" }),
      "repo_memory_seed_manifest_unusable",
    );
  });

  it("writes nothing for a package.json that is not a JSON object", async () => {
    fakeSandbox({
      [`${LOCAL_PATH}/package.json`]: "[1, 2, 3]",
      [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'",
    });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(await repoRows()).toHaveLength(0);
  });

  it("writes nothing when package.json is missing and says so at info", async () => {
    fakeSandbox({ [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'" });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(await repoRows()).toHaveLength(0);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api" }),
      "repo_memory_seed_manifest_absent",
    );
    // A Go, Python, Rust or docs repository has no package.json and never will,
    // so warning about it once per run for the life of the repository would bury
    // the reading that is a real anomaly under one that never means anything.
    expect(mocks.logWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      "repo_memory_seed_manifest_unusable",
    );
  });

  it("never overwrites a facts document that already exists", async () => {
    await storeFacts(["Package manager is bun."], "run_0");
    fakeSandbox({
      ...packageJson({ scripts: { test: "vitest run" } }),
      [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'",
    });

    // Create only. A distilled document is strictly better than this derivation,
    // so the seed must not merge into it, reword it, or bump its version.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(await readFacts()).toEqual([
      { text: "Package manager is bun.", runId: "run_0" },
    ]);
    expect(stepUpserts()).toEqual([]);
  });

  it("skips the create when a racing writer takes the row first", async () => {
    fakeSandbox({
      ...packageJson({ scripts: { test: "vitest run" } }),
      [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'",
    });
    mocks.beforeUpsert = async () => {
      mocks.beforeUpsert = null;
      await storeFacts(["Distilled by an earlier run"], "run_9");
    };

    // The insert loses to the winner and is not retried: whoever got there first
    // owns the document.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(await readFacts()).toEqual([
      { text: "Distilled by an earlier run", runId: "run_9" },
    ]);
    expect(stepUpserts()).toEqual([
      { docPath: "facts", sourceRunId: RUN_ID, expectedVersion: 0 },
    ]);
  });

  it("does not store a seed redaction could not scrub", async () => {
    mocks.redactionThrows = true;
    fakeSandbox({
      ...packageJson({ scripts: { test: "vitest run" } }),
      [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'",
    });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await repoRows()).toHaveLength(0);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api" }),
      "repo_memory_seed_redaction_failed",
    );
  });

  it("returns instead of throwing when the sandbox read rejects", async () => {
    fakeSandbox({}, { readFileError: new Error("sandbox gone") });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api", err: "sandbox gone" }),
      "repo_memory_seed_repository_failed",
    );
  });

  it("returns instead of throwing when the sandbox itself is gone", async () => {
    // Outside the per-repository guard, so this is what still has to reach the
    // step's own catch: nothing here may escape a step that cannot throw.
    mocks.getSandbox.mockRejectedValue(new Error("sandbox gone"));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ step: "seedRepoMemory", err: "sandbox gone" }),
      "repo_memory_seed_failed",
    );
  });

  it("seeds a second repository after the first one has no manifest", async () => {
    const second = { provider: "gitlab" as const, repoPath: "acme/web", localPath: "/vercel/sandbox/repos/gitlab__acme__web" };
    fakeSandbox({
      [`${second.localPath}/package.json`]: JSON.stringify({ scripts: { test: "vitest" } }),
      [`${second.localPath}/yarn.lock`]: "# yarn",
    });

    // One unusable repository may not cost the rest of the manifest its seed.
    expect(
      await seedRepoMemoryStep({ ...input, repositories: [...input.repositories, second] }),
    ).toEqual({ seeded: 1, pruned: 0 });
    const stored = await getMemoryDocument(db, repoSubjectKey("gitlab", second.repoPath), "facts");
    expect(parseRepoMemoryDocument(stored?.content ?? "").map((item) => item.text)).toEqual([
      "Package manager is yarn.",
      "Run tests with: yarn test",
    ]);
  });

  it("seeds a second repository after the first one's read rejects", async () => {
    const second = { provider: "gitlab" as const, repoPath: "acme/web", localPath: "/vercel/sandbox/repos/gitlab__acme__web" };
    const files: Record<string, string> = {
      [`${second.localPath}/package.json`]: JSON.stringify({ scripts: { test: "vitest" } }),
      [`${second.localPath}/yarn.lock`]: "# yarn",
    };
    mocks.getSandbox.mockResolvedValue({
      readFile: vi.fn(async ({ path }: { path: string }) => {
        // Exactly the first repository's manifest: the second lives UNDER the
        // first one's localPath in this layout, so a prefix test would take both
        // checkouts down and the assertion below would pass for the wrong reason.
        if (path === `${LOCAL_PATH}/package.json`) throw new Error("checkout vanished");
        const content = files[path];
        return content === undefined ? null : Readable.from([Buffer.from(content)]);
      }),
    });

    // Repositories are independent here (no shared model call, no shared
    // document), so one unreadable checkout costs only its own seed. Letting it
    // unwind to the step's outer catch would silently skip every repository
    // listed after it.
    expect(
      await seedRepoMemoryStep({ ...input, repositories: [...input.repositories, second] }),
    ).toEqual({ seeded: 1, pruned: 0 });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api", err: "checkout vanished" }),
      "repo_memory_seed_repository_failed",
    );
    const stored = await getMemoryDocument(db, repoSubjectKey("gitlab", second.repoPath), "facts");
    expect(parseRepoMemoryDocument(stored?.content ?? "").map((item) => item.text)).toEqual([
      "Package manager is yarn.",
      "Run tests with: yarn test",
    ]);
  });
});

describe("seedRepoMemoryStep pruning", () => {
  it("retracts a fact naming a script that no longer exists", async () => {
    await storeFacts(
      [
        "Package manager is pnpm.",
        "Run tests with: pnpm test",
        "Run typecheck with: pnpm typecheck",
      ],
      "run_0",
    );
    fakeSandbox({
      ...packageJson({ scripts: { test: "vitest run" } }),
      [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'",
    });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 1 });
    // The survivors keep their own provenance: this run confirmed nothing, it
    // only deleted, so re-stamping them would forge a confirmation.
    expect(await readFacts()).toEqual([
      { text: "Package manager is pnpm.", runId: "run_0" },
      { text: "Run tests with: pnpm test", runId: "run_0" },
    ]);
    expect(stepUpserts()).toEqual([
      { docPath: "facts", sourceRunId: RUN_ID, expectedVersion: 1 },
    ]);
  });

  it("leaves the eviction mark on the facts it does not retract", async () => {
    await storeItems([
      { text: "Run tests with: pnpm test", runId: "run_0", pinned: true },
      { text: "Run lint with: pnpm lint", runId: "run_0", pinned: true },
    ]);
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));

    // The retraction filters items rather than rebuilding them, so a survivor
    // keeps the mark that decides what cap pressure evicts first. Losing it here
    // would quietly put derived facts back at the front of the eviction order.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 1 });
    expect(await readFacts()).toEqual([
      { text: "Run tests with: pnpm test", runId: "run_0", pinned: true },
    ]);
  });

  it("keeps a fact worded by anything other than the seed itself", async () => {
    await storeFacts([
      // Every one of these names a script the manifest no longer declares, and a
      // rule reading commands out of free text retracted all three. None is a
      // render this step emits: the "run" form, a backticked command, a bare
      // mention. Wording this rich comes from a distill, and nothing brings a
      // distilled fact back once it is gone.
      "Run lint with: npm run lint",
      "Build it with `yarn build`",
      "bun typecheck is the gate",
    ]);
    fakeSandbox(packageJson({ scripts: {} }));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual([
      "Run lint with: npm run lint",
      "Build it with `yarn build`",
      "bun typecheck is the gate",
    ]);
  });

  it("keeps a distilled fact that says more than the seed's own fact does", async () => {
    // The seed's exact wording plus something only a run could have learned.
    // The item is no longer the seed's fact, so it is not the seed's to delete.
    await storeFacts(["Run typecheck with: pnpm typecheck, after pnpm install"], "run_0");
    fakeSandbox(packageJson({ scripts: {} }));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual([
      "Run typecheck with: pnpm typecheck, after pnpm install",
    ]);
  });

  it("retracts its own fact through a spelling the format calls the same item", async () => {
    // A merge can hand a stored item back with folded spacing, a trailing period
    // or a leading bullet. Identity here is the memory format's own comparison,
    // not raw equality, so a re-spelled seed fact is still the seed's to retract
    // and does not survive as an accidental impostor of a distilled one.
    await storeFacts(["Run  lint with: pnpm lint."], "run_0");
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 1 });
    expect(await factTexts()).toEqual([]);
  });

  it("writes nothing when every stored fact survives", async () => {
    await storeFacts(["Run tests with: pnpm test"], "run_0");
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await readFacts()).toEqual([
      { text: "Run tests with: pnpm test", runId: "run_0" },
    ]);
  });

  it("keeps an item it cannot parse into a command", async () => {
    await storeFacts([
      // No manager literal at all.
      "The test suite is slow; scope it to one file.",
      // A flag between the manager and the name: which package's script this is
      // cannot be known, so absence cannot be proven.
      "Run `pnpm -C apps/worker typecheck` before pushing",
      // A manager with no name after it.
      "Everything goes through pnpm run",
    ]);
    fakeSandbox(packageJson({ scripts: {} }));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual([
      "The test suite is slow; scope it to one file.",
      "Run `pnpm -C apps/worker typecheck` before pushing",
      "Everything goes through pnpm run",
    ]);
  });

  it("keeps an item naming a word that is not one of the six scripts", async () => {
    await storeFacts([
      "Run pnpm migrate before the tests",
      "Deploy with pnpm run release",
      // A namespaced script is not one of the six keys either.
      "Run pnpm test:e2e against the demo",
      // The mixed case, and the one that decides the rule: "lint" is a known
      // script and is absent, but "migrate" cannot be proven absent, so one
      // unprovable command has to keep the whole item rather than being skipped
      // over on the way to a retraction.
      "Run pnpm migrate, then pnpm lint",
    ]);
    fakeSandbox(packageJson({ scripts: {} }));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(await factTexts()).toEqual([
      "Run pnpm migrate before the tests",
      "Deploy with pnpm run release",
      "Run pnpm test:e2e against the demo",
      "Run pnpm migrate, then pnpm lint",
    ]);
  });

  it("keeps an item mixing an unreadable invocation with an absent known script", async () => {
    await storeFacts([
      // Each of these pairs one invocation COMMAND_PATTERN refuses with one it
      // parses, and in the first two the refused half names a script the
      // manifest still declares. Judging the item on the parseable half alone
      // retracts a true fact, which is the one direction the rule forbids.
      "Run npm --prefix ./app test after pnpm build",
      "Run `pnpm --filter web test`, and pnpm lint at the root",
      "Run pnpm -C apps/worker typecheck, then pnpm build at the root",
    ]);
    // `build` and `lint` are both absent, so every parseable half is provably
    // gone and only the unreadable half holds these items in place. `test` is
    // still declared, which is what the first two would have wrongly retracted.
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual([
      "Run npm --prefix ./app test after pnpm build",
      "Run `pnpm --filter web test`, and pnpm lint at the root",
      "Run pnpm -C apps/worker typecheck, then pnpm build at the root",
    ]);
  });

  it("keeps an item while any command it names survives", async () => {
    await storeFacts(["Run pnpm lint and pnpm test before pushing"]);
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));

    // Partly true is still true enough: lint is gone, test is not, so the item
    // stays rather than taking a live command down with it.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(await factTexts()).toEqual(["Run pnpm lint and pnpm test before pushing"]);
  });

  it("keeps an item naming two commands even when both scripts are gone", async () => {
    await storeFacts(["Run pnpm lint and pnpm format before pushing"]);
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));

    // Both lint and format are absent, so a rule reading commands out of free
    // text retracted this. One sentence carrying two commands is not a shape the
    // seed renders, so whoever wrote it knew more than the derivation does.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual(["Run pnpm lint and pnpm format before pushing"]);
  });

  it("keeps every item when package.json is missing", async () => {
    await storeFacts(["Run tests with: pnpm test", "Run lint with: pnpm lint"], "run_0");
    fakeSandbox({ [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'" });

    // With no script list there is nothing to prove absence against, so a
    // repository whose manifest cannot be read keeps all of its memory.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual([
      "Run tests with: pnpm test",
      "Run lint with: pnpm lint",
    ]);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api" }),
      "repo_memory_seed_manifest_absent",
    );
  });

  it("prunes nothing on a checkout that is not the default branch", async () => {
    await storeFacts(["Run typecheck with: pnpm typecheck"], "run_0");
    fakeSandbox({
      // Exactly the reported defect: a pull request renaming typecheck to types.
      ...packageJson({ scripts: { types: "tsc --noEmit" } }),
      ...workspaceManifest([
        {
          provider: "github",
          repoPath: REPO_PATH,
          localPath: LOCAL_PATH,
          branchName: "feat/rename-typecheck",
        },
      ]),
    });

    // The pull request has not merged and may never merge, while the default
    // branch still runs typecheck. Retracting here deletes a true fact that only
    // a distill could ever restore, and the distill prompt will not restate what
    // the document already claims to know.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual(["Run typecheck with: pnpm typecheck"]);
    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api" }),
      "repo_memory_prune_skipped_off_default_branch",
    );
  });

  it("still seeds on a checkout that is not the default branch", async () => {
    fakeSandbox({
      ...packageJson({ scripts: { test: "vitest run" } }),
      [`${LOCAL_PATH}/pnpm-lock.yaml`]: "lockfileVersion: '9.0'",
      ...workspaceManifest([
        {
          provider: "github",
          repoPath: REPO_PATH,
          localPath: LOCAL_PATH,
          branchName: "feat/rename-typecheck",
        },
      ]),
    });

    // The gate covers retraction only: a document that does not exist yet has
    // nothing to lose, so a repository still gets its head start off a branch.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 1, pruned: 0 });
    expect(await factTexts()).toEqual([
      "Package manager is pnpm.",
      "Run tests with: pnpm test",
    ]);
  });

  it("still prunes a repository on its default branch beside one that is not", async () => {
    const second = {
      provider: "gitlab" as const,
      repoPath: "acme/web",
      localPath: "/vercel/sandbox/repos/gitlab__acme__web",
    };
    await storeFacts(["Run lint with: pnpm lint"], "run_0");
    await storeItems([{ text: "Run lint with: pnpm lint", runId: "run_0" }], {
      subjectKey: repoSubjectKey("gitlab", second.repoPath),
      subject: second.repoPath,
    });
    fakeSandbox({
      ...packageJson({ scripts: { test: "vitest run" } }),
      [`${second.localPath}/package.json`]: JSON.stringify({ scripts: { test: "vitest" } }),
      ...workspaceManifest([
        {
          provider: "github",
          repoPath: REPO_PATH,
          localPath: LOCAL_PATH,
          branchName: "feat/rename-typecheck",
        },
        { provider: "gitlab", repoPath: second.repoPath, localPath: second.localPath },
      ]),
    });

    // The gate is per repository, not per workspace. A read-access dependency is
    // checked out on its default branch even on a pr_trigger run, so that
    // checkout is still the ref that defines it and lint really is gone there.
    expect(
      await seedRepoMemoryStep({ ...input, repositories: [...input.repositories, second] }),
    ).toEqual({ seeded: 0, pruned: 1 });
    expect(await factTexts()).toEqual(["Run lint with: pnpm lint"]);
    const stored = await getMemoryDocument(db, repoSubjectKey("gitlab", second.repoPath), "facts");
    expect(parseRepoMemoryDocument(stored?.content ?? "")).toEqual([]);
  });

  it("prunes nothing for a repository the workspace manifest does not cover", async () => {
    await storeFacts(["Run lint with: pnpm lint"], "run_0");
    fakeSandbox({
      ...packageJson({ scripts: { test: "vitest run" } }),
      ...workspaceManifest([
        {
          provider: "gitlab",
          repoPath: "acme/web",
          localPath: "/vercel/sandbox/repos/gitlab__acme__web",
        },
      ]),
    });

    // No entry means no evidence of which ref this checkout is on, and an
    // unidentified ref is not one to retract durable memory from.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual(["Run lint with: pnpm lint"]);
  });

  it("prunes nothing when the workspace manifest cannot be read", async () => {
    await storeFacts(["Run lint with: pnpm lint"], "run_0");
    fakeSandbox({
      ...packageJson({ scripts: { test: "vitest run" } }),
      [WORKSPACE_MANIFEST_PATH]: "{ not the manifest",
    });

    // Fail closed, and loudly: the manager writes this file before any block
    // runs, so a workspace without a readable one is an anomaly, unlike a
    // repository that simply has no package.json.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual(["Run lint with: pnpm lint"]);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(String) }),
      "repo_memory_seed_workspace_manifest_unreadable",
    );
  });

  it.each([
    ["a string", "build"],
    ["a number", 5],
    ["an array", []],
  ])("keeps every item when scripts is %s", async (_label, malformed) => {
    await storeFacts(["Run tests with: pnpm test", "Run lint with: pnpm lint"], "run_0");
    fakeSandbox(packageJson({ scripts: malformed }));

    // A MISSING scripts key means the repository declares none and retracting
    // against it is correct. A present but malformed one is a manifest that
    // could not be read, and reading it as an empty set would infer absence
    // from a parse failure and delete every command fact in the document.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual([
      "Run tests with: pnpm test",
      "Run lint with: pnpm lint",
    ]);
  });

  it("still retracts when scripts is missing entirely", async () => {
    await storeFacts(["Run lint with: pnpm lint"], "run_0");
    fakeSandbox(packageJson({ name: "acme-api" }));

    // The other half of the rule above: no scripts key is a readable manifest
    // that declares nothing, so absence really is proven here.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 1 });
    expect(await factTexts()).toEqual([]);
  });

  it("keeps every item when package.json is unparseable", async () => {
    await storeFacts(["Run tests with: pnpm test"], "run_0");
    fakeSandbox({ [`${LOCAL_PATH}/package.json`]: "{ scripts: " });

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual(["Run tests with: pnpm test"]);
    // Present and unreadable, which is the anomaly the warn is for, and the one
    // an absent file must not be able to drown out.
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api" }),
      "repo_memory_seed_manifest_unusable",
    );
    expect(mocks.logInfo).not.toHaveBeenCalledWith(
      expect.anything(),
      "repo_memory_seed_manifest_absent",
    );
  });

  it("keeps every item when the manifest is larger than the read cap", async () => {
    await storeFacts(["Run tests with: pnpm test"], "run_0");
    // Valid JSON, but past the bound, so it is read as unusable rather than
    // parsed from its head. A truncated manifest would look like it declares no
    // scripts at all and would retract every true fact in the document.
    fakeSandbox(packageJson({ scripts: {}, filler: "x".repeat(32 * 1024) }));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual(["Run tests with: pnpm test"]);
    // Present, so it is unusable rather than absent.
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api" }),
      "repo_memory_seed_manifest_unusable",
    );
  });

  it("does not store a pruned document that no longer fits the cap", async () => {
    // Past the 12 KiB document cap the distill step renders against, so the
    // survivors come back truncated. The cut lands wherever redaction leaves it,
    // most often inside a bullet or its provenance comment, and a mangled
    // document is worse than a stale one.
    const bulky = Array.from({ length: 80 }, (_, index) => `${"f".repeat(180)} ${index}`);
    await storeFacts(["Run lint with: pnpm lint", ...bulky], "run_0");
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect((await readFacts()) ?? []).toHaveLength(bulky.length + 1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api" }),
      "repo_memory_prune_truncated_skipped",
    );
  });

  it("recomputes survivors against a racing writer's fresh items", async () => {
    await storeFacts(["Run tests with: pnpm test", "Run lint with: pnpm lint"], "run_0");
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));
    mocks.beforeUpsert = async () => {
      mocks.beforeUpsert = null;
      // A distill that landed after this step read: it added a fact, and
      // re-issuing the bytes rendered against the old document would delete it.
      await competingWrite(
        ["Run tests with: pnpm test", "Run lint with: pnpm lint", "CI runs on Actions"],
        "run_9",
      );
    };

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 1 });
    expect(await readFacts()).toEqual([
      { text: "Run tests with: pnpm test", runId: "run_9" },
      { text: "CI runs on Actions", runId: "run_9" },
    ]);
    // Version 1 was what this step read; version 2 is what the racing writer left.
    expect(stepUpserts().map((entry) => entry.expectedVersion)).toEqual([1, 2]);
    expect(mocks.logWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      "repo_memory_prune_contended",
    );
  });

  it("gives up after three contended attempts without throwing", async () => {
    await storeFacts(["Run lint with: pnpm lint"], "run_0");
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));
    let round = 0;
    // A racing write before every one of this step's attempts, so no swap can
    // ever match the version it was rendered against.
    mocks.beforeUpsert = async () => {
      round += 1;
      await competingWrite(["Run lint with: pnpm lint", `winner ${round}`], "run_9");
    };

    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    // Three attempts and no more: an unbounded loop would spin against a hot
    // repository for as long as the runs keep coming.
    expect(stepUpserts().map((entry) => entry.expectedVersion)).toEqual([1, 2, 3]);
    expect(await factTexts()).toEqual(["Run lint with: pnpm lint", "winner 3"]);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api", attempts: 3 }),
      "repo_memory_prune_contended",
    );
  });

  it("stops when the row it read has been deleted", async () => {
    await storeFacts(["Run lint with: pnpm lint"], "run_0");
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));
    mocks.beforeUpsert = async () => {
      mocks.beforeUpsert = null;
      await db.delete(agentMemoryDocuments);
    };

    // The re-read finds nothing, so there is nothing left to prune and this step
    // must not resurrect a document a delete removed.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts().map((entry) => entry.expectedVersion)).toEqual([1]);
    expect(await repoRows()).toHaveLength(0);
  });

  it("does not store a pruned document redaction could not scrub", async () => {
    await storeFacts(["Run lint with: pnpm lint"], "run_0");
    fakeSandbox(packageJson({ scripts: { test: "vitest run" } }));
    mocks.redactionThrows = true;

    // Fail closed: unscrubbed text never reaches the store, and the stored
    // document keeps the stale item rather than being rewritten from a null.
    expect(await seedRepoMemoryStep(input)).toEqual({ seeded: 0, pruned: 0 });
    expect(stepUpserts()).toEqual([]);
    expect(await factTexts()).toEqual(["Run lint with: pnpm lint"]);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "github:acme/api" }),
      "repo_memory_prune_redaction_failed",
    );
  });
});
