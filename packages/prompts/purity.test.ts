import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * The package description promises code that never reaches an application, the
 * database, the environment, the filesystem or the network. Only the tests may
 * use Node built-ins, so every production module here imports either a sibling
 * module or @shared/contracts, and nothing else.
 */
const packageDirectory = import.meta.dirname;
const ALLOWED_PACKAGES = new Set(["@shared/contracts"]);
/** Static `from "x"` / `import "x"` and dynamic `import("x")`, either quote:
 *  a single-quoted dynamic import is the cheapest way around a guard that
 *  only knows the double-quoted static form. */
const IMPORT_SPECIFIER = /\b(?:from|import)\b\s*\(?\s*["']([^"']+)["']/gu;
const FORBIDDEN_RUNTIME =
  /\bprocess\.|\brequire\s*\(|\bcreateRequire\b|\bfetch\s*\(/u;

function productionModules(): string[] {
  return readdirSync(packageDirectory)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

describe("package purity", () => {
  it("imports only sibling modules and @shared/contracts", () => {
    const offenders: string[] = [];
    for (const name of productionModules()) {
      const source = readFileSync(join(packageDirectory, name), "utf8");
      for (const match of source.matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1];
        if (specifier.startsWith("./") || ALLOWED_PACKAGES.has(specifier)) continue;
        offenders.push(`${name}: ${specifier}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("touches no runtime host: no process, require, createRequire, or fetch", () => {
    const offenders = productionModules().filter((name) =>
      FORBIDDEN_RUNTIME.test(readFileSync(join(packageDirectory, name), "utf8")),
    );
    assert.deepEqual(offenders, []);
  });
});
