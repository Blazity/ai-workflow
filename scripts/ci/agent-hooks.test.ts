import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runContextBudgetGuard } from "../../.claude/hooks/context-budget-guard.mjs";

for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) delete process.env[name];
}

const hookPath = join(
  process.cwd(),
  ".claude/hooks/context-budget-guard.mjs",
);

type HookResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type HookOutput = {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
};

async function withFixture(
  budget: string | undefined,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-hooks-")));
  try {
    execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: root });
    if (budget !== undefined) {
      await mkdir(join(root, ".claude"), { recursive: true });
      await writeFile(join(root, ".claude/context-budget.tsv"), budget);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixture(root: string, path: string, content: string) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

async function invoke(
  root: string,
  payload: unknown,
  stdin = JSON.stringify(payload),
): Promise<HookResult> {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf8",
    input: stdin,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function context(result: HookResult): string {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout) as HookOutput;
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
  return output.hookSpecificOutput.additionalContext;
}

function payload(tool_name: string, file_path: string, tool_input: object) {
  return { tool_name, tool_input: { file_path, ...tool_input } };
}

test("Write over the file ceiling sends the model the path and both sizes", async () => {
  assert.equal(typeof runContextBudgetGuard, "function");
  await withFixture("AGENTS.md\t5\ttest\n", async (root) => {
    const target = join(root, "AGENTS.md");
    const result = await invoke(root, payload("Write", target, { content: "123456" }));
    assert.match(context(result), /AGENTS\.md would be 6 bytes, over its ceiling of 5/u);
  });
});

test("Write under the file ceiling produces no output", async () => {
  await withFixture("AGENTS.md\t6\ttest\n", async (root) => {
    const target = join(root, "AGENTS.md");
    const result = await invoke(root, payload("Write", target, { content: "123456" }));
    assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  });
});

test("a file outside the budget produces no output", async () => {
  await withFixture("AGENTS.md\t1\ttest\n", async (root) => {
    const target = join(root, "src/index.ts");
    const result = await invoke(root, payload("Write", target, { content: "large" }));
    assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  });
});

test("Edit projects a replacement that crosses the file ceiling", async () => {
  await withFixture("AGENTS.md\t6\ttest\n", async (root) => {
    const target = await writeFixture(root, "AGENTS.md", "hello");
    const result = await invoke(
      root,
      payload("Edit", target, { old_string: "hello", new_string: "welcome" }),
    );
    assert.match(context(result), /AGENTS\.md would be 7 bytes, over its ceiling of 6/u);
  });
});

test("Edit replace_all counts every occurrence", async () => {
  await withFixture("AGENTS.md\t8\ttest\n", async (root) => {
    const target = await writeFixture(root, "AGENTS.md", "aa aa");
    const result = await invoke(
      root,
      payload("Edit", target, {
        old_string: "a",
        new_string: "xx",
        replace_all: true,
      }),
    );
    assert.match(context(result), /AGENTS\.md would be 9 bytes, over its ceiling of 8/u);
  });
});

test("MultiEdit applies edits in order", async () => {
  await withFixture("AGENTS.md\t7\ttest\n", async (root) => {
    const target = await writeFixture(root, "AGENTS.md", "abc");
    const result = await invoke(
      root,
      payload("MultiEdit", target, {
        edits: [
          { old_string: "a", new_string: "long" },
          { old_string: "long", new_string: "123456" },
        ],
      }),
    );
    assert.match(context(result), /AGENTS\.md would be 8 bytes, over its ceiling of 7/u);
  });
});

test("a rule without a non-empty paths list warns that it loads in every session", async () => {
  await withFixture(
    ".claude/rules/*.md\t100\ttest\n.claude/rules/\t1000\ttest\n",
    async (root) => {
      const target = join(root, ".claude/rules/example.md");
      const result = await invoke(
        root,
        payload("Write", target, { content: "---\npaths: []\n---\n\n# Example\n" }),
      );
      assert.match(context(result), /no non-empty paths: list.*loads in every session/u);
    },
  );
});

test("rules over the collective ceiling send the projected total", async () => {
  await withFixture(
    ".claude/rules/*.md\t100\ttest\n.claude/rules/\t69\ttest\n",
    async (root) => {
      const first = "---\npaths:\n  - \"src/a/**\"\n---\n\n# A\n";
      const second = "---\npaths:\n  - \"src/b/**\"\n---\n\n# B\n";
      await writeFixture(root, ".claude/rules/a.md", first);
      const target = join(root, ".claude/rules/b.md");
      const total = Buffer.byteLength(first) + Buffer.byteLength(second);
      const result = await invoke(root, payload("Write", target, { content: second }));
      assert.match(
        context(result),
        new RegExp(`rules/\\*\\.md would be ${total} bytes, over its collective ceiling of 69`, "u"),
      );
    },
  );
});

test("covered content with an em dash sends the Unicode warning", async () => {
  await withFixture("AGENTS.md\t100\ttest\n", async (root) => {
    const target = join(root, "AGENTS.md");
    const contentWithDash = `left${String.fromCodePoint(0x2014)}right`;
    const result = await invoke(root, payload("Write", target, { content: contentWithDash }));
    assert.match(context(result), /U\+2014 or U\+2013/u);
  });
});

test("malformed stdin exits zero without output", async () => {
  await withFixture("AGENTS.md\t1\ttest\n", async (root) => {
    const result = await invoke(root, {}, "not json");
    assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  });
});

test("a missing budget file exits zero without output", async () => {
  await withFixture(undefined, async (root) => {
    const target = join(root, "AGENTS.md");
    const result = await invoke(root, payload("Write", target, { content: "large" }));
    assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  });
});

test("a project reached through a symlink still gets the warning", async () => {
  await withFixture("AGENTS.md\t5\ttest\n", async (root) => {
    const links = await realpath(await mkdtemp(join(tmpdir(), "agent-hooks-link-")));
    try {
      const linked = join(links, "project");
      await symlink(root, linked);
      const result = await invoke(
        linked,
        payload("Write", join(linked, "AGENTS.md"), { content: "123456" }),
      );
      assert.match(context(result), /AGENTS\.md would be 6 bytes, over its ceiling of 5/u);
    } finally {
      await rm(links, { recursive: true, force: true });
    }
  });
});
