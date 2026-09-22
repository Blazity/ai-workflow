import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { sourceFile } from "../generate-block-catalog/manifest-ast.js";
import { type GlobalUse, unavailableGlobals, WORKFLOW_VM_GLOBALS } from "./graph-globals.js";

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
 * Whether a specifier names one of Node's own modules, with or without the
 * `node:` prefix. The boundaries gate refuses `node:*` in a dashboard entry,
 * but `"process"` or `"fs"` bare is the same module, and an import binds a
 * local name the globals check rightly accepts as local.
 */
function isNodeBuiltin(specifier: string): boolean {
  const name = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return builtinModules.includes(name) || specifier.startsWith("node:");
}

/** One line per use, then the fix, so a refusal names every place at once. */
function refuseGlobals(uses: readonly GlobalUse[], opening: string, closing: string): void {
  if (uses.length === 0) return;
  const lines = uses.map((use) => `  ${use.file}:${use.line} uses ${use.name}.${use.reason ? ` ${use.reason}` : ""}`);
  throw new Error(`${opening}\n${lines.join("\n")}\n${closing}`);
}

/**
 * A manifest is read by the dashboard in a browser and by the Workflow DevKit
 * inside the flow bundle, where a Node module fails the Vercel build and a
 * Node global fails the deployed workflow, and nothing local catches either.
 * The rule is therefore the whole reachable graph, not one file: a manifest
 * may import `@integrations/sdk` and files inside its own package, each of
 * those obeys the same rule, and together they may use only the globals the
 * VM gives them (`unavailableGlobals`, which asks the compiler).
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
  refuseGlobals(
    unavailableGlobals([...seen], "manifest", repositoryRoot),
    "A manifest may use the language and what the Workflow DevKit's VM gives it " +
      `(${WORKFLOW_VM_GLOBALS.join(", ")}), because the flow bundle evaluates it there. ` +
      "Conformance and the typecheck run in Node, so they pass, and the deployed workflow throws a ReferenceError:",
    "Write the value out as data, or compute it in the worker entry.",
  );
  return [...seen];
}

/**
 * A dashboard entry may use only what a browser gives it.
 *
 * The specifier rules in `tiers.json` shut the doors that are imports:
 * `next/headers`, `node:*`, `server-only`. Node's modules imported bare
 * (`"process"`, `"fs"`) are shut here, in every file of the graph. A global is
 * not an import, so nothing there can see it, and `process` is the one reach
 * that needs no dependency at all: a Server Component in our process would get
 * `WORKER_BASE_URL` and every other variable this deployment runs with. An
 * integration's own credentials reach it through the context the SDK
 * describes, on the worker side, where they are resolved once.
 *
 * The question is the manifest's (`unavailableGlobals`) asked of the browser,
 * over the whole reachable graph inside the package, because a helper one
 * file away would read the same environment.
 */
export function assertDashboardUsesBrowserGlobals(
  packageDirectory: string,
  dashboardPath: string,
  repositoryRoot: string,
): void {
  const seen = new Set<string>();
  const visit = (filePath: string): void => {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    const file = sourceFile(filePath);
    for (const specifier of specifiers(file)) {
      if (isNodeBuiltin(specifier)) {
        const local = relative(repositoryRoot, filePath).replaceAll("\\", "/");
        throw new Error(
          `${local}: a dashboard entry may not import "${specifier}", which is Node's own module. ` +
            "It renders inside the cockpit's own server, where Node's modules reach this deployment's files and environment, not the integration's. " +
            "What an integration needs reaches it through the context the SDK describes, on the worker side.",
        );
      }
      if (!specifier.startsWith(".")) continue;
      const target = resolveLocal(filePath, specifier);
      if (!target) continue;
      if (relative(packageDirectory, target).startsWith("..")) continue;
      visit(target);
    }
  };
  visit(dashboardPath);
  refuseGlobals(
    unavailableGlobals([...seen], "dashboard", repositoryRoot),
    "A dashboard entry may use the language and what a browser gives it. It also renders inside the cockpit's own server, " +
      "where process.env is this deployment's environment, not the integration's:",
    "What an integration needs reaches it through the context the SDK describes, on the worker side.",
  );
}
