import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "../../sandbox/repo-workspace.js";
import { RunBudgetError } from "../run-budget.js";

const mocks = vi.hoisted(() => ({
  sandboxGet: vi.fn(),
  generateStructured: vi.fn(),
  configuredReplaySecrets: vi.fn(() => [] as string[]),
  warn: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../../lib/llm.js", () => ({ generateStructured: mocks.generateStructured }));
vi.mock("../../lib/logger.js", () => ({
  logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../run-observability/configured-secrets.js", () => ({
  configuredReplaySecrets: mocks.configuredReplaySecrets,
}));

import { execute, paramsSchema } from "./leak-review.js";
import { expectOutputConformsToRegistry, makeCtx, makeNode } from "./test-support.js";

const ANTHROPIC_SECRET = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const GITHUB_SECRET = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;

interface RepoInput {
  repoPath: string;
  localPath: string;
  access: "read" | "write";
  preAgentSha?: string;
}

function manifest(repositories: RepoInput[]): WorkspaceManifest {
  return {
    version: 2,
    repositories: repositories.map((repo) => ({
      provider: "github",
      repoPath: repo.repoPath,
      slug: repo.repoPath.replace("/", "__"),
      localPath: repo.localPath,
      defaultBranch: "main",
      branchName: "blazebot/awt-1",
      selectedRationale: "selected",
      access: repo.access,
      ...(repo.preAgentSha === undefined ? {} : { preAgentSha: repo.preAgentSha }),
    })),
  };
}

interface GitState {
  head: string;
  stat?: string;
  log?: string;
  diff?: string;
}

function ok(stdout: string) {
  return { exitCode: 0, stdout: async () => stdout, stderr: async () => "" };
}

function sandboxWithGit(states: Record<string, GitState>) {
  return {
    runCommand: vi.fn(async (command: string, args: string[]) => {
      const state = states[args[1]!];
      if (command !== "git" || !state) {
        return { exitCode: 1, stdout: async () => "", stderr: async () => "missing" };
      }
      if (args[2] === "rev-parse") return ok(`${state.head}\n`);
      if (args[2] === "log") return ok(state.log ?? "");
      if (args[2] === "diff" && args[3] === "--stat") return ok(state.stat ?? "");
      if (args[2] === "diff") return ok(state.diff ?? "");
      return { exitCode: 1, stdout: async () => "", stderr: async () => "unexpected" };
    }),
  };
}

function singleRepoCtx(state: GitState) {
  mocks.sandboxGet.mockResolvedValue(sandboxWithGit({ "/vercel/sandbox": state }));
  return makeCtx({
    workspaceManifest: manifest([
      { repoPath: "acme/api", localPath: "/vercel/sandbox", access: "write", preAgentSha: "base" },
    ]),
  });
}

function twoWriteRepoCtx(first: GitState, second: GitState) {
  mocks.sandboxGet.mockResolvedValue(
    sandboxWithGit({
      "/vercel/sandbox": first,
      "/vercel/sandbox/repos/github__acme__web": second,
    }),
  );
  return makeCtx({
    workspaceManifest: manifest([
      { repoPath: "acme/api", localPath: "/vercel/sandbox", access: "write", preAgentSha: "base" },
      {
        repoPath: "acme/web",
        localPath: "/vercel/sandbox/repos/github__acme__web",
        access: "write",
        preAgentSha: "web-base",
      },
    ]),
  });
}

function cleanScan(summary = "No sensitive data found.") {
  mocks.generateStructured.mockResolvedValue({
    object: { findings: [], summary },
    text: "",
    usage: { inputTokens: 10, outputTokens: 4, cachedTokens: 2 },
  });
}

describe("leak_review paramsSchema", () => {
  it("accepts the authored params and rejects unknown or out-of-range values", () => {
    expect(paramsSchema.safeParse({}).success).toBe(true);
    expect(
      paramsSchema.safeParse({ model: "claude-haiku-4-5", llmScan: false, maxDiffBytes: 4096 })
        .success,
    ).toBe(true);
    expect(paramsSchema.safeParse({ llmScan: "false" }).success).toBe(false);
    expect(paramsSchema.safeParse({ maxDiffBytes: 0 }).success).toBe(false);
    expect(paramsSchema.safeParse({ maxDiffBytes: 262_145 }).success).toBe(false);
    expect(paramsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("leak_review execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.configuredReplaySecrets.mockReturnValue([]);
  });

  it("reports ok for a clean diff and screens it with the LLM once", async () => {
    cleanScan();
    const ctx = singleRepoCtx({
      head: "head1",
      stat: " src/app.ts | 2 +-\n",
      log: "feat: add a counter\n",
      diff: "+++ b/src/app.ts\n+const answer = 42;\n",
    });

    const result = await execute(makeNode("leak_review", {}, "leak"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(result.output!.status).toBe("ok");
    expect(result.output!.findings).toEqual([]);
    expect(result.output!.truncated).toBe(false);
    expect(result.output!.diffStat).toContain("src/app.ts");
    expect(result.output!.summary).toContain("No sensitive data found.");
    expect(mocks.generateStructured).toHaveBeenCalledTimes(1);
    expect(mocks.generateStructured.mock.calls[0]![0]).toMatchObject({
      provider: "claude",
      model: "claude-haiku-4-5",
    });
    expect(ctx.markLaunched).toHaveBeenCalledWith("Leak review leak");
    expect(ctx.recordUsage).toHaveBeenCalledWith(
      "Leak review leak",
      expect.objectContaining({
        cost_usd: null,
        tokens: { input: 10, cached_input: 2, output: 4 },
      }),
      "claude-haiku-4-5",
    );
    expectOutputConformsToRegistry("leak_review", result.output!);
  });

  it("fails before any LLM call when the diff carries a high-confidence secret", async () => {
    cleanScan();
    const ctx = singleRepoCtx({
      head: "head1",
      log: "feat: wire the client\n",
      diff: `+++ b/src/config.ts\n+const key = "${ANTHROPIC_SECRET}";\n`,
    });

    const result = await execute(makeNode("leak_review", {}, "leak"), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") return;
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(result.error.category).toBe("checks");
    expect(result.error.message).toContain("sk-ant-a****");
    expect(result.error.message).toContain("anthropic_api_key");
    expect(result.error.message).toContain("src/config.ts");
    expect(result.error.message).not.toContain(ANTHROPIC_SECRET);
    expect(result.error.detail).not.toContain(ANTHROPIC_SECRET);
  });

  it("only judges added diff lines", async () => {
    cleanScan();
    const ctx = singleRepoCtx({
      head: "head1",
      log: "chore: drop the old key\n",
      diff:
        "+++ b/src/config.ts\n" +
        `-const key = "${ANTHROPIC_SECRET}";\n` +
        ` const other = "${ANTHROPIC_SECRET}";\n`,
    });

    const passes = await execute(makeNode("leak_review"), {}, ctx);

    expect(passes.kind).toBe("next");
    expect(passes.output!.status).toBe("ok");

    vi.clearAllMocks();
    mocks.configuredReplaySecrets.mockReturnValue([]);
    cleanScan();
    const added = await execute(
      makeNode("leak_review"),
      {},
      singleRepoCtx({
        head: "head1",
        log: "chore: add the key\n",
        diff: `+++ b/src/config.ts\n+const key = "${ANTHROPIC_SECRET}";\n`,
      }),
    );

    expect(added.kind).toBe("execution_error");
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it("scans an added line whose own content starts with plus signs", async () => {
    cleanScan();
    const ctx = singleRepoCtx({
      head: "head1",
      log: "feat: bump the counter\n",
      // The added line's content is `++const key = "..."`, so git renders it
      // with the added-line marker as `+++const key = ...`.
      diff: `+++ b/src/config.ts\n+++const key = "${ANTHROPIC_SECRET}";\n`,
    });

    const result = await execute(makeNode("leak_review"), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") return;
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(result.error.message).toContain("sk-ant-a****");
    expect(result.error.message).not.toContain(ANTHROPIC_SECRET);
  });

  it("scans past the LLM byte cap so a secret in the tail still fails", async () => {
    cleanScan();
    const ctx = singleRepoCtx({
      head: "head1",
      log: "feat: bulk change\n",
      diff:
        "+++ b/src/big.ts\n" +
        "+const filler = 1;\n".repeat(100) +
        `+const key = "${ANTHROPIC_SECRET}";\n`,
    });

    const result = await execute(makeNode("leak_review", { maxDiffBytes: 200 }), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") return;
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(result.error.message).toContain("sk-ant-a****");
    expect(result.error.message).not.toContain(ANTHROPIC_SECRET);
  });

  it("scans every write repository even after the LLM byte budget is spent", async () => {
    cleanScan();
    const ctx = twoWriteRepoCtx(
      {
        head: "head1",
        log: "feat: bulk change\n",
        diff: "+++ b/src/big.ts\n" + "+const filler = 1;\n".repeat(100),
      },
      {
        head: "web-head",
        log: "feat: add the client\n",
        diff: `+++ b/src/web.ts\n+const key = "${ANTHROPIC_SECRET}";\n`,
      },
    );

    const result = await execute(makeNode("leak_review", { maxDiffBytes: 100 }), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") return;
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(result.error.message).toContain("acme/web:src/web.ts");
    expect(result.error.message).not.toContain(ANTHROPIC_SECRET);
  });

  it("fails when a configured environment secret appears in the diff", async () => {
    mocks.configuredReplaySecrets.mockReturnValue(["hunter2-configured-secret"]);
    const ctx = singleRepoCtx({
      head: "head1",
      log: "chore: add config\n",
      diff: '+++ b/.env.example\n+TOKEN="hunter2-configured-secret"\n',
    });

    const result = await execute(makeNode("leak_review"), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") return;
    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(result.error.message).toContain("configured_environment_secret");
    expect(result.error.message).toContain("hunter2-****");
    expect(result.error.message).not.toContain("hunter2-configured-secret");
  });

  it("keeps most of a short configured secret out of the failure message", async () => {
    mocks.configuredReplaySecrets.mockReturnValue(["abcd1234"]);
    const ctx = singleRepoCtx({
      head: "head1",
      log: "chore: add config\n",
      diff: '+++ b/src/config.ts\n+const token = "abcd1234";\n',
    });

    const result = await execute(makeNode("leak_review"), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") return;
    expect(result.error.message).toContain("ab****");
    expect(result.error.message).not.toContain("abcd1234");
    expect(result.error.message).not.toContain("abc****");
    expect(result.error.detail).not.toContain("abcd1234");
  });

  it("fails when the secret is only in a commit message", async () => {
    const ctx = singleRepoCtx({
      head: "head1",
      log: `fix: rotate token\n\nold token was ${GITHUB_SECRET}\n`,
      diff: "+++ b/src/app.ts\n+const answer = 42;\n",
    });

    const result = await execute(makeNode("leak_review"), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") return;
    expect(result.error.message).toContain("github_token");
    expect(result.error.message).toContain("commit messages");
    expect(result.error.message).not.toContain(GITHUB_SECRET);
  });

  it("reports LLM findings as a flagged output and keeps the run going", async () => {
    mocks.generateStructured.mockResolvedValue({
      object: {
        findings: [
          {
            kind: "client_name",
            severity: "medium",
            file: "src/app.ts",
            excerpt: "Northwind Traders",
            reason: "Names a private client engagement.",
          },
        ],
        summary: "One client name found.",
      },
      text: "",
      usage: null,
    });
    const ctx = singleRepoCtx({
      head: "head1",
      log: "feat: onboarding\n",
      diff: "+++ b/src/app.ts\n+// for Northwind Traders\n",
    });

    const result = await execute(makeNode("leak_review", {}, "leak"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(result.output!.status).toBe("flagged");
    expect(result.output!.findings).toEqual([
      {
        kind: "client_name",
        severity: "medium",
        file: "src/app.ts",
        excerpt: "Northwind Traders",
        reason: "Names a private client engagement.",
      },
    ]);
    expect(JSON.stringify(result.output!)).not.toContain(ANTHROPIC_SECRET);
    expect(ctx.recordUsage).toHaveBeenCalledWith("Leak review leak", null, "claude-haiku-4-5");
    expectOutputConformsToRegistry("leak_review", result.output!);
  });

  it("masks and truncates model findings that repeat a raw secret", async () => {
    mocks.generateStructured.mockResolvedValue({
      object: {
        findings: [
          {
            kind: "totally-made-up",
            severity: "catastrophic",
            file: "src/config.ts",
            excerpt: `key = ${ANTHROPIC_SECRET}`,
            reason: `the model repeated ${ANTHROPIC_SECRET} verbatim`,
          },
        ],
        summary: `found ${ANTHROPIC_SECRET}`,
      },
      text: "",
      usage: null,
    });
    const ctx = singleRepoCtx({
      head: "head1",
      log: "feat: add config\n",
      diff: "+++ b/src/config.ts\n+const key = process.env.KEY;\n",
    });

    const result = await execute(makeNode("leak_review"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(result.output!.status).toBe("flagged");
    const serialized = JSON.stringify(result.output!);
    expect(serialized).not.toContain(ANTHROPIC_SECRET);
    expect(serialized).toContain("sk-ant-a****");
    const findings = result.output!.findings as Array<Record<string, string>>;
    expect(findings[0]!.kind).toBe("other");
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.excerpt.length).toBeLessThanOrEqual(40);
    expectOutputConformsToRegistry("leak_review", result.output!);
  });

  it("skips the LLM layer when llmScan is false", async () => {
    const ctx = singleRepoCtx({
      head: "head1",
      log: "feat: add a counter\n",
      diff: "+++ b/src/app.ts\n+const answer = 42;\n",
    });

    const result = await execute(makeNode("leak_review", { llmScan: false }), {}, ctx);

    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(result.kind).toBe("next");
    expect(result.output!.status).toBe("ok");
    expect(result.output!.summary).toContain("LLM scan is disabled");
    expectOutputConformsToRegistry("leak_review", result.output!);
  });

  it("keeps the run on ok when the LLM scan fails", async () => {
    mocks.generateStructured.mockRejectedValue(new Error("provider 500"));
    const ctx = singleRepoCtx({
      head: "head1",
      log: "feat: add a counter\n",
      diff: "+++ b/src/app.ts\n+const answer = 42;\n",
    });

    const result = await execute(makeNode("leak_review", {}, "leak"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(result.output!.status).toBe("ok");
    expect(result.output!.summary).toContain("skipped after a provider error");
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: "provider 500" }),
      "leak_review_llm_scan_failed",
    );
    expect(ctx.recordUsage).toHaveBeenCalledWith("Leak review leak", null, "claude-haiku-4-5");
    expectOutputConformsToRegistry("leak_review", result.output!);
  });

  it("skips when every repository is still at its pre-agent baseline", async () => {
    const ctx = singleRepoCtx({ head: "base" });

    const result = await execute(makeNode("leak_review"), {}, ctx);

    expect(mocks.generateStructured).not.toHaveBeenCalled();
    expect(result.kind).toBe("next");
    expect(result.output!.status).toBe("skipped");
    expect(result.output!.summary).toContain("1 unchanged repository skipped");
    expectOutputConformsToRegistry("leak_review", result.output!);
  });

  it("fails when no workspace is attached", async () => {
    const withoutSandbox = await execute(
      makeNode("leak_review"),
      {},
      makeCtx({ sandboxId: null }),
    );
    expect(withoutSandbox.kind).toBe("execution_error");
    if (withoutSandbox.kind === "execution_error") {
      expect(withoutSandbox.error.category).toBe("sandbox");
      expect(withoutSandbox.error.detail).toContain("no workspace");
    }

    const withoutManifest = await execute(makeNode("leak_review"), {}, makeCtx());
    expect(withoutManifest.kind).toBe("execution_error");
    if (withoutManifest.kind === "execution_error") {
      expect(withoutManifest.error.category).toBe("sandbox");
    }
  });

  it("fails closed when git cannot be read instead of reporting a clean diff", async () => {
    cleanScan();
    mocks.sandboxGet.mockResolvedValue({
      runCommand: vi.fn(async () => ({
        exitCode: 128,
        stdout: async () => "",
        stderr: async () => "fatal: not a git repository",
      })),
    });
    const ctx = makeCtx({
      workspaceManifest: manifest([
        {
          repoPath: "acme/api",
          localPath: "/vercel/sandbox",
          access: "write",
          preAgentSha: "base",
        },
      ]),
    });

    const result = await execute(makeNode("leak_review"), {}, ctx);

    expect(result.kind).toBe("execution_error");
    if (result.kind !== "execution_error") return;
    expect(result.error.category).toBe("sandbox");
    expect(result.error.detail).toContain("git rev-parse failed");
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it("reports a write repository without a baseline commit as unscreened", async () => {
    const ctx = makeCtx({
      workspaceManifest: manifest([
        { repoPath: "acme/api", localPath: "/vercel/sandbox", access: "write" },
      ]),
    });

    const result = await execute(makeNode("leak_review"), {}, ctx);

    expect(mocks.sandboxGet).not.toHaveBeenCalled();
    expect(result.kind).toBe("next");
    expect(result.output!.status).toBe("skipped");
    expect(result.output!.summary).toContain(
      "1 repository had no baseline commit and could not be screened",
    );
    expectOutputConformsToRegistry("leak_review", result.output!);
  });

  it("fails the run when the budget is already exhausted before the LLM scan", async () => {
    const ctx = singleRepoCtx({
      head: "head1",
      log: "feat: add a counter\n",
      diff: "+++ b/src/app.ts\n+const answer = 42;\n",
    });
    ctx.observeBudget = vi.fn().mockResolvedValue({
      check: {
        status: "budget_exceeded",
        metric: "tokens",
        limit: 10,
        consumed: 11,
        reason: "budget_exceeded: tokens 11 reached limit 10",
      },
      remainingDurationMs: 0,
    });

    await expect(execute(makeNode("leak_review"), {}, ctx)).rejects.toBeInstanceOf(
      RunBudgetError,
    );
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it("fails the run when the budget runs out during the LLM scan", async () => {
    mocks.generateStructured.mockRejectedValue(new Error("aborted"));
    const ctx = singleRepoCtx({
      head: "head1",
      log: "feat: add a counter\n",
      diff: "+++ b/src/app.ts\n+const answer = 42;\n",
    });
    ctx.observeBudget = vi
      .fn()
      .mockResolvedValueOnce({ check: { status: "ok" }, remainingDurationMs: 30_000 })
      .mockResolvedValue({
        check: { status: "ok" },
        remainingDurationMs: 0,
        durationLimitMs: 1_800_000,
        activeElapsedMs: 1_800_000,
      });

    await expect(execute(makeNode("leak_review"), {}, ctx)).rejects.toThrow(
      /budget_exceeded: duration/,
    );
  });

  it("truncates the material at the byte cap and screens the retained head", async () => {
    cleanScan();
    const ctx = singleRepoCtx({
      head: "head1",
      log: "feat: bulk change\n",
      diff: `+++ b/src/big.ts\n${"+const filler = 1;\n".repeat(200)}`,
    });

    const result = await execute(makeNode("leak_review", { maxDiffBytes: 300 }), {}, ctx);

    expect(result.kind).toBe("next");
    expect(result.output!.truncated).toBe(true);
    const material = mocks.generateStructured.mock.calls[0]![0].material as string | undefined;
    const prompt = mocks.generateStructured.mock.calls[0]![0].prompt as string;
    expect(material).toBeUndefined();
    expect(prompt).toContain("+const filler = 1;");
    expect(prompt.length).toBeLessThan(600);
    expectOutputConformsToRegistry("leak_review", result.output!);
  });

  it("never reads a read-only repository", async () => {
    cleanScan();
    const sandbox = sandboxWithGit({
      "/vercel/sandbox": {
        head: "head1",
        log: "feat: add a counter\n",
        diff: "+++ b/src/app.ts\n+const answer = 42;\n",
      },
      "/vercel/sandbox/repos/github__acme__docs": {
        head: "docs-head",
        log: "chore: docs\n",
        diff: `+++ b/README.md\n+${ANTHROPIC_SECRET}\n`,
      },
    });
    mocks.sandboxGet.mockResolvedValue(sandbox);
    const ctx = makeCtx({
      workspaceManifest: manifest([
        { repoPath: "acme/api", localPath: "/vercel/sandbox", access: "write", preAgentSha: "base" },
        {
          repoPath: "acme/docs",
          localPath: "/vercel/sandbox/repos/github__acme__docs",
          access: "read",
          preAgentSha: "docs-base",
        },
      ]),
    });

    const result = await execute(makeNode("leak_review"), {}, ctx);

    expect(result.kind).toBe("next");
    expect(result.output!.status).toBe("ok");
    const inspectedPaths = sandbox.runCommand.mock.calls.map((call) => call[1]![1]);
    expect(new Set(inspectedPaths)).toEqual(new Set(["/vercel/sandbox"]));
  });
});
