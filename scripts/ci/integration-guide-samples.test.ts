import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Every TypeScript sample in the integration guide compiles against the SDK
 * this commit ships, and the samples that make up an integration pass
 * conformance.
 *
 * The guide restates the SDK's shapes in code a reader copies, which is a
 * second copy of the contract (ADR-008). A sample that stopped compiling after
 * an SDK change would teach the next author to distrust every page after it,
 * so the copy is bound here rather than trusted.
 *
 * A sample is a fenced block whose info string is `ts file=<name>` or
 * `tsx file=<name>`. Blocks naming the same file are joined in order, so the
 * guide may split one file across its prose. They are written under the
 * template's `node_modules`, which git ignores and where the SDK, the host UI
 * package, React and the Node types already resolve.
 */
const root = process.cwd();
const guidePath = join(root, "docs/architecture/integrations.md");
const templateDirectory = join(root, "integrations/_template");
const templateRequire = createRequire(join(templateDirectory, "package.json"));

interface Sample {
  readonly language: string;
  readonly file: string | null;
  readonly code: string;
  readonly line: number;
}

function samples(markdown: string): Sample[] {
  const found: Sample[] = [];
  const fence = /^```([A-Za-z]+)([^\n]*)\n([\s\S]*?)^```[ \t]*$/gmu;
  for (const match of markdown.matchAll(fence)) {
    const [, language = "", info = "", code = ""] = match;
    const file = /\bfile=(\S+)/u.exec(info)?.[1] ?? null;
    const line = markdown.slice(0, match.index).split("\n").length;
    found.push({ language, file, code, line });
  }
  return found;
}

const all = samples(readFileSync(guidePath, "utf8"));
const typescript = all.filter((sample) => sample.language === "ts" || sample.language === "tsx");

test("every TypeScript sample in the guide names the file it belongs to", () => {
  assert.ok(typescript.length > 0, "the guide holds no TypeScript sample, so this suite proves nothing");
  const untagged = typescript.filter((sample) => sample.file === null).map((sample) => sample.line);
  assert.deepEqual(
    untagged,
    [],
    "a ts or tsx block without file=<name> escapes the compile below; tag it, or make it prose",
  );
});

test("the guide's samples compile, and the ones that form an integration pass conformance", async (t) => {
  const directory = await mkdtemp(join(templateDirectory, "node_modules/.guide-samples-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const files = new Map<string, string>();
  for (const sample of typescript) {
    if (sample.file === null) continue;
    files.set(sample.file, `${files.get(sample.file) ?? ""}${sample.code}`);
  }
  for (const [file, code] of files) await writeFile(join(directory, file), code);
  await writeFile(
    join(directory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "esnext"],
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          isolatedModules: true,
          types: ["node"],
        },
        files: [...files.keys()],
      },
      null,
      2,
    )}\n`,
  );

  const tsc = spawnSync(
    process.execPath,
    [templateRequire.resolve("typescript/bin/tsc"), "-p", join(directory, "tsconfig.json")],
    { encoding: "utf8" },
  );
  assert.equal(
    tsc.status,
    0,
    `a sample in docs/architecture/integrations.md does not compile:\n${tsc.stdout}${tsc.stderr}`,
  );

  if (files.has("manifest.ts") && files.has("worker.ts")) {
    const sdk = (await import(
      pathToFileURL(templateRequire.resolve("@integrations/sdk")).href
    )) as { checkIntegrationConformance: (manifest: unknown, runtime: unknown) => unknown[] };
    const { manifest } = (await import(pathToFileURL(join(directory, "manifest.ts")).href)) as {
      manifest: unknown;
    };
    const { runtime } = (await import(pathToFileURL(join(directory, "worker.ts")).href)) as {
      runtime: unknown;
    };
    assert.deepEqual(sdk.checkIntegrationConformance(manifest, runtime), []);
  }

  // Compiling a test proves it type-checks, not that what it teaches is true:
  // every test the guide shows has to pass against the guide's own code.
  const sampleTests = [...files.keys()].filter((file) => file.endsWith(".test.ts"));
  assert.ok(sampleTests.includes("memory.test.ts"), "the guide's memory adapter test is gone");
  // The webhook test's fixture is a delivery the provider signed, which a
  // fictional provider cannot hand over, so it is signed here the way the
  // guide says the provider signs: HMAC-SHA256 over `<timestamp>.<raw body>`,
  // sent as the hex digest.
  if (files.has("webhook.test.ts")) {
    const secret = "guide-sample-secret";
    const timestamp = "1758000000";
    const rawBody = JSON.stringify({ event: "memory.updated", project: "p_1" });
    const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    await mkdir(join(directory, "test-fixtures"), { recursive: true });
    await writeFile(
      join(directory, "test-fixtures/signed-delivery.json"),
      `${JSON.stringify({ secret, timestamp, signature, rawBody }, null, 2)}\n`,
    );
  }
  // Without this suite's own runner context, which would take the child's
  // report instead of letting it print one.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-reporter=spec",
      ...sampleTests.map((file) => join(directory, file)),
    ],
    { cwd: root, encoding: "utf8", env },
  );
  assert.equal(
    run.status,
    0,
    `a test the guide shows fails against the guide's own code (${sampleTests.join(", ")}):\n${run.stdout}${run.stderr}`,
  );
  assert.match(run.stdout, /^ℹ pass [1-9]/mu, "the guide's tests ran no test");
  assert.match(run.stdout, /^ℹ fail 0$/mu);
});
