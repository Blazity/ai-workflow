import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { sourceFile } from "../generate-block-catalog/manifest-ast.js";

const SDK = "@integrations/sdk";
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/u, ""));
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && !candidate.endsWith("/")) return candidate;
  }
  return null;
}

function specifiers(file: ts.SourceFile): string[] {
  const found: string[] = [];
  for (const statement of file.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      found.push(statement.moduleSpecifier.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      found.push((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * A manifest is read by the dashboard in a browser and by the Workflow DevKit
 * inside the flow bundle, where a Node module fails the Vercel build and
 * nothing else, so no local test would catch it. The rule is therefore the
 * whole reachable graph, not one file: a manifest may import `@integrations/sdk`
 * and files inside its own package, and each of those obeys the same rule.
 *
 * Returns every file the manifest reaches, the caller's cue for which files a
 * manifest change touches.
 */
export function assertManifestIsPureData(
  packageDirectory: string,
  manifestPath: string,
  repositoryRoot: string,
): string[] {
  const seen = new Set<string>();
  const visit = (filePath: string): void => {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    const file = sourceFile(filePath);
    const local = relative(repositoryRoot, filePath).replaceAll("\\", "/");
    for (const specifier of specifiers(file)) {
      if (specifier === SDK) continue;
      if (!specifier.startsWith(".")) {
        throw new Error(
          `${local}: a manifest may import "${SDK}" and files inside its own package, but this one imports "${specifier}". ` +
            "The dashboard and the Workflow DevKit flow bundle read manifests, and a Node module there fails only the Vercel build. " +
            "Move that import into the worker entry.",
        );
      }
      const target = resolveLocal(filePath, specifier);
      if (!target) {
        throw new Error(`${local}: cannot resolve the local import "${specifier}".`);
      }
      if (relative(packageDirectory, target).startsWith("..")) {
        throw new Error(
          `${local}: "${specifier}" reaches outside this integration package. ` +
            "An integration shares code through its own files or through the SDK, never through a path into another package.",
        );
      }
      visit(target);
    }
  };
  visit(manifestPath);
  return [...seen];
}

/**
 * A dashboard entry may not read the deployment's environment.
 *
 * The specifier rules in `tiers.json` shut the doors that are imports:
 * `next/headers`, `node:*`, `server-only`. `process.env` is not an import, so
 * nothing there can see it, and it is the one reach that needs no dependency at
 * all: a Server Component in our process would get `WORKER_BASE_URL` and every
 * other variable this deployment runs with. An integration's own credentials
 * reach it through the context the SDK describes, on the worker side, where
 * they are resolved once.
 *
 * Source text, not the type graph: this is about what a file can do at run
 * time, and the whole reachable graph inside the package is checked, because a
 * helper one file away would read the same environment.
 */
export function assertDashboardReadsNoEnvironment(
  packageDirectory: string,
  dashboardPath: string,
  repositoryRoot: string,
): void {
  const seen = new Set<string>();
  const visit = (filePath: string): void => {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    const local = relative(repositoryRoot, filePath).replaceAll("\\", "/");
    if (/\bprocess\s*\.\s*env\b/u.test(readFileSync(filePath, "utf8"))) {
      throw new Error(
        `${local}: a dashboard entry may not read process.env. It renders inside the cockpit's own process, so the environment it would read is this deployment's, not the integration's. ` +
          "What an integration needs reaches it through the context the SDK describes, on the worker side.",
      );
    }
    const file = sourceFile(filePath);
    for (const specifier of specifiers(file)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveLocal(filePath, specifier);
      if (!target) continue;
      if (relative(packageDirectory, target).startsWith("..")) continue;
      visit(target);
    }
  };
  visit(dashboardPath);
}
