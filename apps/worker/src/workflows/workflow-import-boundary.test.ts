import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflowTests } from "@workflow/vitest";
import { describe, it } from "vitest";

const workerRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("workflow import boundary", () => {
  it(
    "keeps Node-only modules out of the worker workflow bundle",
    async () => {
      const outputRoot = await mkdtemp(
        join(workerRoot, ".workflow-import-boundary-"),
      );
      try {
        await buildWorkflowTests({
          cwd: workerRoot,
          rootDir: workerRoot,
          dataDir: join(outputRoot, "data"),
          outDir: join(outputRoot, "bundles"),
        });
      } finally {
        await rm(outputRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
