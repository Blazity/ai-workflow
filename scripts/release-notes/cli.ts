import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { collectRelease } from "./collect.js";
import { generateReleaseDraft } from "./generate.js";
import { parseVersion } from "./classify.js";
import { createReleaseManifest, validateApprovedSourceRelease } from "./manifest.js";
import { extractShareableNotes, renderReleaseNotes } from "./render.js";
import type { ReleaseCollection, ReleaseDraft } from "./types.js";

const execFileAsync = promisify(execFile);

interface PrepareOptions {
  version: string;
  previousRef: string;
  targetRef: string;
  repository: string;
  output: string;
}

interface PrepareDeps {
  collect?: typeof collectRelease;
  generate?: typeof generateReleaseDraft;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function report(collection: ReleaseCollection, draft: ReleaseDraft): string {
  const list = (heading: string, prs: ReleaseCollection["included"]) =>
    `## ${heading}\n\n${prs.map((pr) => `- #${pr.number} — ${pr.title}`).join("\n") || "- None"}\n`;
  return `# Artur release preparation

- Previous commit: \`${collection.previousCommit}\`
- Target commit: \`${collection.targetCommit}\`
- Generator: \`${draft.generatedBy}\`
- Workflow run: ${process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "local"}

${list("Customer-facing changes", collection.included)}
${list("Internal changes", collection.internal)}
${list("Skipped changes", collection.skipped)}
## Warnings

${collection.warnings.map((warning) => `- ${warning}`).join("\n") || "- None"}
`;
}

export async function prepareRelease(
  options: PrepareOptions,
  deps: PrepareDeps = {},
): Promise<{ notesPath: string; reportPath: string }> {
  const version = parseVersion(options.version);
  const notesPath = path.join(options.output, "docs", "releases", "artur", `${version}.md`);
  const reportPath = path.join(options.output, ".release-notes", `artur-${version}-report.md`);
  if (await exists(notesPath)) throw new Error(`Release file already exists: ${notesPath}`);

  const collection = await (deps.collect ?? collectRelease)({
    repository: options.repository,
    previousRef: options.previousRef,
    targetRef: options.targetRef,
  });
  const draft = await (deps.generate ?? generateReleaseDraft)(collection);
  await mkdir(path.dirname(notesPath), { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(notesPath, renderReleaseNotes(collection, draft, version));
  await writeFile(reportPath, report(collection, draft));
  return { notesPath, reportPath };
}

export async function writeShareableRelease(notesPath: string, outputPath: string): Promise<void> {
  const markdown = await readFile(notesPath, "utf8");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, extractShareableNotes(markdown));
}

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? "") : fallback;
}

function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Missing required argument: --${name}`);
  return value;
}

async function newestTag(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["tag", "--list", "artur-v*", "--sort=-v:refname"]);
  const tag = stdout.trim().split("\n")[0];
  if (!tag) throw new Error("No Artur release tag exists; pass --previous-ref for the first release");
  return tag;
}

async function prepareCommand(): Promise<unknown> {
  const version = parseVersion(requiredArg("version"));
  const { stdout: existingTag } = await execFileAsync("git", [
    "tag",
    "--list",
    `artur-v${version}`,
  ]);
  if (existingTag.trim()) throw new Error(`Tag artur-v${version} already exists`);
  const previousRef = arg("previous-ref") || (await newestTag());
  return prepareRelease({
    version,
    previousRef,
    targetRef: arg("target-ref", "main"),
    repository: arg("repository", process.env.GITHUB_REPOSITORY ?? ""),
    output: path.resolve(arg("output", ".")),
  });
}

async function validateCommand(): Promise<unknown> {
  const version = parseVersion(requiredArg("version"));
  const notesPath = path.resolve(
    arg("notes", path.join("docs", "releases", "artur", `${version}.md`)),
  );
  const outputPath = path.resolve(requiredArg("output"));
  const validation = await validateApprovedSourceRelease({
    version,
    markdown: await readFile(notesPath, "utf8"),
    mainRef: arg("main-ref", "main"),
  });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(validation, null, 2)}\n`);
  return validation;
}

async function shareableCommand(): Promise<unknown> {
  const version = parseVersion(requiredArg("version"));
  const notesPath = path.resolve(
    arg("notes", path.join("docs", "releases", "artur", `${version}.md`)),
  );
  const outputPath = path.resolve(requiredArg("output"));
  await writeShareableRelease(notesPath, outputPath);
  return { output: outputPath };
}

async function manifestCommand(): Promise<unknown> {
  const validation = JSON.parse(await readFile(path.resolve(requiredArg("validation")), "utf8")) as {
    version: string;
    candidateCommit: string;
    databaseMigrations: string[];
    releaseNotesPullRequest: number;
    releaseNotesApprovedBy: string[];
  };
  const manifest = createReleaseManifest({
    version: validation.version,
    candidateCommit: validation.candidateCommit,
    workerUrl: requiredArg("worker-url"),
    dashboardUrl: requiredArg("dashboard-url"),
    workflowVersion: requiredArg("workflow-version"),
    databaseMigrations: validation.databaseMigrations,
    testRun: requiredArg("test-run"),
    initiatedBy: requiredArg("initiated-by"),
    productionApprovedBy: requiredArg("approved-by").split(",").filter(Boolean),
    releaseNotesPullRequest: validation.releaseNotesPullRequest,
    releaseNotesApprovedBy: validation.releaseNotesApprovedBy,
    now: new Date(),
  });
  const outputPath = path.resolve(requiredArg("output"));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main(): Promise<void> {
  const commands: Record<string, () => Promise<unknown>> = {
    prepare: prepareCommand,
    validate: validateCommand,
    shareable: shareableCommand,
    manifest: manifestCommand,
  };
  const command = process.argv[2] ?? "";
  const execute = commands[command];
  if (!execute) {
    throw new Error("Usage: pnpm release-notes <prepare|validate|shareable|manifest> [options]");
  }
  process.stdout.write(`${JSON.stringify(await execute())}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
