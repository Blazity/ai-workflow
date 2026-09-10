import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  compareCodePoints,
  generateBlockCatalog,
  readManifests,
  renderGeneratedFiles,
} from "../gates/generate-block-catalog.js";

const execFileAsync = promisify(execFile);
const generatorPath = join(
  process.cwd(),
  "scripts/gates/generate-block-catalog.ts",
);

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), ".generate-block-catalog-"));
  await mkdir(join(root, "apps/worker/src/engine/blocks/alpha"), { recursive: true });
  await mkdir(join(root, "apps/worker/src/engine/blocks/beta"), { recursive: true });
  await mkdir(join(root, "apps/worker/src/engine/blocks/gamma"), { recursive: true });
  await writeFile(
    join(root, "apps/worker/src/engine/blocks/alpha/manifest.ts"),
    `import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({ value: z.string() }).strict();

export const manifest = {
  type: "alpha",
  paramsSchema,
  contract: { category: "action", ports: ["out"], allowsFailurePort: true },
  ui: { group: "utility", label: "Alpha", description: "Alpha block", glyph: "A", color: "#64748B", softColor: "#EEF1F5" },
  defaults: { value: "default" },
  inputs: { value: { kind: "text", required: true } },
  additionalInputs: [],
  execution: "map",
} satisfies BlockManifest;
`,
  );
  await writeFile(
    join(root, "apps/worker/src/engine/blocks/alpha/execute.ts"),
    "export const execute = async () => ({ kind: \"next\" });\n",
  );
  await writeFile(
    join(root, "apps/worker/src/engine/blocks/beta/manifest.ts"),
    `import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();

export const manifest = {
  type: "beta",
  paramsSchema,
  contract: { category: "control", ports: ["true", "false"], allowsFailurePort: false },
  ui: { group: "control", label: "Beta", description: "Beta block", glyph: "B", color: "#35823f", softColor: "#E9F3EA" },
  defaults: {},
  inputs: {},
  execution: "inline",
} satisfies BlockManifest;
`,
  );
  await writeFile(
    join(root, "apps/worker/src/engine/blocks/beta/execute.ts"),
    "export const execute = async () => ({ kind: \"next\" });\n",
  );
  await writeFile(
    join(root, "apps/worker/src/engine/blocks/gamma/manifest.ts"),
    `import { z } from "zod";
import type { BlockManifest } from "@shared/contracts";

const paramsSchema = z.object({}).strict();

export const manifest = {
  type: "gamma",
  paramsSchema,
  contract: { category: "trigger", ports: ["out"], allowsFailurePort: false },
  ui: { group: "trigger", label: "Gamma", description: "Gamma block", glyph: "G", color: "#D14343", softColor: "#FBECEC" },
  defaults: {},
  inputs: {},
  execution: "graph",
} satisfies BlockManifest;
`,
  );
  return root;
}

test("renders the three generated files from sorted fixture manifests", async () => {
  const root = await fixtureRoot();
  try {
    const generated = renderGeneratedFiles({ root });
    assert.deepEqual(
      readManifests({ root }).map((record) => record.type),
      ["alpha", "beta", "gamma"],
    );

    assert.match(generated.catalog, /export type BlockExecutionKind = "map" \| "inline" \| "graph";/u);
    assert.match(generated.catalog, /export const BLOCK_CATALOG:/u);
    assert.match(generated.catalog, /"color":"#64748B","softColor":"#EEF1F5"/u);
    assert.match(generated.catalog, /defaults: \{\n      "value": "default"\n    \},/u);
    assert.match(generated.catalog, /execution: "graph",/u);
    assert.match(generated.catalog, /export const GENERATED_TRIGGER_BLOCK_TYPES:[\s\S]*"gamma",/u);
    assert.equal(generated.catalog.includes("BLOCK_UI_HINTS"), false);
    assert.ok(generated.catalog.indexOf("alpha: {") < generated.catalog.indexOf("beta: {"));
    assert.ok(generated.catalog.indexOf("beta: {") < generated.catalog.indexOf("gamma: {"));
    assert.match(generated.params, /alphaManifest\.paramsSchema/u);
    assert.match(generated.params, /betaManifest\.paramsSchema/u);
    assert.match(generated.params, /gammaManifest\.paramsSchema/u);
    assert.equal(
      generated.executors.includes("import { execute as alphaExecute } from \"./alpha/execute.js\";"),
      true,
    );
    assert.equal(generated.executors.includes("betaExecute"), false);
    assert.equal(generated.executors.includes("gammaExecute"), false);
    assert.match(generated.executors, /beta/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a manifest that imports a runtime module and names the file", async () => {
  const root = await fixtureRoot();
  const manifestPath = join(
    root,
    "apps/worker/src/engine/blocks/alpha/manifest.ts",
  );
  try {
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf8"))
        .replace(
          'import type { BlockManifest } from "@shared/contracts";',
          'import { execute } from "../other/execute.js";',
        ),
    );
    assert.throws(
      () => renderGeneratedFiles({ root }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("apps/worker/src/engine/blocks/alpha/manifest.ts") &&
        error.message.includes("../other/execute.js"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a manifest that requires a runtime module", async () => {
  const root = await fixtureRoot();
  const manifestPath = join(
    root,
    "apps/worker/src/engine/blocks/alpha/manifest.ts",
  );
  try {
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf8"))
        .replace(
          'import type { BlockManifest } from "@shared/contracts";',
          'const runtime = require("../workflows/agent.js");',
        ),
    );
    assert.throws(
      () => renderGeneratedFiles({ root }),
      /forbidden runtime import.*\.\.\/workflows\/agent\.js/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orders manifest types by Unicode code point, independent of locale", () => {
  assert.ok(compareCodePoints("Z", "a") < 0);
  assert.ok(compareCodePoints("a", "á") < 0);
});

test("check fails for stale output and passes after regeneration", async () => {
  const root = await fixtureRoot();
  try {
    generateBlockCatalog({ root });
    await writeFile(
      join(root, "apps/worker/src/engine/blocks/alpha/manifest.ts"),
      (await readFile(
        join(root, "apps/worker/src/engine/blocks/alpha/manifest.ts"),
        "utf8",
      )).replace('glyph: "A"', 'glyph: "Changed"'),
    );

    await assert.rejects(
      execFileAsync(process.execPath, ["--import", "tsx", generatorPath, "--root", root, "--check"]),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 1,
    );

    generateBlockCatalog({ root });
    await execFileAsync(process.execPath, ["--import", "tsx", generatorPath, "--root", root, "--check"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
