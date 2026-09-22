import { dirname, relative } from "node:path";
import ts from "typescript";

/**
 * Which globals a graph of integration files may use, answered by the
 * TypeScript compiler rather than by a list of names somebody keeps.
 *
 * Each graph is compiled against the declarations of the place it runs and
 * nothing else: no `@types/node`, no imports followed. A global the place
 * lacks is then a name the compiler cannot find, with the compiler's own
 * scope rules, so a local binding called `process` is the local one and a
 * type that merely mentions `Buffer` is erased and allowed.
 *
 * - A manifest runs in the browser (the dashboard), in the cockpit's server
 *   and inside the Workflow DevKit's VM (the flow bundle). The VM is the
 *   narrowest, so its environment is the language (`lib.es2023`) plus exactly
 *   what the DevKit puts on the VM's global, less the names that are there
 *   only as a stub that throws or as a shim for the bundle.
 * - A dashboard entry runs in the browser and in the cockpit's server, so its
 *   environment is the browser's (`lib.es2023` with the DOM). `process` is not
 *   in it: in the server it is this deployment's environment, `WORKER_BASE_URL`
 *   and every secret the cockpit runs with.
 */
export type GraphEnvironment = "manifest" | "dashboard";

/**
 * What the Workflow DevKit (@workflow/core 4.8.0) adds to the VM's global,
 * in `dist/vm/index.js` `createContext` and in `dist/workflow.js`, and a
 * browser also has. A manifest may use these and the language, nothing else.
 * `scripts/ci/workflow-vm-globals.test.ts` runs the pinned DevKit and fails
 * when its VM stops matching this list and `REFUSED_IN_THE_VM` together.
 */
export const WORKFLOW_VM_GLOBALS = [
  "DOMException",
  "Headers",
  "ReadableStream",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "WritableStream",
  "atob",
  "btoa",
  "console",
  "crypto",
  "structuredClone",
] as const;

const THROWS_IN_THE_VM =
  "The Workflow DevKit's VM has only a stub that throws, because a workflow may not do I/O or wait outside a step.";

/** Names the DevKit does put on the VM's global and a manifest still may not use, each with why. */
export const REFUSED_IN_THE_VM: Readonly<Record<string, string>> = {
  process:
    "The Workflow DevKit's VM has only `{ env }` there and the browser has none, and a manifest that reads the environment is no longer data.",
  exports: "It is the flow bundle's CommonJS shim, not something a manifest can rely on.",
  module: "It is the flow bundle's CommonJS shim, not something a manifest can rely on.",
  fetch: THROWS_IN_THE_VM,
  setTimeout: THROWS_IN_THE_VM,
  setInterval: THROWS_IN_THE_VM,
  setImmediate: THROWS_IN_THE_VM,
  clearTimeout: THROWS_IN_THE_VM,
  clearInterval: THROWS_IN_THE_VM,
  clearImmediate: THROWS_IN_THE_VM,
};

/**
 * Globals a manifest may not use although every place it runs has them: the
 * VM replaces them with a fixed clock and a seeded generator, so a manifest
 * that read them would be one value in the flow bundle and another in the
 * dashboard. A manifest is data.
 */
const DIFFERS_IN_THE_VM: Readonly<Record<string, string>> = {
  Date: "The Workflow DevKit's VM fixes the clock, so the value differs between the flow bundle and the dashboard.",
  "Math.random":
    "The Workflow DevKit's VM seeds it per run, so the value differs between the flow bundle and the dashboard.",
};

export const ENVIRONMENT_LIBS: Readonly<Record<GraphEnvironment, readonly string[]>> = {
  manifest: ["lib.es2023.d.ts"],
  dashboard: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
};

/**
 * Diagnostics that mean "this name is not declared here", in each wording the
 * compiler has for it (plain, with a suggestion, with a hint to install
 * `@types/node`, to change `lib` or to add the DOM), plus the two that mean a
 * name is only a type where a value was asked for.
 */
const UNRESOLVED_NAME = new Set([2304, 2552, 2580, 2581, 2582, 2583, 2584, 2585, 2591, 2592, 2593, 2662, 2663, 2693, 2867, 2868]);

export type GlobalUse = {
  /** The file, relative to the repository root. */
  file: string;
  line: number;
  name: string;
  /** Why the place refuses it, when there is more to say than that it is missing. */
  reason?: string;
};

/**
 * The file the compiler reads for the VM's additions and the control that
 * proves nothing else reached the program. Both are virtual: a `.d.ts` on disk
 * would be picked up by the repository's own typecheck and redeclare
 * `console` against `@types/node`.
 */
const VM_DECLARATIONS = "/__integration-graph-globals__/workflow-vm-globals.d.ts";
const CONTROL = "/__integration-graph-globals__/control.ts";
const CONTROL_NAMES = ["process", "Buffer", "require"];

const libraryFiles = new Map<string, ts.SourceFile | undefined>();

function compilerOptions(environment: GraphEnvironment): ts.CompilerOptions {
  return {
    lib: [...ENVIRONMENT_LIBS[environment]],
    types: [],
    noResolve: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
  };
}

function virtualSources(environment: GraphEnvironment): Map<string, string> {
  const sources = new Map([[CONTROL, `export {};\n${CONTROL_NAMES.map((name) => `void ${name};`).join("\n")}\n`]]);
  if (environment === "manifest") {
    sources.set(VM_DECLARATIONS, WORKFLOW_VM_GLOBALS.map((name) => `declare var ${name}: any;`).join("\n"));
  }
  return sources;
}

function createGraphProgram(files: readonly string[], environment: GraphEnvironment): ts.Program {
  const options = compilerOptions(environment);
  const host = ts.createCompilerHost(options, true);
  const virtual = virtualSources(environment);
  const libraryDirectory = dirname(host.getDefaultLibFileName(options));
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtual.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    // The library declarations are the same for every graph; parsing them once
    // keeps a generator run that checks every integration fast.
    if (dirname(fileName) === libraryDirectory) {
      if (!libraryFiles.has(fileName)) libraryFiles.set(fileName, readSource(fileName, languageVersion, onError, shouldCreate));
      return libraryFiles.get(fileName);
    }
    return readSource(fileName, languageVersion, onError, shouldCreate);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => virtual.has(fileName) || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => virtual.get(fileName) ?? readFile(fileName);
  return ts.createProgram({ rootNames: [...files, ...virtual.keys()], options, host });
}

/** The identifier a diagnostic points at. */
function identifierAt(file: ts.SourceFile, position: number): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (position < node.getStart(file) || position >= node.getEnd()) return;
    if (ts.isIdentifier(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Whether the node is erased before anything runs: a type, an interface, an alias. */
function isTypeOnly(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return true;
    if (ts.isExpressionWithTypeArguments(current) && ts.isHeritageClause(current.parent) && current.parent.token === ts.SyntaxKind.ImplementsKeyword) {
      return true;
    }
  }
  return false;
}

/** Whether a name resolves to what the language or the environment declares, not to anything in the graph. */
function isGlobal(checker: ts.TypeChecker, program: ts.Program, identifier: ts.Identifier): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return false;
  const declarations = symbol.declarations ?? [];
  return declarations.every((declaration) => {
    const source = declaration.getSourceFile();
    return program.isSourceFileDefaultLibrary(source) || source.fileName === VM_DECLARATIONS;
  });
}

function lineOf(file: ts.SourceFile, position: number): number {
  return file.getLineAndCharacterOfPosition(position).line + 1;
}

/**
 * Every use, in the given files, of a global the environment does not give
 * them, plus every use of `globalThis`, which reaches any global by a string
 * the compiler cannot follow, and in a manifest every use of what the VM makes
 * differ (`Date`, `Math.random`).
 *
 * Throws when the control file resolves a Node global: then something put
 * Node's declarations in the program and the answer would be wrong.
 */
export function unavailableGlobals(
  files: readonly string[],
  environment: GraphEnvironment,
  repositoryRoot: string,
): GlobalUse[] {
  const program = createGraphProgram(files, environment);
  const checker = program.getTypeChecker();

  const control = program.getSourceFile(CONTROL)!;
  const controlMissing = new Set(
    program
      .getSemanticDiagnostics(control)
      .filter((diagnostic) => UNRESOLVED_NAME.has(diagnostic.code) && diagnostic.start !== undefined)
      .map((diagnostic) => identifierAt(control, diagnostic.start!)?.text),
  );
  const leaked = CONTROL_NAMES.filter((name) => !controlMissing.has(name));
  if (leaked.length > 0) {
    throw new Error(
      `The globals check resolved ${leaked.join(", ")} in a program that declares no Node globals, so Node's declarations reached it and it cannot tell what the ${environment} environment lacks.`,
    );
  }

  const uses: GlobalUse[] = [];
  for (const path of files) {
    const file = program.getSourceFile(path);
    if (!file) throw new Error(`The globals check could not read ${path}.`);
    const local = relative(repositoryRoot, path).replaceAll("\\", "/");
    for (const diagnostic of program.getSemanticDiagnostics(file)) {
      if (!UNRESOLVED_NAME.has(diagnostic.code) || diagnostic.start === undefined) continue;
      const identifier = identifierAt(file, diagnostic.start);
      if (!identifier || isTypeOnly(identifier)) continue;
      const reason = environment === "manifest" ? REFUSED_IN_THE_VM[identifier.text] : undefined;
      uses.push({ file: local, line: lineOf(file, diagnostic.start), name: identifier.text, ...(reason ? { reason } : {}) });
    }
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isTypeOnly(node) && isGlobal(checker, program, node)) {
        if (node.text === "globalThis") {
          uses.push({
            file: local,
            line: lineOf(file, node.getStart(file)),
            name: "globalThis",
            reason: "It reaches any global by a name the check cannot follow; use the global by its own name.",
          });
        } else if (environment === "manifest") {
          const name =
            node.text === "Math" && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === "random"
              ? "Math.random"
              : node.text;
          const reason = DIFFERS_IN_THE_VM[name];
          if (reason) uses.push({ file: local, line: lineOf(file, node.getStart(file)), name, reason });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return uses;
}
