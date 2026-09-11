import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkflowTests } from "@workflow/vitest";
import ts from "typescript";
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
  it("distinguishes executable Node imports from import-like text", () => {
    const fixtures = join(
      workerRoot,
      "src/engine/workflow-import-boundary-fixtures",
    );
    expect(() =>
      assertNoNodeImports(
        readFileSync(join(fixtures, "node-import.fixture"), "utf8"),
        "node-import.fixture",
      ),
    ).toThrow(/node:fs/);
    expect(() =>
      assertNoNodeImports(
        readFileSync(join(fixtures, "node-import-text.fixture"), "utf8"),
        "node-import-text.fixture",
      ),
    ).not.toThrow();
    expect(
      executableNodeImports(
        'import "node:fs"; export * from "node:path"; import("node:url"); require("node:util");',
        "forms.ts",
      ),
    ).toEqual(["node:fs", "node:path", "node:url", "node:util"]);
    expect(() => executableNodeImports("import {", "broken.ts")).toThrow(
      /broken\.ts could not be parsed/,
    );
  });

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

        const nodeImports = [join(outDir, "workflows.mjs")].flatMap((file) =>
          executableNodeImports(readFileSync(file, "utf8"), file).map(
            (specifier) => `${file}: ${specifier}`,
          ),
        );
        expect(nodeImports, "workflow bundles import Node modules").toEqual([]);
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

const nodeModules = new Set(
  builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`]),
);

function executableNodeImports(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const diagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics?.length) {
    throw new Error(`${fileName} could not be parsed: ${diagnostics[0].messageText}`);
  }

  const imports: string[] = [];
  const record = (node: ts.Expression | undefined) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      const root = node.text.startsWith("node:")
        ? node.text
        : node.text.split("/")[0];
      if (nodeModules.has(root) || nodeModules.has(node.text)) imports.push(node.text);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (dynamicImport || requireCall) record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function assertNoNodeImports(source: string, fileName: string): void {
  const imports = executableNodeImports(source, fileName);
  if (imports.length > 0) {
    throw new Error(`${fileName} imports Node modules: ${imports.join(", ")}`);
  }
}

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}
