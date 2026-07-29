import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const workerRoot = fileURLToPath(new URL("../../", import.meta.url));
const scannedRoots = ["src", "workflow-test-fixtures"];

/**
 * Workflow directives on their own line, matched on the raw source. The builder
 * decides which files contribute steps and workflows by content-testing every
 * source file with its own detector, and that detector masks template literals
 * before it strips comments. A stray backtick in a comment therefore inverts
 * backtick parity and silently hides every directive below it, so this test
 * compares the raw truth against what the builder actually sees.
 */
const workflowDirectives = [
  {
    linePattern: /^[ \t]*(['"])use step\1;?[ \t]*$/m,
    detectorFlag: "hasUseStep",
    declares: "steps",
    consequence:
      'the file is dropped from the step bundle while the workflow bundle still emits proxies for it, and every step in it fails at runtime with "is not registered in the current deployment"',
  },
  {
    linePattern: /^[ \t]*(['"])use workflow\1;?[ \t]*$/m,
    detectorFlag: "hasUseWorkflow",
    declares: "a workflow",
    consequence:
      "the file is left out of the workflow bundle entirely, and the workflow disappears from the deployment with no way to start it",
  },
] as const;

describe("step registration coverage", () => {
  it("keeps every step and workflow file discoverable by the workflow builder", async () => {
    const detectWorkflowPatterns = await loadBuilderDirectiveDetector();
    const sources = typescriptFiles(workerRoot, scannedRoots).map((path) => ({
      path,
      source: readFileSync(path, "utf8"),
    }));

    for (const directive of workflowDirectives) {
      const declaring = sources.filter(({ source }) =>
        directive.linePattern.test(source),
      );
      expect(declaring.length).toBeGreaterThan(0);

      for (const { path, source } of declaring) {
        expect(
          detectWorkflowPatterns(source)[directive.detectorFlag],
          `${path} declares ${directive.declares} that the workflow builder's own detector cannot see: ${directive.consequence}.`,
        ).toBe(true);
      }
    }

    const declaringAny = sources.filter(({ source }) =>
      workflowDirectives.some(({ linePattern }) => linePattern.test(source)),
    );
    for (const { path, source } of declaringAny) {
      expect(
        (source.match(/`/g) ?? []).length % 2,
        `${path} declares steps or a workflow and has an odd number of backticks. The builder masks template literals before stripping comments, so a single backtick inside a comment pairs with the next real template literal and masks every directive below it.`,
      ).toBe(0);
    }
  });
});

/**
 * The builder detector is the authority on discovery, so assert against it
 * rather than a local copy. @workflow/builders is a transitive dependency of the
 * workflow SDK and is not resolvable from this package directly, but the
 * @workflow/vitest install this suite already depends on pulls in the same
 * version the nitro build uses.
 */
async function loadBuilderDirectiveDetector(): Promise<
  (source: string) => { hasUseStep: boolean; hasUseWorkflow: boolean }
> {
  const buildersEntry = createRequire(
    createRequire(import.meta.url).resolve("@workflow/vitest"),
  ).resolve("@workflow/builders");
  const builders = await import(pathToFileURL(buildersEntry).href);
  return builders.detectWorkflowPatterns;
}

function typescriptFiles(root: string, relativeDirs: string[]): string[] {
  return relativeDirs.flatMap((dir) => walkTypescriptFiles(join(root, dir)));
}

function walkTypescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkTypescriptFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}
