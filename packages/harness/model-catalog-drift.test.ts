import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const gate = resolve(import.meta.dirname, "../../scripts/gates/model-catalog-drift.mjs");
const exclusions = [
  "**/*.test.*",
  "apps/dashboard/components/cockpit/activity-drawer.tsx",
  "apps/dashboard/lib/data/mock.ts",
  "apps/worker/scripts/capture-agent-protocol-fixtures.ts",
  "packages/harness/model-catalog.ts",
] as const;

function write(root: string, path: string, source: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function assertReviewedExclusions(): void {
  assert.deepEqual(
    execFileSync(process.execPath, [gate, "--print-exclusions"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
    [...exclusions],
  );
}

test("the drift gate rejects a non-owner literal and honors only reviewed exclusions", () => {
  assertReviewedExclusions();

  const root = mkdtempSync(join(tmpdir(), "model-catalog-drift-"));
  try {
    write(root, "packages/harness/model-catalog.ts", 'const id = "gpt-5";');
    write(root, "apps/worker/src/example.test.tsx", 'const id = "gpt-5";');
    write(
      root,
      "apps/worker/scripts/capture-agent-protocol-fixtures.ts",
      'const id = "gpt-5.3-codex";',
    );
    write(
      root,
      "apps/worker/.vercel/output/generated.js",
      'const id = "gpt-5.5";',
    );
    write(
      root,
      "apps/worker/src/product-comment.ts",
      "// gpt-5.5 is documentation only.\n/* claude-opus-4-8 is documentation only. */",
    );
    write(root, "apps/worker/src/product.ts", 'const id = "gpt-5.5";');

    assert.throws(
      () =>
        execFileSync(process.execPath, [gate, "--root", root], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      (error: unknown) => {
        const output = String(
          (error as { stdout?: string | Buffer }).stdout ?? "",
        );
        return output.includes("apps/worker/src/product.ts:1");
      },
    );

    rmSync(join(root, "apps/worker/src/product.ts"));
    assert.match(
      execFileSync(process.execPath, [gate, "--root", root], {
        encoding: "utf8",
      }),
      /model-catalog-drift PASS/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
