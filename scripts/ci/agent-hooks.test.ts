import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

// The Codex adapter: same budgets, a different payload. Codex writes through
// apply_patch and through the shell, so PreToolUse reads the patch and
// PostToolUse measures the files on disk.
const codexHookPath = join(process.cwd(), ".codex/hooks/context-budget-guard.mjs");

async function invokeCodex(
  root: string,
  payload: unknown,
  stdin = JSON.stringify(payload),
): Promise<HookResult> {
  const result = spawnSync(process.execPath, [codexHookPath], {
    cwd: root,
    encoding: "utf8",
    input: stdin,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function codexContext(result: HookResult, hookEventName: string): string {
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout) as HookOutput;
  assert.equal(output.hookSpecificOutput.hookEventName, hookEventName);
  return output.hookSpecificOutput.additionalContext;
}

function patchPayload(cwd: string, command: string) {
  return { hook_event_name: "PreToolUse", tool_name: "apply_patch", cwd, tool_input: { command } };
}

function afterPayload(cwd: string, tool_name: string) {
  return { hook_event_name: "PostToolUse", tool_name, cwd, tool_input: { command: "true" } };
}

test("a patch over the file ceiling sends the projected size", async () => {
  await withFixture("AGENTS.md\t8\ttest\n", async (root) => {
    const target = await writeFixture(root, "AGENTS.md", "aaaa\n");
    const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n aaaa\n+bbbb\n*** End Patch`;
    const result = await invokeCodex(root, patchPayload(root, patch));
    assert.match(codexContext(result, "PreToolUse"), /AGENTS\.md would be 10 bytes, over its ceiling of 8/u);
  });
});

test("a patch that removes more than it adds stays silent on an oversized file", async () => {
  await withFixture("AGENTS.md\t8\ttest\n", async (root) => {
    const target = await writeFixture(root, "AGENTS.md", "aaaa\nbbbb\n");
    const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n aaaa\n-bbbb\n*** End Patch`;
    const result = await invokeCodex(root, patchPayload(root, patch));
    assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  });
});

test("a rule added by a patch is checked from the patch itself", async () => {
  await withFixture(".claude/rules/*.md\t4096\ttest\n", async (root) => {
    const target = join(root, ".claude/rules/example.md");
    const patch = `*** Begin Patch\n*** Add File: ${target}\n+# Example\n+\n+Do the thing.\n*** End Patch`;
    const result = await invokeCodex(root, patchPayload(root, patch));
    assert.match(codexContext(result, "PreToolUse"), /no non-empty paths: list.*loads in every session/u);
  });
});

test("a patch to a file outside the budget says nothing", async () => {
  await withFixture("AGENTS.md\t1\ttest\n", async (root) => {
    const target = join(root, "src/index.ts");
    const patch = `*** Begin Patch\n*** Add File: ${target}\n+export const x = 1;\n*** End Patch`;
    const result = await invokeCodex(root, patchPayload(root, patch));
    assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  });
});

test("deleting an oversized file is not a warning", async () => {
  await withFixture("AGENTS.md\t5\ttest\n", async (root) => {
    const target = await writeFixture(root, "AGENTS.md", "far too much text\n");
    const patch = `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch`;
    const result = await invokeCodex(root, patchPayload(root, patch));
    assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  });
});

test("a relative patch path is resolved against the session directory", async () => {
  await withFixture("apps/worker/AGENTS.md\t8\ttest\n", async (root) => {
    await writeFixture(root, "apps/worker/AGENTS.md", "aaaa\n");
    const cwd = join(root, "apps/worker");
    const patch = "*** Begin Patch\n*** Update File: AGENTS.md\n@@\n aaaa\n+bbbb\n*** End Patch";
    const result = await invokeCodex(root, patchPayload(cwd, patch));
    assert.match(
      codexContext(result, "PreToolUse"),
      /apps\/worker\/AGENTS\.md would be 10 bytes, over its ceiling of 8/u,
    );
  });
});

test("an em dash in the added lines is reported without reading the file", async () => {
  await withFixture("AGENTS.md\t4096\ttest\n", async (root) => {
    const target = await writeFixture(root, "AGENTS.md", "aaaa\n");
    const dash = String.fromCodePoint(0x2014);
    const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n aaaa\n+left${dash}right\n*** End Patch`;
    const result = await invokeCodex(root, patchPayload(root, patch));
    assert.match(codexContext(result, "PreToolUse"), /U\+2014 or U\+2013/u);
  });
});

test("a moved file is measured at the path it lands on", async () => {
  await withFixture("AGENTS.md\t8\ttest\n", async (root) => {
    const source = await writeFixture(root, "notes.md", "aaaa\n");
    const destination = join(root, "AGENTS.md");
    const patch =
      `*** Begin Patch\n*** Update File: ${source}\n*** Move to: ${destination}\n@@\n aaaa\n+bbbb\n*** End Patch`;
    const result = await invokeCodex(root, patchPayload(root, patch));
    assert.match(codexContext(result, "PreToolUse"), /AGENTS\.md would be 10 bytes, over its ceiling of 8/u);
  });
});

test("a shell write is caught afterwards by measuring the file on disk", async () => {
  await withFixture("AGENTS.md\t5\ttest\n", async (root) => {
    await writeFixture(root, "AGENTS.md", "far too much text\n");
    const result = await invokeCodex(root, afterPayload(root, "Bash"));
    assert.match(codexContext(result, "PostToolUse"), /AGENTS\.md is 18 bytes on disk, over its ceiling of 5/u);
  });
});

test("a tool that cannot write is not measured afterwards", async () => {
  await withFixture("AGENTS.md\t5\ttest\n", async (root) => {
    await writeFixture(root, "AGENTS.md", "far too much text\n");
    const result = await invokeCodex(root, afterPayload(root, "update_plan"));
    assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  });
});

test("rules over the collective ceiling are reported afterwards too", async () => {
  await withFixture(".claude/rules/*.md\t4096\ttest\n.claude/rules/\t40\ttest\n", async (root) => {
    const rule = "---\npaths:\n  - \"src/a/**\"\n---\n\n# A\n";
    await writeFixture(root, ".claude/rules/a.md", rule);
    await writeFixture(root, ".claude/rules/b.md", rule);
    const total = Buffer.byteLength(rule) * 2;
    const result = await invokeCodex(root, afterPayload(root, "Bash"));
    assert.match(
      codexContext(result, "PostToolUse"),
      new RegExp(`rules/\\*\\.md is ${total} bytes on disk, over its collective ceiling of 40`, "u"),
    );
  });
});

test("malformed stdin leaves the Codex tool call alone", async () => {
  await withFixture("AGENTS.md\t1\ttest\n", async (root) => {
    const result = await invokeCodex(root, {}, "not json");
    assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  });
});

test("a repository without a budget file leaves the Codex tool call alone", async () => {
  await withFixture(undefined, async (root) => {
    const target = await writeFixture(root, "AGENTS.md", "far too much text\n");
    const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n+more\n*** End Patch`;
    const result = await invokeCodex(root, patchPayload(root, patch));
    assert.deepEqual(result, { status: 0, stdout: "", stderr: "" });
  });
});

test("the Codex configuration sends both events to the guard on disk", async () => {
  const config = JSON.parse(
    await readFile(join(process.cwd(), ".codex/hooks.json"), "utf8"),
  ) as Record<string, Record<string, { matcher?: string; hooks: { command: string }[] }[]>>;
  const registered = (event: string) =>
    (config.hooks[event] ?? []).flatMap((entry) =>
      entry.hooks.map((hook) => ({ matcher: entry.matcher, command: hook.command })),
    );

  const before = registered("PreToolUse");
  assert.equal(before.length, 1);
  assert.equal(before[0].matcher, "apply_patch");
  const after = registered("PostToolUse");
  assert.equal(after.length, 1);
  assert.match(after[0].matcher ?? "", /apply_patch/u);
  assert.match(after[0].matcher ?? "", /Bash/u);

  for (const { command } of [...before, ...after]) {
    // A relative command would resolve against the session directory, so a
    // Codex run started in a subdirectory would silently lose the guard.
    assert.match(command, /git rev-parse --show-toplevel/u);
    assert.match(command, /\$root\/\.codex\/hooks\/context-budget-guard\.mjs/u);
  }
  await access(codexHookPath);
});
