import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflowTests } from "@workflow/vitest";
import { describe, expect, it } from "vitest";

const workerRoot = fileURLToPath(new URL("../../", import.meta.url));
const scannedRoots = ["src", "workflow-test-fixtures"];

// Keep the patterns in sync with step-registration-coverage.test.ts, which
// asserts the same sets against the builder's own detector without a build.
const workflowDirectives = [
  {
    linePattern: /^[ \t]*(['"])use step\1;?[ \t]*$/m,
    debugList: "stepFiles",
    declares: "steps",
  },
  {
    linePattern: /^[ \t]*(['"])use workflow\1;?[ \t]*$/m,
    debugList: "workflowFiles",
    declares: "a workflow",
  },
] as const;

describe("workflow import boundary", () => {
  it(
    "keeps Node-only modules out of the worker workflow bundle",
    async () => {
      const outputRoot = await mkdtemp(
        join(workerRoot, ".workflow-import-boundary-"),
      );
      try {
        const outDir = join(outputRoot, "bundles");
        await buildWorkflowTests({
          cwd: workerRoot,
          rootDir: workerRoot,
          dataDir: join(outputRoot, "data"),
          outDir,
        });

        // Discovery is content-based, so a file the builder fails to recognize is
        // dropped from the bundle without any build error: its steps then fail at
        // runtime with "is not registered in the current deployment", and its
        // workflows vanish from the deployment entirely. The steps bundle debug
        // file carries both discovered lists, so assert them in the same build.
        const debug = JSON.parse(
          await readFile(join(outDir, "steps.mjs.debug.json"), "utf8"),
        ) as Record<string, string[]>;

        for (const { linePattern, debugList, declares } of workflowDirectives) {
          const bundled = new Set(
            await Promise.all(
              (debug[debugList] ?? []).map((file) => realpath(file)),
            ),
          );
          const declared = await Promise.all(
            directiveFiles(linePattern).map((file) => realpath(file)),
          );

          expect(declared.length, `no file declares ${declares}`).toBeGreaterThan(0);
          expect(
            declared.filter((file) => !bundled.has(file)),
            `these files declare ${declares} but are missing from the builder's ${debugList}`,
          ).toEqual([]);
        }
      } finally {
        await rm(outputRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function directiveFiles(linePattern: RegExp): string[] {
  return scannedRoots
    .flatMap((dir) => typescriptFiles(join(workerRoot, dir)))
    .filter((path) => linePattern.test(readFileSync(path, "utf8")));
}

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}
