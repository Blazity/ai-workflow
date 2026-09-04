import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isolationEnvironmentKey = "AI_WORKFLOW_VITEST_ISOLATION";
const ownerFileName = ".workflow-vitest-owner.json";
const workflowVitestWorkerRoot = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

export const workflowVitestIsolationGlobalSetup = fileURLToPath(
  new URL("./workflow-vitest-isolation-global-setup.ts", import.meta.url),
);

export interface WorkflowVitestIsolation {
  workerRoot: string;
  suite: string;
  invocationRoot: string;
  dataDir: string;
  outDir: string;
  ownerToken: string;
}

export function createWorkflowVitestIsolation(
  suite: string,
): WorkflowVitestIsolation {
  assertSuiteName(suite);

  const artifactRoot = join(workflowVitestWorkerRoot, ".workflow-vitest");
  mkdirSync(artifactRoot, { recursive: true });

  const artifactRootStat = lstatSync(artifactRoot);
  if (!artifactRootStat.isDirectory() || artifactRootStat.isSymbolicLink()) {
    throw new Error(
      `Refusing workflow Vitest allocation in unsafe artifact root: ${artifactRoot}`,
    );
  }
  if (realpathSync(artifactRoot) !== artifactRoot) {
    throw new Error(
      `Refusing workflow Vitest allocation outside the worker artifact root: ${artifactRoot}`,
    );
  }

  const invocationRoot = mkdtempSync(join(artifactRoot, `${suite}-`));
  const isolation: WorkflowVitestIsolation = {
    workerRoot: workflowVitestWorkerRoot,
    suite,
    invocationRoot,
    dataDir: join(invocationRoot, "data"),
    outDir: join(invocationRoot, "bundles"),
    ownerToken: randomUUID(),
  };

  mkdirSync(isolation.dataDir);
  mkdirSync(isolation.outDir);
  writeFileSync(
    join(invocationRoot, ownerFileName),
    JSON.stringify({ suite, ownerToken: isolation.ownerToken }),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.env[isolationEnvironmentKey] = JSON.stringify(isolation);

  return isolation;
}

export function readWorkflowVitestIsolationFromEnvironment(): WorkflowVitestIsolation {
  const serialized = process.env[isolationEnvironmentKey];
  if (!serialized) {
    throw new Error(
      `Missing ${isolationEnvironmentKey}; the workflow Vitest config did not allocate an invocation root`,
    );
  }

  try {
    return JSON.parse(serialized) as WorkflowVitestIsolation;
  } catch (error) {
    throw new Error(`Invalid ${isolationEnvironmentKey}`, { cause: error });
  }
}

export async function cleanupWorkflowVitestIsolation(
  isolation: WorkflowVitestIsolation,
): Promise<void> {
  assertOwnedSuiteLeaf(isolation);

  let invocationStat;
  try {
    invocationStat = await lstat(isolation.invocationRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }

  if (!invocationStat.isDirectory() || invocationStat.isSymbolicLink()) {
    refuseCleanup("the invocation root is not a real directory");
  }

  const artifactRoot = join(workflowVitestWorkerRoot, ".workflow-vitest");
  const artifactRootStat = await lstat(artifactRoot);
  if (!artifactRootStat.isDirectory() || artifactRootStat.isSymbolicLink()) {
    refuseCleanup("the artifact root is not a real directory");
  }
  if (
    (await realpath(artifactRoot)) !== artifactRoot ||
    (await realpath(isolation.invocationRoot)) !== isolation.invocationRoot
  ) {
    refuseCleanup("the invocation root resolves outside the worker artifact root");
  }

  const ownerPath = join(isolation.invocationRoot, ownerFileName);
  const ownerStat = await lstat(ownerPath).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      refuseCleanup("the ownership marker is missing");
    }
    throw error;
  });
  if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
    refuseCleanup("the ownership marker is not a real file");
  }

  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    throw new Error(
      "Refusing workflow Vitest cleanup: invalid ownership marker",
      { cause: error },
    );
  }
  if (
    !isRecord(owner) ||
    owner.suite !== isolation.suite ||
    owner.ownerToken !== isolation.ownerToken
  ) {
    refuseCleanup("the ownership marker does not match this invocation");
  }

  await rm(isolation.invocationRoot, { recursive: true });
}

function assertOwnedSuiteLeaf(isolation: WorkflowVitestIsolation): void {
  if (!isRecord(isolation)) refuseCleanup("invalid isolation metadata");
  const { workerRoot, suite, invocationRoot, dataDir, outDir, ownerToken } =
    isolation;
  if (
    typeof workerRoot !== "string" ||
    typeof suite !== "string" ||
    typeof invocationRoot !== "string" ||
    typeof dataDir !== "string" ||
    typeof outDir !== "string" ||
    typeof ownerToken !== "string"
  ) {
    refuseCleanup("invalid isolation metadata");
  }

  assertSuiteName(suite, refuseCleanup);
  if (workerRoot !== workflowVitestWorkerRoot) {
    refuseCleanup("the worker root does not match this helper");
  }

  const artifactRoot = join(workerRoot, ".workflow-vitest");
  const leafName = basename(invocationRoot);
  const suffix = leafName.slice(`${suite}-`.length);
  if (
    invocationRoot !== resolve(invocationRoot) ||
    dirname(invocationRoot) !== artifactRoot ||
    !leafName.startsWith(`${suite}-`) ||
    !/^[A-Za-z0-9]{6}$/.test(suffix)
  ) {
    refuseCleanup("the invocation root is outside the exact owned suite leaf");
  }
  if (
    dataDir !== join(invocationRoot, "data") ||
    outDir !== join(invocationRoot, "bundles")
  ) {
    refuseCleanup("data or bundle directories are outside the invocation root");
  }
}

function assertSuiteName(
  suite: string,
  fail: (reason: string) => never = (reason) => {
    throw new Error(`Invalid workflow Vitest suite name: ${reason}`);
  },
): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suite)) fail(suite);
}

function refuseCleanup(reason: string): never {
  throw new Error(`Refusing workflow Vitest cleanup: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
