import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupWorkflowVitestIsolation,
  type WorkflowVitestIsolation,
} from "./workflow-vitest-isolation.js";

const execFileAsync = promisify(execFile);
const workerRoot = join(import.meta.dirname, "../..");
const artifactRoot = join(workerRoot, ".workflow-vitest");
const helperUrl = pathToFileURL(
  join(import.meta.dirname, "workflow-vitest-isolation.ts"),
).href;

const allocated: WorkflowVitestIsolation[] = [];

afterEach(async () => {
  await Promise.all(
    allocated.splice(0).map((isolation) =>
      cleanupWorkflowVitestIsolation(isolation).catch(() => undefined),
    ),
  );
});

describe("workflow Vitest isolation", () => {
  it("keeps concurrent invocations with the same pool tag fully isolated", async () => {
    const [first, second] = await Promise.all([
      allocateInChild("run-control"),
      allocateInChild("run-control"),
    ]);
    allocated.push(first.isolation, second.isolation);

    expect(first.poolId).toBe("1");
    expect(second.poolId).toBe("1");
    expect(first.isolation.invocationRoot).not.toBe(
      second.isolation.invocationRoot,
    );
    expect(first.isolation.dataDir).not.toBe(second.isolation.dataDir);
    expect(first.isolation.outDir).not.toBe(second.isolation.outDir);

    for (const { invocationRoot, dataDir, outDir } of [
      first.isolation,
      second.isolation,
    ]) {
      expect(dirname(invocationRoot)).toBe(artifactRoot);
      expect(basename(invocationRoot)).toMatch(/^run-control-[A-Za-z0-9]{6}$/);
      expect(dirname(dataDir)).toBe(invocationRoot);
      expect(dirname(outDir)).toBe(invocationRoot);
    }

    const secondDataMarker = join(second.isolation.dataDir, "survives.txt");
    const secondBundleMarker = join(second.isolation.outDir, "survives.txt");
    await Promise.all([
      writeFile(join(first.isolation.dataDir, "owned.txt"), "first"),
      writeFile(secondDataMarker, "second"),
      writeFile(secondBundleMarker, "second"),
    ]);

    await cleanupWorkflowVitestIsolation(first.isolation);
    allocated.shift();

    await expect(stat(first.isolation.invocationRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(secondDataMarker)).resolves.toMatchObject({
      size: 6,
    });
    await expect(stat(secondBundleMarker)).resolves.toMatchObject({
      size: 6,
    });
    expect((await stat(workerRoot)).isDirectory()).toBe(true);
  });

  it("refuses cleanup outside the exact owned suite leaf", async () => {
    const { isolation } = await allocateInChild("divergence");
    allocated.push(isolation);

    const outsideRoot = await mkdtemp(join(artifactRoot, "outside-"));

    try {
      await expect(
        cleanupWorkflowVitestIsolation({
          ...isolation,
          invocationRoot: outsideRoot,
          dataDir: join(outsideRoot, "data"),
          outDir: join(outsideRoot, "bundles"),
        }),
      ).rejects.toThrow(/refusing workflow Vitest cleanup/i);
      expect((await stat(outsideRoot)).isDirectory()).toBe(true);
      expect((await stat(workerRoot)).isDirectory()).toBe(true);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "vitest.run-control-workflow.config.ts",
    "vitest.workflow-divergence.config.ts",
  ])("preserves the Workflow SDK setup when loading %s", async (config) => {
    const result = await inspectConfigInChild(config);

    expect(result.poolId).toBe("1");
    expect(result.unchanged).toBe(true);
    expect(result.globalSetup).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/@workflow\/vitest\/dist\/global-setup\.js$/),
        join(
          workerRoot,
          "src/test-support/workflow-vitest-isolation-global-setup.ts",
        ),
      ]),
    );
    expect(result.cleaned).toBe(true);
  });
});

async function allocateInChild(suite: string): Promise<{
  isolation: WorkflowVitestIsolation;
  poolId: string | undefined;
}> {
  const script = [
    `import { createWorkflowVitestIsolation } from ${JSON.stringify(helperUrl)};`,
    `const before = process.env.VITEST_POOL_ID;`,
    `const isolation = createWorkflowVitestIsolation(${JSON.stringify(suite)});`,
    `console.log(JSON.stringify({ isolation, poolId: process.env.VITEST_POOL_ID, unchanged: process.env.VITEST_POOL_ID === before }));`,
  ].join("\n");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: workerRoot,
      env: { ...process.env, VITEST_POOL_ID: "1" },
    },
  );
  const result = JSON.parse(stdout.trim()) as {
    isolation: WorkflowVitestIsolation;
    poolId: string | undefined;
    unchanged: boolean;
  };
  expect(result.unchanged).toBe(true);
  return result;
}

async function inspectConfigInChild(config: string): Promise<{
  globalSetup: string[];
  poolId: string | undefined;
  unchanged: boolean;
  cleaned: boolean;
}> {
  const script = [
    `import { access } from "node:fs/promises";`,
    `import { resolveConfig } from "vitest/node";`,
    `import { pathToFileURL } from "node:url";`,
    `import { cleanupWorkflowVitestIsolation, readWorkflowVitestIsolationFromEnvironment, workflowVitestIsolationGlobalSetup } from ${JSON.stringify(helperUrl)};`,
    `const before = process.env.VITEST_POOL_ID;`,
    `let isolation;`,
    `try {`,
    `  const { vitestConfig } = await resolveConfig({ root: ${JSON.stringify(workerRoot)}, config: ${JSON.stringify(config)} });`,
    `  isolation = readWorkflowVitestIsolationFromEnvironment();`,
    `  const { setup } = await import(pathToFileURL(workflowVitestIsolationGlobalSetup).href);`,
    `  await setup()();`,
    `  const cleaned = await access(isolation.invocationRoot).then(() => false, () => true);`,
    `  console.log(JSON.stringify({ globalSetup: vitestConfig.globalSetup, poolId: process.env.VITEST_POOL_ID, unchanged: process.env.VITEST_POOL_ID === before, cleaned }));`,
    `} catch (error) {`,
    `  if (isolation) await cleanupWorkflowVitestIsolation(isolation).catch(() => undefined);`,
    `  throw error;`,
    `}`,
  ].join("\n");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: workerRoot,
      env: { ...process.env, VITEST_POOL_ID: "1" },
    },
  );
  return JSON.parse(stdout.trim()) as {
    globalSetup: string[];
    poolId: string | undefined;
    unchanged: boolean;
    cleaned: boolean;
  };
}
