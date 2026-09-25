/**
 * CHARACTERIZATION: what the deterministic seed derives from a checkout and
 * what it asks memory to store or forget, before 6a moves its write half and
 * 6b widens it to package roots, per-package scripts and `bun.lock`.
 *
 * The provider is the recording fake, so these tests pin the step's requests;
 * the built-in store's create-only and pin handling are pinned beside it. The
 * checkout is a map of files a fake sandbox streams back.
 */
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeMemory: vi.fn(),
  getSandbox: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.getSandbox } }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../support/memory-runtime.js", () => ({ activeMemory: mocks.activeMemory }));
vi.mock("../../infra/logger.js", () => ({
  logger: {
    child: () => ({ warn: mocks.logWarn, info: mocks.logInfo }),
    warn: mocks.logWarn,
    info: mocks.logInfo,
  },
}));

import {
  fakeActiveMemory,
  fakeMemoryAddress,
  type FakeActiveMemory,
} from "../../test-support/fake-active-memory.js";
import { seedRepoMemoryStep } from "./repo-seed-steps.js";

const ROOT = "/vercel/sandbox";
const FACTS_ADDRESS = fakeMemoryAddress("repo:github:acme/api", { kind: "facts" });

let fake: FakeActiveMemory;
/** Every path the step asked the sandbox for, in order. */
let readPaths: string[];

function checkout(files: Record<string, string>): void {
  readPaths = [];
  mocks.getSandbox.mockResolvedValue({
    readFile: vi.fn(async ({ path }: { path: string }) => {
      readPaths.push(path);
      const content = files[path];
      return content === undefined ? null : Readable.from([Buffer.from(content)]);
    }),
  });
}

function packageJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function seed(
  held: string[] | null,
  branch: { branchName?: string; workflowOwnedBranch?: string | null } = {},
) {
  fake = fakeActiveMemory(held === null ? {} : { [FACTS_ADDRESS]: { entries: held } });
  mocks.activeMemory.mockResolvedValue(fake.memory);
  return seedRepoMemoryStep({
    sandboxId: "sbx-1",
    runId: "run_1",
    repositories: [
      {
        provider: "github",
        repoPath: "acme/api",
        localPath: ROOT,
        branchName: branch.branchName ?? "main",
        defaultBranch: "main",
        workflowOwnedBranch: branch.workflowOwnedBranch ?? null,
      },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("what the seed derives on a repository with no facts stored", () => {
  it("writes the manager, one fact per known script in a fixed order, and the monorepo marker, derived and create-only", async () => {
    checkout({
      [`${ROOT}/package.json`]: packageJson({
        workspaces: ["packages/*"],
        scripts: {
          dev: "next dev",
          format: "prettier -w .",
          check: "biome check",
          typecheck: "tsc",
          lint: "eslint .",
          test: "vitest",
          build: "next build",
          "test:e2e": "playwright test",
        },
      }),
      [`${ROOT}/pnpm-lock.yaml`]: "lockfileVersion: 9",
    });

    const result = await seed(null);

    expect(fake.observations).toEqual([
      {
        subject: { key: "repo:github:acme/api", label: "acme/api" },
        scope: { kind: "facts" },
        runId: "run_1",
        ticketKey: null,
        observation: {
          kind: "items",
          learned: [
            "Package manager is pnpm.",
            "Run the build with: pnpm build",
            "Run tests with: pnpm test",
            "Run lint with: pnpm lint",
            "Run typecheck with: pnpm typecheck",
            "Run check with: pnpm check",
            "Run format with: pnpm format",
            "This repository is a workspace monorepo.",
          ],
          refuted: [],
          derived: true,
          onlyIfEmpty: true,
        },
      },
    ]);
    expect(result).toEqual({ seeded: 1, pruned: 0 });
  });

  it("takes the packageManager field over any lockfile, and otherwise the first lockfile of pnpm, npm, yarn, bun.lockb", async () => {
    checkout({
      [`${ROOT}/package.json`]: packageJson({ packageManager: "yarn@4.1.0", scripts: { test: "x" } }),
      [`${ROOT}/pnpm-lock.yaml`]: "",
    });
    await seed(null);
    expect(fake.observations[0]?.observation).toMatchObject({
      learned: ["Package manager is yarn.", "Run tests with: yarn test"],
    });

    checkout({
      [`${ROOT}/package.json`]: packageJson({ scripts: { test: "x" } }),
      [`${ROOT}/yarn.lock`]: "",
      [`${ROOT}/package-lock.json`]: "{}",
    });
    await seed(null);
    expect(fake.observations[0]?.observation).toMatchObject({
      learned: ["Package manager is npm.", "Run tests with: npm test"],
    });
  });

  it("changes in 6b: a text bun.lock names no manager, so no command is seeded at all", async () => {
    checkout({
      [`${ROOT}/package.json`]: packageJson({ scripts: { test: "bun test" } }),
      [`${ROOT}/bun.lock`]: "{}",
    });

    const result = await seed(null);

    expect(fake.observations).toEqual([]);
    expect(result).toEqual({ seeded: 0, pruned: 0 });
  });

  it("changes in 6b: reads only the root package.json, never a workspace package's", async () => {
    checkout({
      [`${ROOT}/package.json`]: packageJson({ workspaces: ["packages/*"] }),
      [`${ROOT}/pnpm-lock.yaml`]: "",
      [`${ROOT}/packages/api/package.json`]: packageJson({ scripts: { test: "vitest" } }),
    });

    await seed(null);

    expect(fake.observations[0]?.observation).toMatchObject({
      learned: ["Package manager is pnpm.", "This repository is a workspace monorepo."],
    });
    expect(readPaths.filter((path) => path.includes("/packages/"))).toEqual([]);
  });
});

describe("what the seed does where facts are already stored", () => {
  const held = [
    "Run lint with: pnpm lint",
    "Run tests with: npm test",
    "Run the linter with pnpm lint",
    "Package manager is pnpm.",
  ];
  const manifest = { [`${ROOT}/package.json`]: packageJson({ scripts: { test: "vitest" } }) };

  it("on the default branch, refutes only its own rendering of a script the manifest no longer declares", async () => {
    // "Run tests with: npm test" is the seed's own spelling under another
    // manager, and test is still declared, so it stays. "Run the linter with
    // pnpm lint" was worded by a model, so it is not the seed's to judge.
    checkout(manifest);

    const result = await seed(held);

    expect(fake.observations).toEqual([
      {
        subject: { key: "repo:github:acme/api", label: "acme/api" },
        scope: { kind: "facts" },
        runId: "run_1",
        ticketKey: null,
        observation: { kind: "items", learned: [], refuted: ["Run lint with: pnpm lint"], derived: true },
      },
    ]);
    expect(result).toEqual({ seeded: 0, pruned: 1 });
  });

  it("refutes nothing from a checkout of another branch, or of the default branch under a workflow-owned branch", async () => {
    checkout(manifest);
    await seed(held, { branchName: "ai/aiw-1" });
    expect(fake.observations).toEqual([]);

    checkout(manifest);
    await seed(held, { workflowOwnedBranch: "ai/aiw-1" });
    expect(fake.observations).toEqual([]);
  });

  it("changes in 6a: resolves memory once per step, with no run pins", async () => {
    checkout(manifest);

    await seed(held);

    expect(mocks.activeMemory).toHaveBeenCalledTimes(1);
    expect(mocks.activeMemory).toHaveBeenCalledWith();
  });
});
