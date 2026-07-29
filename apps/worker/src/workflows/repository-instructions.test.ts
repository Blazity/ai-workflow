import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { WorkspaceManifest, WorkspaceRepoV2 } from "../sandbox/repo-workspace.js";
import { compileEffectivePrompt } from "./effective-prompt.js";
import {
  loadInvocationRepositoryInstructionSources,
  loadRepositoryInstructionSources,
  readRepositoryInstructionStream,
  unresolvedRepositoryInstructionSources,
} from "./repository-instructions.js";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  runCommand: vi.fn(),
  warn: vi.fn(),
  // Mutated per test. Every .ai/memory case below needs the kill switch on,
  // which is the opposite of the production default.
  env: { ENABLE_REPO_MEMORY: true },
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(async () => ({
      readFile: mocks.readFile,
      runCommand: mocks.runCommand,
    })),
  },
}));
vi.mock("../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({ teamId: "team" }),
}));
vi.mock("../lib/logger.js", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../../env.js", () => ({ env: mocks.env }));

const manifest: WorkspaceManifest = {
  version: 1,
  repositories: [{
    provider: "github",
    repoPath: "acme/service",
    slug: "acme__service",
    localPath: "/vercel/sandbox",
    defaultBranch: "main",
    branchName: "ai-workflow/AIW-124",
    selectedRationale: "Primary repository",
  }],
};

function discoveredRepo(
  provider: "github" | "gitlab",
  repoPath: string,
  slug: string,
  access: "read" | "write",
): WorkspaceRepoV2 {
  return {
    provider,
    repoPath,
    slug,
    localPath: `/vercel/sandbox/repos/${slug}`,
    defaultBranch: "main",
    branchName: "ai-workflow/AIW-147",
    selectedRationale: `discovered ${repoPath}`,
    access,
    researchBaseSha: `sha-${slug}`,
  };
}

const discoveredManifest: WorkspaceManifest = {
  version: 2,
  repositories: [
    discoveredRepo("github", "acme/service", "github__acme__service", "write"),
    discoveredRepo("gitlab", "acme/web", "gitlab__acme__web", "read"),
  ],
};

const MEMORY_DIR = "/vercel/sandbox/.ai/memory";

/** Routes the sandbox mocks by absolute path: anything absent from `files` reads
 * as missing, and anything absent from `listings` lists as a missing directory.
 * Listing values are the raw lines find prints, so a test can emit output that a
 * well-behaved find never would. */
function mockWorkspace(input: {
  files?: Record<string, string | Buffer>;
  listings?: Record<string, string[]>;
}): void {
  const files = input.files ?? {};
  const listings = input.listings ?? {};
  mocks.readFile.mockImplementation(async ({ path }: { path: string }) => {
    const content = files[path];
    if (content === undefined) return null;
    return Readable.from([
      typeof content === "string" ? Buffer.from(content, "utf8") : content,
    ]);
  });
  mocks.runCommand.mockImplementation(
    async (_command: string, args: string[]) => {
      const lines = listings[args[0]!];
      return lines === undefined
        ? { exitCode: 1, stdout: async () => "" }
        : { exitCode: 0, stdout: async () => `${lines.join("\n")}\n` };
    },
  );
}

function readPaths(): string[] {
  return mocks.readFile.mock.calls.map(
    (call) => (call[0] as { path: string }).path,
  );
}

/** The budget warning is emitted once per invocation, so its call count is part
 * of the contract and not just its arguments. */
function budgetWarnings(): unknown[] {
  return mocks.warn.mock.calls.filter(
    (call) => call[1] === "repository_memory_injection_budget_exceeded",
  );
}

const SERVICE_MEMORY = "/vercel/sandbox/repos/github__acme__service/.ai/memory";
const WEB_MEMORY = "/vercel/sandbox/repos/gitlab__acme__web/.ai/memory";

describe("repository instruction sources", () => {
  beforeEach(() => {
    mocks.readFile.mockReset();
    mocks.readFile.mockResolvedValue(null);
    mocks.runCommand.mockReset();
    mocks.runCommand.mockResolvedValue({ exitCode: 1, stdout: async () => "" });
    mocks.warn.mockReset();
    mocks.env.ENABLE_REPO_MEMORY = true;
  });

  it.each([
    { size: 256 * 1024 - 1, accepted: true },
    { size: 256 * 1024, accepted: true },
    { size: 256 * 1024 + 1, accepted: false },
  ])("bounds streamed instruction files at $size bytes", async ({ size, accepted }) => {
    const stream = Readable.from([
      Buffer.alloc(Math.floor(size / 2), "a"),
      Buffer.alloc(size - Math.floor(size / 2), "b"),
    ]);
    const result = await readRepositoryInstructionStream(stream);
    if (accepted) {
      expect(result).toHaveLength(size);
    } else {
      expect(result).toBeNull();
      expect(stream.destroyed).toBe(true);
    }
  });

  it("loads planning instructions from the authoritative code workspace", async () => {
    const load = vi.fn(async (sandboxId: string) => [
      {
        repository: "acme/service",
        path: "AGENTS.md" as const,
        content: `${sandboxId}: agent rules`,
      },
      {
        repository: "acme/service",
        path: "CLAUDE.md" as const,
        content: `${sandboxId}: claude rules`,
      },
    ]);

    const sources = await loadInvocationRepositoryInstructionSources(
      {
        nodeType: "planning_agent",
        executionSandboxId: "isolated-research",
        sharedCodeSandboxId: "code-workspace",
        manifest,
      },
      load,
    );

    expect(load).toHaveBeenCalledWith("code-workspace", manifest);
    expect(sources.map((source) => source.path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(sources.every((source) => source.content.startsWith("code-workspace")))
      .toBe(true);

    const compiled = await compileEffectivePrompt({
      nodeId: "planning",
      blockPrompt: "Plan the work.",
      runtimeData: "Ticket: AIW-124",
      profileSource: {
        profileId: "builtin-codex",
        version: 1,
        name: "Codex",
        instructions: "Use repository instructions.",
      },
      repositorySources: sources,
    });
    expect(compiled.prompt).toContain("code-workspace: agent rules");
    expect(compiled.prompt).toContain("code-workspace: claude rules");
  });

  it("does not fall back to the repository-free planning sandbox", async () => {
    const load = vi.fn();
    await expect(
      loadInvocationRepositoryInstructionSources(
        {
          nodeType: "planning_agent",
          executionSandboxId: "isolated-research",
          sharedCodeSandboxId: null,
          manifest,
        },
        load,
      ),
    ).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("accepts a discovery-promoted layout where every repository lives under repos/", async () => {
    await expect(
      loadRepositoryInstructionSources("code-workspace", discoveredManifest),
    ).resolves.toEqual([]);
  });

  it("rejects manifest paths outside their deterministic workspace location", async () => {
    const unsafe = structuredClone(manifest);
    unsafe.repositories[0]!.localPath = "/vercel/sandbox/../secrets";

    await expect(
      loadRepositoryInstructionSources("code-workspace", unsafe),
    ).rejects.toThrow("Repository instruction path is invalid");
  });

  it("rejects a repository path nested below its repos directory", async () => {
    const unsafe = structuredClone(discoveredManifest);
    unsafe.repositories[1]!.localPath =
      "/vercel/sandbox/repos/gitlab__acme__web/nested";

    await expect(
      loadRepositoryInstructionSources("code-workspace", unsafe),
    ).rejects.toThrow("Repository instruction path is invalid");
  });

  it("rejects duplicate repository paths", async () => {
    const unsafe = structuredClone(discoveredManifest);
    unsafe.repositories[0]!.localPath = "/vercel/sandbox";
    unsafe.repositories[1]!.localPath = "/vercel/sandbox";

    await expect(
      loadRepositoryInstructionSources("code-workspace", unsafe),
    ).rejects.toThrow(/duplicated/i);
  });

  it("appends .ai/memory documents after the instruction files", async () => {
    mockWorkspace({
      files: {
        "/vercel/sandbox/AGENTS.md": "agent rules",
        "/vercel/sandbox/CLAUDE.md": "claude rules",
        "/vercel/sandbox/.ai/memory/notes.md": "hand written notes",
      },
      listings: { [MEMORY_DIR]: [`${MEMORY_DIR}/notes.md`] },
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      { repository: "acme/service", path: "AGENTS.md", content: "agent rules" },
      { repository: "acme/service", path: "CLAUDE.md", content: "claude rules" },
      {
        repository: "acme/service",
        path: ".ai/memory/notes.md",
        content: "hand written notes",
      },
    ]);
  });

  it("lists only regular markdown files directly in the memory directory", async () => {
    mockWorkspace({});

    await loadRepositoryInstructionSources("code-workspace", manifest);

    // "-type f" is what excludes a symlink pointing at a secret outside the
    // repository, so pin the whole argument vector, not just the directory.
    expect(mocks.runCommand).toHaveBeenCalledWith(
      "find",
      [MEMORY_DIR, "-maxdepth", "1", "-type", "f", "-name", "*.md"],
      // The spawn carries the deadline that keeps a hung listing from failing
      // the block.
      { signal: expect.any(AbortSignal) },
    );
  });

  it("continues when a repository carries no .ai/memory directory", async () => {
    mockWorkspace({ files: { "/vercel/sandbox/CLAUDE.md": "claude rules" } });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      { repository: "acme/service", path: "CLAUDE.md", content: "claude rules" },
    ]);
    expect(readPaths()).toEqual([
      "/vercel/sandbox/AGENTS.md",
      "/vercel/sandbox/CLAUDE.md",
    ]);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("continues when the memory listing exits non-zero", async () => {
    mockWorkspace({ files: { "/vercel/sandbox/CLAUDE.md": "claude rules" } });
    mocks.runCommand.mockResolvedValue({
      exitCode: 2,
      // A failed listing's output is never consumed, not merely never read from.
      stdout: async () => {
        throw new Error("no logs");
      },
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      { repository: "acme/service", path: "CLAUDE.md", content: "claude rules" },
    ]);
    expect(readPaths()).toEqual([
      "/vercel/sandbox/AGENTS.md",
      "/vercel/sandbox/CLAUDE.md",
    ]);
    // Consuming a failed listing's output would be caught and warned rather
    // than thrown, leaving the sources and the reads above unchanged, so the
    // silent-skip contract is only pinned by asserting nothing was logged.
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("continues when the memory listing itself rejects", async () => {
    mockWorkspace({ files: { "/vercel/sandbox/CLAUDE.md": "claude rules" } });
    mocks.runCommand.mockRejectedValue(new Error("sandbox exec refused"));

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      { repository: "acme/service", path: "CLAUDE.md", content: "claude rules" },
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      { repository: "acme/service", err: "sandbox exec refused" },
      "repository_memory_listing_failed",
    );
  });

  it("continues when reading a memory document rejects", async () => {
    mockWorkspace({
      files: {
        "/vercel/sandbox/CLAUDE.md": "claude rules",
        "/vercel/sandbox/.ai/memory/readable.md": "still readable",
      },
      listings: {
        [MEMORY_DIR]: [`${MEMORY_DIR}/broken.md`, `${MEMORY_DIR}/readable.md`],
      },
    });
    const passthrough = mocks.readFile.getMockImplementation()!;
    mocks.readFile.mockImplementation(async (input: { path: string }) => {
      if (input.path === `${MEMORY_DIR}/broken.md`) {
        throw new Error("sandbox read failed");
      }
      return passthrough(input);
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      { repository: "acme/service", path: "CLAUDE.md", content: "claude rules" },
      {
        repository: "acme/service",
        path: ".ai/memory/readable.md",
        content: "still readable",
      },
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      {
        repository: "acme/service",
        name: "broken.md",
        err: "sandbox read failed",
      },
      "repository_memory_file_unreadable",
    );
  });

  it("continues when a memory read rejects with a non-error value", async () => {
    mockWorkspace({
      files: { "/vercel/sandbox/CLAUDE.md": "claude rules" },
      listings: { [MEMORY_DIR]: [`${MEMORY_DIR}/broken.md`] },
    });
    const passthrough = mocks.readFile.getMockImplementation()!;
    mocks.readFile.mockImplementation(async (input: { path: string }) => {
      // A null rejection makes (error as Error).message throw a TypeError
      // inside the catch that is reporting it.
      if (input.path === `${MEMORY_DIR}/broken.md`) return Promise.reject(null);
      return passthrough(input);
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      { repository: "acme/service", path: "CLAUDE.md", content: "claude rules" },
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      { repository: "acme/service", name: "broken.md", err: "null" },
      "repository_memory_file_unreadable",
    );
  });

  it("continues when the memory warning itself throws", async () => {
    mockWorkspace({
      files: {
        "/vercel/sandbox/CLAUDE.md": "claude rules",
        [`${MEMORY_DIR}/big.md`]: Buffer.alloc(32 * 1024 + 1, "a"),
      },
      listings: { [MEMORY_DIR]: [`${MEMORY_DIR}/big.md`] },
    });
    mocks.warn.mockImplementation(() => {
      throw new Error("logger down");
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      { repository: "acme/service", path: "CLAUDE.md", content: "claude rules" },
    ]);
  });

  it("reads a duplicated listing entry only once", async () => {
    mockWorkspace({
      files: {
        [`${MEMORY_DIR}/notes.md`]: "hand written notes",
        [`${MEMORY_DIR}/weird.md`]: "weird notes",
      },
      // A file named "weird.md\nnotes.md" prints as two lines: an accepted one
      // that repeats the real weird.md sibling, and a prefix-less remainder.
      listings: {
        [MEMORY_DIR]: [
          `${MEMORY_DIR}/weird.md`,
          `${MEMORY_DIR}/weird.md`,
          "notes.md",
          `${MEMORY_DIR}/notes.md`,
        ],
      },
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      {
        repository: "acme/service",
        path: ".ai/memory/notes.md",
        content: "hand written notes",
      },
      {
        repository: "acme/service",
        path: ".ai/memory/weird.md",
        content: "weird notes",
      },
    ]);
    expect(readPaths()).toEqual([
      "/vercel/sandbox/AGENTS.md",
      "/vercel/sandbox/CLAUDE.md",
      `${MEMORY_DIR}/notes.md`,
      `${MEMORY_DIR}/weird.md`,
    ]);
  });

  it("still fails the invocation when reading CLAUDE.md rejects", async () => {
    mockWorkspace({});
    mocks.readFile.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/vercel/sandbox/CLAUDE.md") {
        throw new Error("sandbox read failed");
      }
      return null;
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).rejects.toThrow("sandbox read failed");
  });

  it("never reads a listed entry that is not a plain markdown file name", async () => {
    mockWorkspace({
      files: { "/vercel/sandbox/.ai/memory/notes.md": "hand written notes" },
      listings: {
        [MEMORY_DIR]: [
          `${MEMORY_DIR}/notes.md`,
          `${MEMORY_DIR}/notes.txt`,
          `${MEMORY_DIR}/nested/deep.md`,
          `${MEMORY_DIR}/../escape.md`,
          "/etc/passwd.md",
          `${MEMORY_DIR}/spaced name.md`,
          // A file name holding a newline splits into a line that is not under
          // the directory prefix and a truncated one that is.
          `${MEMORY_DIR}/x`,
          "notes.md",
          // Deduplication would hide a dropped prefix check for the collision
          // above, so keep one prefix-less name with no real sibling.
          "other.md",
          "",
        ],
      },
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      {
        repository: "acme/service",
        path: ".ai/memory/notes.md",
        content: "hand written notes",
      },
    ]);
    expect(readPaths()).toEqual([
      "/vercel/sandbox/AGENTS.md",
      "/vercel/sandbox/CLAUDE.md",
      "/vercel/sandbox/.ai/memory/notes.md",
    ]);
  });

  it("reads at most ten memory documents in sorted order", async () => {
    const names = Array.from(
      { length: 12 },
      (_, index) => `doc-${String(index + 1).padStart(2, "0")}.md`,
    );
    mockWorkspace({
      files: Object.fromEntries(
        names.map((name) => [`${MEMORY_DIR}/${name}`, name]),
      ),
      listings: {
        [MEMORY_DIR]: [...names].reverse().map((name) => `${MEMORY_DIR}/${name}`),
      },
    });

    const sources = await loadRepositoryInstructionSources(
      "code-workspace",
      manifest,
    );

    expect(sources.map((source) => source.path)).toEqual(
      names.slice(0, 10).map((name) => `.ai/memory/${name}`),
    );
    expect(readPaths()).toEqual([
      "/vercel/sandbox/AGENTS.md",
      "/vercel/sandbox/CLAUDE.md",
      ...names.slice(0, 10).map((name) => `/vercel/sandbox/.ai/memory/${name}`),
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      { repository: "acme/service", skipped: 2 },
      "repository_memory_files_truncated",
    );
  });

  it("skips an oversized memory document and keeps its siblings", async () => {
    mockWorkspace({
      files: {
        "/vercel/sandbox/.ai/memory/big.md": Buffer.alloc(32 * 1024 + 1, "a"),
        "/vercel/sandbox/.ai/memory/small.md": "still readable",
      },
      listings: {
        [MEMORY_DIR]: [`${MEMORY_DIR}/big.md`, `${MEMORY_DIR}/small.md`],
      },
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      {
        repository: "acme/service",
        path: ".ai/memory/small.md",
        content: "still readable",
      },
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      { repository: "acme/service", name: "big.md" },
      "repository_memory_file_oversized",
    );
  });

  it("still fails the invocation when CLAUDE.md is oversized", async () => {
    mockWorkspace({
      files: {
        "/vercel/sandbox/CLAUDE.md": Buffer.alloc(256 * 1024 + 1, "a"),
      },
      listings: { [MEMORY_DIR]: [`${MEMORY_DIR}/notes.md`] },
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).rejects.toThrow("acme/service/CLAUDE.md exceeds the repository-instruction size limit");
  });

  it("bounds the listing parse before splitting and sorting it", async () => {
    const flood = Array.from(
      { length: 600 },
      (_, index) => `${MEMORY_DIR}/f-${String(index).padStart(4, "0")}.md`,
    );
    mockWorkspace({
      files: Object.fromEntries(flood.map((path) => [path, "flood"])),
      // f-0000.md sorts first overall but lands past the line cap, so it is only
      // absent if the cap is applied before the filter and the sort.
      listings: { [MEMORY_DIR]: [...flood].reverse() },
    });

    const sources = await loadRepositoryInstructionSources(
      "code-workspace",
      manifest,
    );

    expect(sources.map((source) => source.path)).toEqual(
      flood
        .slice(100, 110)
        .map((path) => path.replace("/vercel/sandbox/", "")),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "acme/service", lines: 601 }),
      "repository_memory_listing_truncated",
    );
  });

  it("bounds a listing that exceeds the character cap", async () => {
    mockWorkspace({
      files: { [`${MEMORY_DIR}/notes.md`]: "hand written notes" },
      listings: {
        [MEMORY_DIR]: [
          `${MEMORY_DIR}/notes.md`,
          `${MEMORY_DIR}/${"p".repeat(64 * 1024)}.md`,
        ],
      },
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", manifest),
    ).resolves.toEqual([
      {
        repository: "acme/service",
        path: ".ai/memory/notes.md",
        content: "hand written notes",
      },
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "acme/service" }),
      "repository_memory_listing_truncated",
    );
  });

  it("labels memory documents per repository", async () => {
    mockWorkspace({
      files: {
        "/vercel/sandbox/repos/github__acme__service/.ai/memory/service.md":
          "service notes",
        "/vercel/sandbox/repos/gitlab__acme__web/.ai/memory/web.md": "web notes",
      },
      listings: {
        "/vercel/sandbox/repos/github__acme__service/.ai/memory": [
          "/vercel/sandbox/repos/github__acme__service/.ai/memory/service.md",
        ],
        "/vercel/sandbox/repos/gitlab__acme__web/.ai/memory": [
          "/vercel/sandbox/repos/gitlab__acme__web/.ai/memory/web.md",
        ],
      },
    });

    await expect(
      loadRepositoryInstructionSources("code-workspace", discoveredManifest),
    ).resolves.toEqual([
      {
        repository: "acme/service",
        path: ".ai/memory/service.md",
        content: "service notes",
      },
      {
        repository: "acme/web",
        path: ".ai/memory/web.md",
        content: "web notes",
      },
    ]);
  });

  it("drops whole memory documents once the aggregate budget is spent", async () => {
    mockWorkspace({
      files: {
        // 64 KiB is the whole budget, so these two leave 768 bytes of it.
        [`${MEMORY_DIR}/a.md`]: Buffer.alloc(32 * 1024, "a"),
        [`${MEMORY_DIR}/b.md`]: Buffer.alloc(32 * 1024 - 768, "b"),
        [`${MEMORY_DIR}/c.md`]: Buffer.alloc(1000, "c"),
        [`${MEMORY_DIR}/d.md`]: "small enough for what c.md left behind",
      },
      listings: {
        [MEMORY_DIR]: ["a.md", "b.md", "c.md", "d.md"].map(
          (name) => `${MEMORY_DIR}/${name}`,
        ),
      },
    });

    const sources = await loadRepositoryInstructionSources(
      "code-workspace",
      manifest,
    );

    // c.md is dropped whole rather than cut down to the 768 bytes left.
    expect(sources.map((source) => source.path)).toEqual([
      ".ai/memory/a.md",
      ".ai/memory/b.md",
    ]);
    // d.md would still fit, so only the latch keeps it out, and a latched
    // document is never read either.
    expect(readPaths()).toEqual([
      "/vercel/sandbox/AGENTS.md",
      "/vercel/sandbox/CLAUDE.md",
      `${MEMORY_DIR}/a.md`,
      `${MEMORY_DIR}/b.md`,
      `${MEMORY_DIR}/c.md`,
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      { dropped: 2, repositories: ["acme/service"], maxBytes: 64 * 1024 },
      "repository_memory_injection_budget_exceeded",
    );
    // One warning for the whole invocation, not one per drop: an assertion on
    // the arguments alone passes on any call that matches.
    expect(budgetWarnings()).toHaveLength(1);
  });

  it("measures the memory budget in UTF-8 bytes, not characters", async () => {
    // Two bytes per character: three of these are 90000 bytes but only 45000
    // characters, so the third one survives only if the budget counts length.
    const multibyte = "é".repeat(15_000);
    const names = ["doc-1.md", "doc-2.md", "doc-3.md"];
    mockWorkspace({
      files: Object.fromEntries(
        names.map((name) => [`${MEMORY_DIR}/${name}`, multibyte]),
      ),
      listings: { [MEMORY_DIR]: names.map((name) => `${MEMORY_DIR}/${name}`) },
    });

    const sources = await loadRepositoryInstructionSources(
      "code-workspace",
      manifest,
    );

    expect(sources.map((source) => source.path)).toEqual([
      ".ai/memory/doc-1.md",
      ".ai/memory/doc-2.md",
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      { dropped: 1, repositories: ["acme/service"], maxBytes: 64 * 1024 },
      "repository_memory_injection_budget_exceeded",
    );
  });

  it("stops injecting memory for later repositories and names both", async () => {
    mockWorkspace({
      files: {
        [`${SERVICE_MEMORY}/a.md`]: Buffer.alloc(32 * 1024, "a"),
        [`${SERVICE_MEMORY}/b.md`]: Buffer.alloc(32 * 1024, "b"),
        [`${SERVICE_MEMORY}/c.md`]: "dropped by the budget",
        "/vercel/sandbox/repos/gitlab__acme__web/AGENTS.md": "web agent rules",
        "/vercel/sandbox/repos/gitlab__acme__web/CLAUDE.md": "web claude rules",
        [`${WEB_MEMORY}/web.md`]: "web notes",
      },
      listings: {
        [SERVICE_MEMORY]: ["a.md", "b.md", "c.md"].map(
          (name) => `${SERVICE_MEMORY}/${name}`,
        ),
        [WEB_MEMORY]: [`${WEB_MEMORY}/web.md`],
      },
    });

    const sources = await loadRepositoryInstructionSources(
      "code-workspace",
      discoveredManifest,
    );

    // The first repository spends the budget, so the second contributes its
    // instruction files and nothing else.
    expect(sources.map((source) => `${source.repository}/${source.path}`))
      .toEqual([
        "acme/service/.ai/memory/a.md",
        "acme/service/.ai/memory/b.md",
        "acme/web/AGENTS.md",
        "acme/web/CLAUDE.md",
      ]);
    // Still listed, so the warning can name it, and never read.
    expect(mocks.runCommand).toHaveBeenCalledTimes(2);
    expect(readPaths()).not.toContain(`${WEB_MEMORY}/web.md`);
    expect(mocks.warn).toHaveBeenCalledWith(
      {
        dropped: 2,
        repositories: ["acme/service", "acme/web"],
        maxBytes: 64 * 1024,
      },
      "repository_memory_injection_budget_exceeded",
    );
    expect(budgetWarnings()).toHaveLength(1);
  });

  it("spends one budget across repositories rather than one each", async () => {
    mockWorkspace({
      files: {
        // Exactly the whole budget, so this repository drops nothing and the
        // latch never closes. Only the running total can keep web.md out.
        [`${SERVICE_MEMORY}/a.md`]: Buffer.alloc(32 * 1024, "a"),
        [`${SERVICE_MEMORY}/b.md`]: Buffer.alloc(32 * 1024, "b"),
        [`${WEB_MEMORY}/web.md`]: Buffer.alloc(1024, "w"),
      },
      listings: {
        [SERVICE_MEMORY]: ["a.md", "b.md"].map(
          (name) => `${SERVICE_MEMORY}/${name}`,
        ),
        [WEB_MEMORY]: [`${WEB_MEMORY}/web.md`],
      },
    });

    const sources = await loadRepositoryInstructionSources(
      "code-workspace",
      discoveredManifest,
    );

    expect(sources.map((source) => `${source.repository}/${source.path}`))
      .toEqual([
        "acme/service/.ai/memory/a.md",
        "acme/service/.ai/memory/b.md",
      ]);
    // Only the second repository lost anything, which is what separates one
    // shared budget from a per-repository one.
    expect(mocks.warn).toHaveBeenCalledWith(
      { dropped: 1, repositories: ["acme/web"], maxBytes: 64 * 1024 },
      "repository_memory_injection_budget_exceeded",
    );
    expect(budgetWarnings()).toHaveLength(1);
  });

  it("skips a document larger than the whole budget without latching", async () => {
    mockWorkspace({
      files: {
        // 32 KiB of invalid UTF-8: inside the per-file read cap, and 96 KiB once
        // decoded, so it cannot fit in the 64 KiB budget under any ordering.
        [`${SERVICE_MEMORY}/a-hostile.md`]: Buffer.alloc(32 * 1024, 0xff),
        [`${SERVICE_MEMORY}/b-good.md`]: "service notes",
        [`${WEB_MEMORY}/web.md`]: "web notes",
      },
      listings: {
        [SERVICE_MEMORY]: ["a-hostile.md", "b-good.md"].map(
          (name) => `${SERVICE_MEMORY}/${name}`,
        ),
        [WEB_MEMORY]: [`${WEB_MEMORY}/web.md`],
      },
    });

    const sources = await loadRepositoryInstructionSources(
      "code-workspace",
      discoveredManifest,
    );

    // One committed file must not silence its own repository's siblings, nor
    // any other repository's memory.
    expect(sources.map((source) => `${source.repository}/${source.path}`))
      .toEqual([
        "acme/service/.ai/memory/b-good.md",
        "acme/web/.ai/memory/web.md",
      ]);
    expect(readPaths()).toContain(`${WEB_MEMORY}/web.md`);
    expect(mocks.warn).toHaveBeenCalledWith(
      { dropped: 1, repositories: ["acme/service"], maxBytes: 64 * 1024 },
      "repository_memory_injection_budget_exceeded",
    );
    expect(budgetWarnings()).toHaveLength(1);
  });

  it("keeps the instruction files outside the memory budget", async () => {
    mockWorkspace({
      files: {
        // Together twice the memory budget, and neither is over its own cap.
        "/vercel/sandbox/AGENTS.md": Buffer.alloc(64 * 1024, "a"),
        "/vercel/sandbox/CLAUDE.md": Buffer.alloc(64 * 1024, "c"),
        [`${MEMORY_DIR}/notes.md`]: "hand written notes",
      },
      listings: { [MEMORY_DIR]: [`${MEMORY_DIR}/notes.md`] },
    });

    const sources = await loadRepositoryInstructionSources(
      "code-workspace",
      manifest,
    );

    expect(sources.map((source) => source.path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      ".ai/memory/notes.md",
    ]);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("bounds a listing that never settles and skips only that repository", async () => {
    mockWorkspace({
      files: { [`${WEB_MEMORY}/web.md`]: "web notes" },
      listings: { [WEB_MEMORY]: [`${WEB_MEMORY}/web.md`] },
    });
    const passthrough = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(
      async (command: string, args: string[], opts?: unknown) => {
        // Neither resolving nor rejecting: the sandbox is reachable enough to
        // accept the request and the process never comes back.
        if (args[0] === SERVICE_MEMORY) return new Promise(() => {});
        return passthrough(command, args, opts);
      },
    );

    vi.useFakeTimers();
    try {
      const pending = loadRepositoryInstructionSources(
        "code-workspace",
        discoveredManifest,
      );
      await vi.waitFor(() => expect(mocks.runCommand).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual([
        {
          repository: "acme/web",
          path: ".ai/memory/web.md",
          content: "web notes",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.warn).toHaveBeenCalledWith(
      {
        repository: "acme/service",
        err: expect.stringContaining("exceeded 5000ms"),
      },
      "repository_memory_listing_failed",
    );
  });

  it("reads nothing under .ai/memory when repository memory is off", async () => {
    const serviceRoot = "/vercel/sandbox/repos/github__acme__service";
    const webRoot = "/vercel/sandbox/repos/gitlab__acme__web";
    mocks.env.ENABLE_REPO_MEMORY = false;
    mockWorkspace({
      files: {
        [`${serviceRoot}/AGENTS.md`]: "service agent rules",
        [`${serviceRoot}/CLAUDE.md`]: "service claude rules",
        [`${SERVICE_MEMORY}/service.md`]: "service notes",
        [`${webRoot}/AGENTS.md`]: "web agent rules",
        [`${webRoot}/CLAUDE.md`]: "web claude rules",
        [`${WEB_MEMORY}/web.md`]: "web notes",
      },
      listings: {
        [SERVICE_MEMORY]: [`${SERVICE_MEMORY}/service.md`],
        [WEB_MEMORY]: [`${WEB_MEMORY}/web.md`],
      },
    });

    // Byte for byte what this step returned before .ai/memory existed, over a
    // workspace that does carry memory documents: two instruction reads per
    // repository in manifest order, no process spawn, nothing logged. Every
    // repository is skipped past, not stopped at, so no later repository loses
    // its instruction files.
    await expect(
      loadRepositoryInstructionSources("code-workspace", discoveredManifest),
    ).resolves.toEqual([
      {
        repository: "acme/service",
        path: "AGENTS.md",
        content: "service agent rules",
      },
      {
        repository: "acme/service",
        path: "CLAUDE.md",
        content: "service claude rules",
      },
      {
        repository: "acme/web",
        path: "AGENTS.md",
        content: "web agent rules",
      },
      {
        repository: "acme/web",
        path: "CLAUDE.md",
        content: "web claude rules",
      },
    ]);
    expect(readPaths()).toEqual([
      `${serviceRoot}/AGENTS.md`,
      `${serviceRoot}/CLAUDE.md`,
      `${webRoot}/AGENTS.md`,
      `${webRoot}/CLAUDE.md`,
    ]);
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("does not report .ai/memory as an unresolved repository source", () => {
    expect(unresolvedRepositoryInstructionSources(["acme/service"])).toEqual([
      "acme/service/AGENTS.md",
      "acme/service/CLAUDE.md",
    ]);
  });
});
