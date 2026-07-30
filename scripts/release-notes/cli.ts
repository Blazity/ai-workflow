import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { collectRelease } from "./collect.js";
import { generateReleaseDraft } from "./generate.js";
import { parseVersion } from "./classify.js";
import { renderReleaseNotes } from "./render.js";
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

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? "") : fallback;
}

async function newestTag(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["tag", "--list", "artur-v*", "--sort=-v:refname"]);
  const tag = stdout.trim().split("\n")[0];
  if (!tag) throw new Error("No Artur release tag exists; pass --previous-ref for the first release");
  return tag;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "prepare") throw new Error("Usage: pnpm release-notes prepare [options]");
  const previousRef = arg("previous-ref") || (await newestTag());
  const result = await prepareRelease({
    version: arg("version"),
    previousRef,
    targetRef: arg("target-ref", "main"),
    repository: arg("repository", process.env.GITHUB_REPOSITORY ?? ""),
    output: path.resolve(arg("output", ".")),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
