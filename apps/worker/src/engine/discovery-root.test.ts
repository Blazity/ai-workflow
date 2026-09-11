import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import nitroConfig from "../../nitro.config.js";

/**
 * Two scanners look at this package and neither reports a miss.
 *
 * Nitro discovers routes, middleware and plugins by walking `srcDir`, and the
 * Workflow DevKit discovers steps and workflows by content-testing the files
 * under the same root. A file that moves out of that root is not an error at
 * build time in either scanner: the route simply stops being mounted, and a
 * `"use step"` module simply stops being registered, which surfaces as a 404 or
 * as "is not registered in the current deployment" on the first run that needs
 * it, in production.
 *
 * So the root is read from the Nitro configuration here rather than written down
 * a second time. A test that hardcoded "src" would keep passing precisely in the
 * case it exists to catch: someone changing `srcDir` and leaving the scanned
 * trees where they were.
 */
const workerRoot = join(import.meta.dirname, "../../");
const srcDir = nitroConfig.srcDir;

/** The trees Nitro mounts by convention, relative to `srcDir`. */
const NITRO_SCANNED_TREES = ["routes", "middleware", "plugins"] as const;

/** A directive on its own line, matched the way the builder's detector does. */
const DIRECTIVE_PATTERNS = [
  /^[ \t]*(['"])use step\1;?[ \t]*$/mu,
  /^[ \t]*(['"])use workflow\1;?[ \t]*$/mu,
];

describe("discovery root", () => {
  it("declares the source root both scanners depend on", () => {
    // Nitro defaults `srcDir` when it is absent, and the default is not this
    // package's layout, so an absent value is a real failure and not a shrug.
    expect(typeof srcDir).toBe("string");
    expect(srcDir).not.toBe("");
  });

  it("keeps every tree Nitro mounts inside the configured source root", () => {
    for (const tree of NITRO_SCANNED_TREES) {
      const entries = readdirSync(join(workerRoot, srcDir!, tree), {
        withFileTypes: true,
      });
      expect(entries.length).toBeGreaterThan(0);
    }
  });

  it("keeps every workflow directive inside the configured source root", () => {
    const scanned = new Set(
      typescriptFiles(join(workerRoot, srcDir!)).map((path) => relative(workerRoot, path)),
    );
    const stranded = typescriptFiles(workerRoot)
      .filter((path) => !path.includes(`${join(workerRoot, "node_modules")}`))
      .filter((path) => DIRECTIVE_PATTERNS.some((pattern) => pattern.test(readFileSync(path, "utf8"))))
      .map((path) => relative(workerRoot, path))
      .filter((path) => !scanned.has(path))
      // The fixture tree is scanned by the builder through its own entry and is
      // not part of the deployed source root.
      .filter((path) => !path.startsWith("workflow-test-fixtures/"));

    expect(stranded).toEqual([]);
  });
});

function typescriptFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".nitro" || entry.name === ".output") {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.[cm]?tsx?$/u.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}
