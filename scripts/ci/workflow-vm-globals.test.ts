import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  ENVIRONMENT_LIBS,
  REFUSED_IN_THE_VM,
  WORKFLOW_VM_GLOBALS,
} from "../gates/generate-integration-registry/graph-globals.js";

/**
 * The generator lets a manifest use the language plus `WORKFLOW_VM_GLOBALS`,
 * because that is what the Workflow DevKit's VM gives the flow bundle. This
 * test holds that list to the DevKit the worker actually pins: it runs its
 * `createContext`, reads what its workflow runtime adds on top, and fails when
 * a DevKit upgrade adds a global (the generator would refuse a manifest the VM
 * now runs) or takes one away (the generator would pass a manifest the VM now
 * breaks). The comparison is against a bare `vm` context on the same Node, so
 * the language builtins a newer V8 ships cancel out and only the DevKit's own
 * additions remain.
 */
const workflowPackage = realpathSync(join(process.cwd(), "apps/worker/node_modules/workflow"));
const coreEntry = createRequire(join(workflowPackage, "package.json")).resolve("@workflow/core");
const coreDist = dirname(coreEntry);
const coreVersion = (JSON.parse(readFileSync(join(coreDist, "../package.json"), "utf8")) as { version: string }).version;

async function devKitGlobals(): Promise<string[]> {
  const { createContext } = (await import(join(coreDist, "vm/index.js"))) as {
    createContext: (options: { seed: string; fixedTimestamp: number }) => { globalThis: object };
  };
  const bare = new Set(Object.getOwnPropertyNames(vm.runInContext("globalThis", vm.createContext())));
  const added = Object.getOwnPropertyNames(createContext({ seed: "seed", fixedTimestamp: 0 }).globalThis).filter(
    (name) => !bare.has(name),
  );
  // The workflow runtime assigns the rest when it starts a run, which needs a
  // whole world to call, so its source is read instead.
  const runtime = readFileSync(join(coreDist, "workflow.js"), "utf8");
  const assigned = [...runtime.matchAll(/vmGlobalThis\.([A-Za-z_$][\w$]*)\s*=(?!=)/gu)].map((match) => match[1]!);
  assert.ok(assigned.includes("fetch"), `dist/workflow.js of @workflow/core ${coreVersion} no longer reads as the runtime that stubs fetch`);
  return [...new Set([...added, ...assigned])].sort();
}

test("the globals a manifest may use are exactly what the pinned DevKit's VM gives it", async () => {
  const expected = [...WORKFLOW_VM_GLOBALS, ...Object.keys(REFUSED_IN_THE_VM)].sort();
  assert.deepEqual(
    await devKitGlobals(),
    expected,
    `@workflow/core ${coreVersion} puts a different set of globals on its VM than graph-globals.ts describes. ` +
      "Add a name it now provides to WORKFLOW_VM_GLOBALS (or to REFUSED_IN_THE_VM with the reason a manifest may not use it), " +
      "and delete a name it no longer provides.",
  );
});

test("every global the language declares for a manifest exists in a bare VM context", () => {
  // The other half of the environment is the library the compiler reads. A
  // library newer than the VM's V8 would declare a builtin the VM lacks.
  const probe = "/probe.ts";
  const options: ts.CompilerOptions = { lib: [...ENVIRONMENT_LIBS.manifest], types: [], noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, version, onError, create) =>
    fileName === probe ? ts.createSourceFile(probe, "export {};", version, true) : read(fileName, version, onError, create);
  const program = ts.createProgram({ rootNames: [probe], options, host });
  const declared = program
    .getTypeChecker()
    .getSymbolsInScope(program.getSourceFile(probe)!, ts.SymbolFlags.Value)
    .map((symbol) => symbol.name);
  assert.ok(declared.includes("Promise") && declared.includes("Map"), "the library program declared no builtins");
  const bare = new Set(Object.getOwnPropertyNames(vm.runInContext("globalThis", vm.createContext())));
  assert.deepEqual(declared.filter((name) => !bare.has(name)), []);
});
