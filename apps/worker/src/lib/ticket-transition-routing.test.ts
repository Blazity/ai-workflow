import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const rawMoveAllowed = new Set([
  "adapters/issue-tracker/jira.ts",
  "lib/cancel-run.ts",
  "lib/ticket-transition.ts",
  // Dependency callback name only; this module never receives an issue tracker.
  "workflows/workflow-failure-exit.ts",
]);

describe("ticket transition routing", () => {
  it("routes every internal production move through the shared intent operation", () => {
    const srcDir = new URL("../", import.meta.url).pathname;
    const violations = sourceFiles(srcDir)
      .map((path) => ({
        path,
        relativePath: relative(srcDir, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(({ relativePath, source }) =>
        !rawMoveAllowed.has(relativePath) && source.includes(".moveTicket("),
      )
      .map(({ relativePath }) => relativePath);

    expect(violations).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}
