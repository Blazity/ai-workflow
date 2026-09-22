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
 * Globals Node gives a module and the Workflow DevKit's VM does not. The flow
 * bundle evaluates every manifest inside that VM, which provides the language's
 * own builtins plus `crypto`, `console`, `URL`, `URLSearchParams`, `Headers`,
 * `TextEncoder`, `TextDecoder`, `structuredClone`, `atob`, `btoa`,
 * `DOMException` and a `process` that is only `{ env }` (@workflow/core 4.8.0,
 * `dist/vm/index.js`). A manifest reaching for anything below passes
 * conformance, which runs in Node, and the typecheck, which sees @types/node,
 * and then throws a ReferenceError in the deployed workflow. `process` is
 * refused whole: `process.env` exists there, but a manifest that reads the
 * environment is no longer plain data, and the browser has none.
 */
const HOST_GLOBALS = new Set([
  "AbortController",
  "AbortSignal",
  "Blob",
  "Buffer",
  "FormData",
  "Request",
  "Response",
  "__dirname",
  "__filename",
  "clearImmediate",
  "clearInterval",
  "clearTimeout",
  "document",
  "fetch",
  "global",
  "navigator",
  "performance",
  "process",
  "queueMicrotask",
  "require",
  "setImmediate",
  "setInterval",
  "setTimeout",
  "window",
]);

/** Every name the file binds itself, so a local `process` is not the global one. */
function locallyBound(file: ts.SourceFile): Set<string> {
  const bound = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node) ||
        ts.isBindingElement(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      bound.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return bound;
}

/** Whether an identifier is a value the module evaluates, not a type, a key or a member name. */
function isValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === identifier) {
    return false;
  }
  for (let node: ts.Node = identifier; node.parent; node = node.parent) {
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return false;
  }
  return true;
}

/** The host globals a file uses, by name. */
function hostGlobalsUsed(file: ts.SourceFile): string[] {
  const bound = locallyBound(file);
  const used = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && HOST_GLOBALS.has(node.text) && !bound.has(node.text) && isValueReference(node)) {
      used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...used].sort();
}

/**
 * A manifest is read by the dashboard in a browser and by the Workflow DevKit
 * inside the flow bundle, where a Node module fails the Vercel build and a
 * Node global fails the deployed workflow, and nothing local catches either.
 * The rule is therefore the whole reachable graph, not one file: a manifest
 * may import `@integrations/sdk` and files inside its own package, each of
 * those obeys the same rule, and none of them may use a global the VM lacks
 * (`HOST_GLOBALS`).
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
    const globals = hostGlobalsUsed(file);
    if (globals.length > 0) {
      throw new Error(
        `${local}: a manifest may not use ${globals.join(", ")}. The Workflow DevKit flow bundle evaluates manifests in a VM that has no such global, ` +
          "so conformance and the typecheck pass here and the deployed workflow throws a ReferenceError. " +
          "Write the value out as data, or compute it in the worker entry.",
      );
    }
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
